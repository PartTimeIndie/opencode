import { expect, test } from "bun:test"
import type { SessionMessage, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createDirSyncContext, isSessionMessageRequestTimeoutError } from "./directory-sync"

test(
  "concurrent metadata loads share one request and dispose aborts the real signal",
  async () => {
    const directory = "C:/repo-metadata-hung"
    const sessionID = "ses_metadata_hung"
    const [store, setStore] = createStore({
      status: "complete" as const,
      agent: [],
      command: [],
      project: "project",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider: { all: [], connected: [], default: {} },
      config: {},
      path: { directory, state: "", config: "", worktree: "", home: "" },
      session: [],
      sessionTotal: 0,
      session_status: {} as Record<string, SessionStatus>,
      session_working: () => false,
      session_diff: {},
      todo: {},
      turnCompletion: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 50,
      message: {} as Record<string, never>,
      part: {},
      part_text_accum_delta: {},
    })
    const rawUser: SessionMessage = { id: "msg_user", type: "user", time: { created: 1 }, text: "hello" }
    let metadataCalls = 0
    let observedSignal: AbortSignal | undefined
    let releaseMetadata = () => {}
    const metadataGate = new Promise<void>((resolve) => (releaseMetadata = resolve))
    const client = {
      v2: {
        session: {
          messages: async () => ({ data: { data: [rawUser], cursor: {} } }),
        },
      },
      session: {
        get: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          metadataCalls++
          observedSignal = options?.signal
          await metadataGate
          if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted")
          return { data: undefined }
        },
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [], response: { headers: new Headers() } }),
      },
    }
    const serverSync = {
      child: () => [store, setStore],
      data: { project: [] },
      todo: { get: () => undefined, set: () => {} },
      mcp: { toggle: () => {} },
    }
    const serverSDK = {
      scope: "directory-sync-metadata-hung",
      server: undefined,
      createClient: () => client,
      sync: { on: () => () => {} },
      event: { on: () => () => {} },
    }
    let dispose = () => {}
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })

    try {
      // Concurrent info/sync teilen genau einen Metadata-Request.
      const first = context.session.info(sessionID)
      const second = context.session.sync(sessionID)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(metadataCalls).toBe(1)
      expect(observedSignal).toBeDefined()

      // Dispose bricht genau den echten Signalgeber ab, beide Promises settlen.
      dispose()
      const settled = await Promise.allSettled([first, second])
      expect(observedSignal?.aborted).toBe(true)
      expect(settled).toHaveLength(2)

      // Kein spätes Store-Write nach Dispose.
      expect(store.session.some((entry: { id: string }) => entry.id === sessionID)).toBe(false)
    } finally {
      releaseMetadata()
      dispose()
    }
  },
  60_000,
)

test(
  "cold sync settles within bounded metadata budget when metadata hangs but messages are fast",
  async () => {
    const directory = "C:/repo-metadata-hung-budget"
    const sessionID = "ses_metadata_hung_budget"
    const [store, setStore] = createStore({
      status: "complete" as const,
      agent: [],
      command: [],
      project: "project",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider: { all: [], connected: [], default: {} },
      config: {},
      path: { directory, state: "", config: "", worktree: "", home: "" },
      session: [],
      sessionTotal: 0,
      session_status: {} as Record<string, SessionStatus>,
      session_working: () => false,
      session_diff: {},
      todo: {},
      turnCompletion: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 50,
      message: {} as Record<string, never>,
      part: {},
      part_text_accum_delta: {},
    })
    const rawUser: SessionMessage = { id: "msg_user", type: "user", time: { created: 1 }, text: "hello" }
    const staleSession = {
      id: sessionID,
      directory,
      title: "stale title",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    const freshSession = {
      id: sessionID,
      directory,
      title: "fresh title v2",
      version: "2",
      time: { created: 1, updated: 2 },
    }
    let metadataCalls = 0
    let releaseStale = () => {}
    const staleGate = new Promise<void>((resolve) => (releaseStale = resolve))
    const client = {
      v2: {
        session: {
          messages: async () => ({ data: { data: [rawUser], cursor: {} } }),
        },
      },
      session: {
        // Erste beide Aufrufe (Erstversuch + Wrapper-Retry) hängen am Gate
        // und ignorieren Abort bewusst, um eine späte Antwort zu simulieren.
        // Der Wrapper muss trotzdem gebunden ablehnen und das späte Ergebnis
        // danach ignorieren.
        get: async () => {
          metadataCalls++
          if (metadataCalls <= 2) {
            await staleGate
            return { data: staleSession }
          }
          return { data: freshSession }
        },
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [], response: { headers: new Headers() } }),
      },
    }
    const serverSync = {
      child: () => [store, setStore],
      data: { project: [] },
      todo: { get: () => undefined, set: () => {} },
      mcp: { toggle: () => {} },
    }
    const serverSDK = {
      scope: "directory-sync-metadata-hung-budget",
      server: undefined,
      createClient: () => client,
      sync: { on: () => () => {} },
      event: { on: () => () => {} },
    }
    let dispose = () => {}
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })

    try {
      // Gebundene Deadline mit echtem Produktionsbudget: cold sync lehnt mit
      // recoverable Timeout ab, statt ewig zu hängen. Messages bleiben sichtbar.
      const first = await context.session.sync(sessionID).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      expect(metadataCalls).toBeGreaterThan(0)
      expect(first.ok).toBe(false)
      if (!first.ok) expect(isSessionMessageRequestTimeoutError(first.error)).toBe(true)
      expect(((store.message[sessionID] ?? []) as unknown[]).length).toBeGreaterThan(0)

      // Singleflight freigegeben: nächster Versuch startet neu und gelingt.
      await context.session.sync(sessionID)
      expect(store.session.some((entry: { id: string }) => entry.id === sessionID)).toBe(true)
      expect(
        (store.session.find((entry: { id: string }) => entry.id === sessionID) as { title?: string } | undefined)
          ?.title,
      ).toBe("fresh title v2")

      // Späte Antwort darf neueren State nicht überschreiben: altes Gate
      // freigeben, frischer Titel/Version bleiben erhalten.
      releaseStale()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(
        (store.session.find((entry: { id: string }) => entry.id === sessionID) as { title?: string } | undefined)
          ?.title,
      ).toBe("fresh title v2")
    } finally {
      releaseStale()
      dispose()
    }
  },
  60_000,
)
