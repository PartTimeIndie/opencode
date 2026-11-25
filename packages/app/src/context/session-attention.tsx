import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { useServerSDK } from "./server-sdk"
import { useSessionRoute } from "./session-route"
import { useSettings } from "./settings"
import { useLanguage } from "./language"
import { loadPendingQuestions } from "./question-request"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Persist, persisted } from "@/utils/persist"
import { attentionKey, sameAttentionTarget } from "@/session-attention/identity"
import { directoryKey } from "@/utils/path-key"
import { refreshAttention } from "@/session-attention/refresh"
import { recoverableAttention, recoverAttention } from "@/session-attention/recovery"
import { decode64 } from "@/utils/base64"
import { applyResult, markSeen, isAttentionSnapshot, type AttentionEntry } from "@/session-attention/state"
import { pendingAttentionQuestion } from "@/session-attention/question"

export type AttentionTarget = { directory: string; sessionID: string }

export const { use: useSessionAttention, provider: SessionAttentionProvider } = createSimpleContext({
  name: "SessionAttention",
  gate: false,
  init: () => {
    const server = useServer()
    const sdk = useServerSDK()
    const route = useSessionRoute()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()
    const broker = platform.sessionAttention
    // Browser storage is a single-window fallback. Desktop writes are serialized in main,
    // not through the asynchronous whole-map persisted-store writer.
    const local = createStore({ entries: {} as Record<string, AttentionEntry> })
    const legacy = broker ? undefined : persisted(Persist.global("session-attention"), createStore({ entries: {} as Record<string, AttentionEntry> }))
    const store = legacy?.[0] ?? local[0]
    const setStore = legacy?.[1] ?? local[1]
    const [loaded, setLoaded] = createSignal(false)
    const [focusRevision, setFocusRevision] = createSignal(0)
    const ready = legacy?.[3] ?? loaded
    const [registry, setRegistry] = createStore({ owners: {} as Record<string, boolean> })
    const [questions, setQuestions] = createStore({ pending: {} as Record<string, string | undefined> })
    const [revision, setRevision] = createSignal(0)
    const changed = () => setRevision((value) => value + 1)
    const enabled = createMemo(() => Object.values(registry.owners).some(Boolean))
    const key = (target: AttentionTarget) => attentionKey(server.key, target.directory, target.sessionID)
    const current = (target: AttentionTarget) => store.entries[key(target)]
    const question = (target: AttentionTarget) => questions.pending[key(target)]
    const visible = (target: AttentionTarget) => {
      focusRevision()
      return document.hasFocus() && document.visibilityState === "visible" &&
        sameAttentionTarget({ directory: decode64(route.dir) ?? "", sessionID: route.id ?? "" }, target)
    }
    const focusChanged = () => setFocusRevision((value) => value + 1)
    window.addEventListener("focus", focusChanged)
    window.addEventListener("blur", focusChanged)
    document.addEventListener("visibilitychange", focusChanged)
    onCleanup(() => {
      window.removeEventListener("focus", focusChanged)
      window.removeEventListener("blur", focusChanged)
      document.removeEventListener("visibilitychange", focusChanged)
    })
    const reportVisibility = () => {
      if (!broker) return
      const directory = decode64(route.dir)
      const target = directory && route.id ? { directory, sessionID: route.id } : undefined
      void broker.visible(target && visible(target) ? key(target) : null).catch((error) =>
        console.warn("[session-attention] visibility unavailable", error))
    }
    if (broker) {
      createEffect(() => { route.dir; route.id; reportVisibility() })
      window.addEventListener("focus", reportVisibility)
      window.addEventListener("blur", reportVisibility)
      document.addEventListener("visibilitychange", reportVisibility)
      onCleanup(() => {
        window.removeEventListener("focus", reportVisibility)
        window.removeEventListener("blur", reportVisibility)
        document.removeEventListener("visibilitychange", reportVisibility)
        void broker.visible(null).catch(() => undefined)
      })
    }
    const receive = (id: string, entry: AttentionEntry) => {
      if ((store.entries[id]?.revision ?? 0) > (entry.revision ?? 0)) return
      const newlyEnabled = !store.entries[id]?.enabled && entry.enabled
      setStore("entries", id, entry)
      changed()
      if (newlyEnabled && entry.directory) queueMicrotask(() => { if (enabled()) void refreshQuestions(entry.directory!) })
    }
    let loading = false
    const load = () => {
      if (!broker || ready() || loading) return
      loading = true
      void broker.list().then((entries) => {
        Object.entries(entries).forEach(([id, entry]) => receive(id, entry))
        setLoaded(true)
      }).catch((error) => console.warn("[session-attention] storage unavailable", error))
        .finally(() => { loading = false })
    }
    if (broker) {
      const unsubscribe = broker.subscribe(receive)
      load()
      onCleanup(unsubscribe)
    }
    const fetchState = async (target: AttentionTarget, afterSeq: number, signal?: AbortSignal) => {
      const result = await sdk().client.session.attentionState({ directory: target.directory, sessionID: target.sessionID,
        afterSeq: String(afterSeq) }, { signal })
      if (!isAttentionSnapshot(result.data)) throw new Error("Session activity summary unavailable")
      return result.data
    }
    const pending = new Map<string, { job: Promise<boolean>; live: boolean }>()
    const refresh = (target: AttentionTarget, live = false) => {
      const id = key(target)
      if (!ready() || !enabled() || !current(target)?.enabled) return Promise.resolve(false)
      const previous = pending.get(id)
      if (previous) { previous.live ||= live; return previous.job }
      const request = { live, job: Promise.resolve(false) }
      const job = (async () => {
        if (broker) return refreshAttention({
          key: id, current: () => current(target), fetch: (afterSeq) => fetchState(target, afterSeq),
          update: (command) => broker.update(command), receive: (entry) => receive(id, entry),
          enabled, visible: () => visible(target), live: () => request.live,
        })
        for (let attempt = 0; attempt < 2; attempt++) {
          const start = current(target)
          if (!start?.enabled || !enabled()) return false
          const snapshot = await fetchState(target, start.cursor)
          if (!enabled()) return false
          const prior = current(target)
          if (snapshot.archived) {
            if (prior?.enabled && !prior.archived) { setStore("entries", id, { ...prior, archived: true, count: 0, error: false }); changed() }
            return false
          }
          if (!prior?.enabled || prior.cursor !== start.cursor) continue
          const next = applyResult(prior, snapshot)
          if (next === prior) return false
          setStore("entries", id, visible(target) ? markSeen(next, next.cursor) : next)
          changed()
          if (!request.live || snapshot.count === 0 || visible(target)) return false
          setStore("entries", id, "notified", snapshot.cursor)
          return true
        }
        return false
      })().catch((error) => {
        console.warn("[session-attention] activity summary unavailable", error)
        return false
      }).finally(() => { if (pending.get(id) === request) pending.delete(id) })
      request.job = job
      pending.set(id, request)
      return job
    }
    const set = async (target: AttentionTarget, value: boolean) => {
      if (!enabled() || !ready() || !target.directory || !target.sessionID) return false
      const id = key(target)
      try {
        if (!value) {
          if (broker) {
            const result = await broker.update({ type: "disable", key: id })
            if (result.entry) receive(id, result.entry)
          } else {
            const entry = current(target)
            if (entry) { setStore("entries", id, { ...entry, enabled: false, count: 0, error: false }); changed() }
          }
          setQuestions("pending", id, undefined)
          return true
        }
        if (current(target)?.enabled) return true
        const snapshot = await fetchState(target, 0)
        if (snapshot.archived) return false
        if (broker) {
          const result = await broker.update({ type: "enable", key: id, directory: target.directory, snapshot })
          if (result.entry) receive(id, result.entry)
          if (result.entry?.enabled) void refreshQuestions(target.directory)
          return result.entry?.enabled ?? false
        }
        setStore("entries", id, { enabled: true, cursor: snapshot.cursor, seen: snapshot.cursor, count: 0,
          error: false, title: snapshot.title, directory: target.directory } as AttentionEntry)
        changed()
        void refreshQuestions(target.directory)
        return true
      } catch (error) {
        console.warn("[session-attention] could not change priority", error)
        return false
      }
    }
    const acknowledge = (target: AttentionTarget, cursor = current(target)?.cursor) => {
      const entry = current(target)
      if (!entry || cursor === undefined) return
      if (broker) {
        void broker.update({ type: "ack", key: key(target), cursor }).then((result) => {
          if (result.entry) receive(key(target), result.entry)
        }).catch((error) => console.warn("[session-attention] acknowledgement unavailable", error))
        return
      }
      const next = markSeen(entry, cursor)
      if (next === entry) return
      setStore("entries", key(target), next)
      changed()
    }
    const register = (owner: string) => {
      setRegistry("owners", owner, true)
      return () => setRegistry("owners", owner, false)
    }
    const questionJobs = new Map<string, { revision: number; live: Set<string>; job: Promise<void> }>()
    const browserClaims = new Set<string>()
    let disposed = false
    onCleanup(() => { disposed = true })
    const refreshQuestions = (directory: string, liveID?: string) => {
      if (disposed || !enabled() || !directory) return Promise.resolve()
      const dirKey = directoryKey(directory)
      const previous = questionJobs.get(dirKey)
      if (previous) {
        previous.revision++
        if (liveID) previous.live.add(liveID)
        return previous.job
      }
      const state = { revision: 0, live: new Set(liveID ? [liveID] : []), job: Promise.resolve() }
      const job = (async () => {
        for (;;) {
          const revision = state.revision
          const snapshot = await loadPendingQuestions(sdk().createClient({ directory, throwOnError: true }), directory)
          if (disposed || !enabled()) return
          if (revision !== state.revision) continue
          const targets = recoverableAttention(store.entries, server.key).filter((target) =>
            sameAttentionTarget(target, { directory, sessionID: target.sessionID }))
          for (const target of targets) {
            const id = pendingAttentionQuestion(snapshot.pending, target.sessionID)
            setQuestions("pending", key(target), id)
            if (!id || !state.live.has(id) || visible(target) || !settings.notifications.agent() || revision !== state.revision) continue
            const entry = current(target)
            if (!entry?.enabled) continue
            if (broker) {
              const claim = await broker.update({ type: "claim-question", key: key(target), requestID: id })
              if (claim.entry) receive(key(target), claim.entry)
              if (!claim.notify) continue
            } else {
              if (browserClaims.has(`${key(target)}\n${id}`)) continue
            }
            if (disposed || !enabled() || !current(target)?.enabled || visible(target)) continue
            if (revision !== state.revision) {
              const currentQuestions = await loadPendingQuestions(sdk().createClient({ directory, throwOnError: true }), directory)
              if (pendingAttentionQuestion(currentQuestions.pending, target.sessionID) !== id) continue
            }
            if (broker) {
              if (await broker.isVisible(key(target)).catch(() => true)) continue
              if (disposed || !enabled() || !current(target)?.enabled || visible(target)) continue
            } else {
              browserClaims.add(`${key(target)}\n${id}`)
              if (browserClaims.size > 256) browserClaims.delete(browserClaims.values().next().value!)
            }
            void platform.notify(language.t("session.attention.toast.question"), entry.title,
              `/${base64Encode(target.directory)}/session/${target.sessionID}`, { always: true })
          }
          if (revision === state.revision) return
        }
      })().catch((error) => console.warn("[session-attention] pending questions unavailable", error))
        .finally(() => { if (questionJobs.get(dirKey) === state) questionJobs.delete(dirKey) })
      state.job = job
      questionJobs.set(dirKey, state)
      return job
    }
    const observeQuestion = (directory: string, event: { type: string; properties?: unknown }) => {
      if (!enabled() || !["surface.asked", "surface.replied", "surface.dismissed"].includes(event.type)) return
      const props = event.properties
      if (!props || typeof props !== "object" || !("sessionID" in props) || typeof props.sessionID !== "string") return
      const target = { directory, sessionID: props.sessionID }
      if (!current(target)?.enabled) return
      const liveID = event.type === "surface.asked" && "mode" in props && props.mode === "blocking" &&
        "id" in props && typeof props.id === "string" ? props.id : undefined
      void refreshQuestions(directory, liveID)
    }
    const unsubEvent = sdk().event.listen((e) => observeQuestion(e.name, e.details))
    const unsubSync = sdk().sync.listen((e) => observeQuestion(e.name,
      { type: e.details.syncEvent.type, properties: e.details.syncEvent.data }))
    onCleanup(() => { unsubEvent(); unsubSync() })
    createEffect(() => {
      if (enabled()) return
      Object.keys(questions.pending).forEach((id) => setQuestions("pending", id, undefined))
    })
    createEffect(() => {
      if (!sdk().event.reconnect() || !ready() || !enabled()) return
      untrack(recover)
    })
    let recovering = false
    const recover = () => {
      if (!ready()) { load(); return }
      if (!enabled() || recovering) return
      recovering = true
      const targets = recoverableAttention(store.entries, server.key)
      void Promise.all([
        recoverAttention(targets, (target) => refresh(target)),
        recoverAttention([...new Set(targets.map((target) => target.directory))], refreshQuestions),
      ])
        .finally(() => { recovering = false })
    }
    createEffect(() => { if (ready() && enabled()) untrack(recover) })
    window.addEventListener("online", recover)
    const onVisible = () => { if (document.visibilityState === "visible") recover() }
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      window.removeEventListener("online", recover)
      document.removeEventListener("visibilitychange", onVisible)
    })
    createEffect(() => {
      if (!ready() || !enabled()) return
      const directory = decode64(route.dir)
      if (directory && route.id && visible({ directory, sessionID: route.id })) acknowledge({ directory, sessionID: route.id })
    })
    createEffect(() => {
      if (!enabled()) return
      const onFocus = () => {
        const directory = decode64(route.dir)
        if (directory && route.id) acknowledge({ directory, sessionID: route.id })
        recover()
      }
      window.addEventListener("focus", onFocus)
      onCleanup(() => window.removeEventListener("focus", onFocus))
    })
    return { enabled, ready, key, current, question, entries: () => store.entries, revision, register, refresh, set, acknowledge, visible }
  },
})
