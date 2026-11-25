import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createRoot } from "solid-js"
import { produce } from "solid-js/store"
import { useSearchParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { useSettings } from "@/context/settings"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSessionRoute } from "@/context/session-route"
import { acquirePromptSession } from "@/context/prompt-session"
import { isPromptEqual, type Prompt } from "@/context/prompt"
import { insertPromptDraft } from "@/context/prompt-insert"
import { mergeSessionList } from "@/context/global-sync/session-list"
import { unavailableModelChainStep } from "@/context/model-chain"
import { buildPromptOptimization } from "@/utils/prompt-optimization"
import { Identifier } from "@/utils/id"
import { Worktree } from "@/utils/worktree"
import { showToast } from "@/utils/toast"
import { awaitComposerSend, type PreparedComposerSubmission } from "@/plugin/composer-send-intent"
import { draftText, draftImages, isContextItemEqual, toV2Model, sendSlashCommand, sendFollowupDraft, waitForAccessControlSync, type PromptSubmitInput, type FollowupDraft } from "./submit"
import { preparedSendPolicy } from "./prepared-submit-policy"
import { pinAnnotation, releaseAnnotation } from "../image-annotation/storage"

/** Captures dependencies at the human click; execution never consults the active route. */
export function createPreparedSubmit(input: PromptSubmitInput) {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const server = useServer()
  const tabs = useTabs()
  const local = useLocal()
  const permission = usePermission()
  const settings = useSettings()
  const platform = usePlatform()
  const language = useLanguage()
  const params = useSessionRoute()
  const [search] = useSearchParams<{ draftId?: string }>()
  return (): PreparedComposerSubmission => {
    if (input.mode() !== "normal") throw new Error("Recording send requires normal composer mode")
    const host = sdk()
    const hostSync = serverSync()
    const serverID = server.key
    const directory = host.directory
    const sessionID = params.id
    const draftID = input.draftID?.() ?? search.draftId
    const model = local.model.current()
    const selected = local.model.selected()
    const stored = input.info()
    const selectedModel = model ? { providerID: model.provider.id, modelID: model.id }
      : selected === undefined && stored?.model ? { providerID: stored.model.providerID, modelID: stored.model.id } : undefined
    const chain = local.model.chain?.current()
    if (!selectedModel || (local.model.chain?.selected() && !chain) || (chain && unavailableModelChainStep(chain, (step) => local.model.list().find((item) => item.provider.id === step.providerID && item.id === step.modelID))))
      throw new Error("The approved model or model chain is unavailable")
    const selection = { model: selectedModel, variant: model ? local.model.variant.current() : stored?.model?.variant,
      chain: chain ? JSON.parse(JSON.stringify(chain)) as FollowupDraft["chain"] : undefined }
    const agent = local.agent.current()?.name ?? stored?.agent ?? sync().data.config.default_agent ?? "build"
    const agents = local.agent.list().map((item) => item.name)
    const settled = local.session.settled().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
    const worktree = input.newSessionWorktree?.() || "main"
    const forceSteer = !!input.forceSteer?.()
    const working = input.working()
    const shouldQueue = !!input.shouldQueue?.()
    const delivery = forceSteer ? "steer" : shouldQueue || (working && settings.general.followup() === "queue") ? "queue" : working ? "steer" : undefined
    const context = JSON.parse(JSON.stringify(input.prompt.context.items())) as FollowupDraft["context"]
    const original = JSON.parse(JSON.stringify(input.prompt.current())) as Prompt
    const imageRefs = original.flatMap((part) => part.type === "image" && part.annotation ? [part.annotation] : [])
    const imageToken = crypto.randomUUID()
    const capturedImageRefs: typeof imageRefs = []
    const imagePins = Promise.resolve().then(async () => {
      for (const ref of imageRefs) { await pinAnnotation(ref, imageToken); capturedImageRefs.push(ref) }
      return { ok: true as const }
    }).catch((error: unknown) => ({ ok: false as const, error }))
    const cursor = input.prompt.cursor() ?? draftText(original).length
    const commands = sync().data.command.map((item) => ({ ...item }))
    const optimizationSettings = {
      optimizationProfile: settings.optimizations.optimizationProfile(), toolContextCompression: settings.optimizations.toolContextCompression(),
      externalContextReduction: settings.optimizations.externalContextReduction(), sourceTestContextPack: settings.optimizations.sourceTestContextPack(),
      compactVerifierContext: settings.optimizations.compactVerifierContext(), selfTestPolicy: settings.optimizations.selfTestPolicy(),
      coreSearchLimits: settings.optimizations.coreSearchLimits(), toolMaterializationCache: settings.optimizations.toolMaterializationCache(),
      runnerRequestMetrics: settings.optimizations.runnerRequestMetrics(), sessionTabPrefetch: settings.optimizations.sessionTabPrefetch(),
    }
    const reference = acquirePromptSession(host.scope, draftID ? { draftID } : { dir: base64Encode(directory), id: sessionID }, platform)
    let submitted: Prompt | undefined
    let created: Session | undefined
    let destination = directory
    const releases: (() => void)[] = [reference.dispose]
    if (sessionID) {
      hostSync.session.retain(directory, sessionID)
      releases.push(() => hostSync.session.release(directory, sessionID))
    }
    const check = (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (server.key !== serverID) throw new Error("The approved composer server is no longer active")
    }
    return {
      prompt: original, cursor, agent, canSetAgent: (name) => agents.includes(name),
      // Keeps a blocked preparation's text in the live draft; `settle` only
      // restores the approved prompt while the draft is still unchanged.
      insertDraft: (text) => insertPromptDraft(reference.value, { text }),
      async execute(transaction) {
        const signal = transaction.signal
        check(signal)
        const persisted = await awaitComposerSend(signal, () => settled)
        if (!persisted.ok) throw persisted.error
        const pinnedImages = await awaitComposerSend(signal, () => imagePins)
        if (!pinnedImages.ok) throw pinnedImages.error
        check(signal)
        let client = host.client
        if (!sessionID) {
          if (worktree === "create") {
            const result = await awaitComposerSend(signal, () => client.worktree.create({ directory }))
            check(signal)
            if (!result.data?.directory) return { status: "blocked", error: "Could not create the selected worktree" }
            destination = result.data.directory
            Worktree.pending(host.scope, destination)
          } else if (worktree !== "main") destination = worktree
          if (destination !== directory) client = host.createClient({ directory: destination, throwOnError: true })
        }
        const destinationSync = createRoot((dispose) => {
          releases.push(dispose)
          return hostSync.createDirSyncContext(destination)
        }, null)
        const policy = preparedSendPolicy({ text: draftText(transaction.prompt), working, shouldQueue, commands })
        if (policy.error) return { status: "blocked", error: policy.error }
        submitted = policy.visibleGoal ? [{ type: "text", content: policy.visibleGoal, start: 0, end: policy.visibleGoal.length }, ...transaction.prompt.filter((part) => part.type !== "text")] : transaction.prompt
        const text = draftText(submitted)
        let id = sessionID
        if (!id) {
          check(signal)
          const result = await awaitComposerSend(signal, () => client.v2.session.create({ id: Identifier.ascending("session"), agent: transaction.agent, model: toV2Model(selection.model, selection.variant, selection.chain), location: { directory: destination } }))
          check(signal)
          id = result.data?.data.id
          if (!id) return { status: "blocked", error: "Could not create the target session" }
          const info = await awaitComposerSend(signal, () => client.session.get({ sessionID: id! }))
          check(signal)
          created = info.data
          if (!created) return { status: "blocked", error: "Created session is unavailable" }
          const [, setStore] = hostSync.child(destination)
          setStore("session", produce((items) => mergeSessionList(items, created!)))
          permission.applyAccessControlDefault(id, destination)
        }
        check(signal)
        await awaitComposerSend(signal, () => waitForAccessControlSync(permission.syncAccessControlProfile(id!, destination)))
        check(signal)
        // Queued sends dispatch immediately through the normal builder: the
        // server holds them until the running turn finishes, exactly like a
        // typed send during a busy session. Waiting here for the session to
        // go idle left dictation sends stuck on "Preparing message…" for the
        // whole current run.
        if (Worktree.get(host.scope, destination)?.status === "pending") {
          const ready = await awaitComposerSend(signal, () => Promise.race([
            Worktree.wait(host.scope, destination),
            new Promise<{ status: "failed"; message: string }>((resolve) => {
              const timer = setTimeout(() => resolve({ status: "failed", message: "Worktree preparation timed out" }), 300_000)
              releases.push(() => clearTimeout(timer))
            }),
          ]))
          check(signal)
          if (ready.status === "failed") return { status: "blocked", error: ready.message }
        }
        const optimization = policy.command ? undefined : buildPromptOptimization({ text, settings: optimizationSettings,
          contextFileCount: context.filter((item) => item.type === "file").length,
          fileAttachmentCount: submitted.filter((part) => part.type === "file").length })
        check(signal)
        if (policy.command === "goal") {
          transaction.dispatched()
          await sendSlashCommand({ client, sessionID: id, messageID: transaction.messageID, name: "goal", arguments: policy.arguments ?? "",
            agent: transaction.agent, ...selection, images: draftImages(submitted) })
        } else {
          await sendFollowupDraft({ client, sync: destinationSync, serverSync: hostSync,
            draft: { sessionID: id, sessionDirectory: destination, prompt: submitted, context, agent: transaction.agent, ...selection,
              requestText: optimization?.requestText, system: optimization?.system },
            messageID: transaction.messageID, delivery, queued: delivery === "queue", optimisticBusy: true,
            commands: working || shouldQueue ? [] : commands,
            before: () => { check(signal); return true },
            dispatch: () => { check(signal); transaction.dispatched() },
          })
        }
        tabs.markSessionUsed({ server: serverID, directory: destination, sessionID: id })
        if (policy.visibleGoal !== undefined) input.onGoal?.({ sessionID: id, sessionDirectory: destination, goal: policy.visibleGoal })
        if (forceSteer) input.onForceSteerSent?.()
        return { status: "admitted" }
      },
      settle(result, approved, prepared) {
        const state = reference.value
        if (result.status === "admitted") {
          if (isPromptEqual(state.current(), approved) || isPromptEqual(state.current(), prepared)) state.reset()
          for (const item of context) {
            const current = state.context.items().find((value) => value.key === item.key)
            if (current && isContextItemEqual(current, item)) state.context.remove(item.key)
          }
          if (created) {
            const next = acquirePromptSession(host.scope, { dir: base64Encode(destination), id: created.id }, platform)
            next.value.set(JSON.parse(JSON.stringify(state.current())), state.cursor() ?? 0)
            state.context.items().forEach((item) => next.value.context.add(item))
            next.dispose()
            const tab = { server: serverID, dirBase64: base64Encode(destination), sessionId: created.id, createdEmpty: false }
            if (draftID) tabs.promoteDraft(draftID, tab)
            else tabs.openSessionTab(tab, { activate: false })
          }
          return
        }
        if (result.status !== "cancelled" && isPromptEqual(state.current(), approved)) state.set(prepared, draftText(prepared).length)
        if (result.status !== "cancelled" && result.error) showToast({ variant: "error", title: language.t("prompt.toast.promptSendFailed.title"), description: result.error })
      },
      dispose() {
        releases.forEach((dispose) => dispose())
        void imagePins.then(() => Promise.all(capturedImageRefs.map((ref) => releaseAnnotation(ref, imageToken)))).catch(() => showToast({ title: "Local image cleanup failed", description: "Local draft data has been retained." }))
      },
    }
  }
}
