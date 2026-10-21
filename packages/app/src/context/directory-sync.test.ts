import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionMessage, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  type LegacySessionMessage,
  applyOptimisticAdd,
  clearOptimisticMessages,
  createCrossStreamEventDeduplicator,
  createDirSyncContext,
  createV2SessionDeltaController,
  isInvalidCursorError,
  hydratedSessionStatus,
  loadAdaptiveLegacyRefresh,
  mergeFetchedMessageParts,
  mergeOptimisticPage,
  mergeAdaptedMessagePages,
  nextSessionMessageReadLimit,
  nextSessionMessageLimit,
  pageLegacyMessageResponse,
  pageLegacyMessages,
  shouldOverlayLegacyHistory,
  shouldMergeCachedSessionMessages,
  shouldRefreshSessionStatus,
  shouldServeCachedSessionMessages,
  shouldSkipForcedSessionRefresh,
  shouldLoadAdaptiveLegacyRefresh,
  shouldUseCachedSessionMessages,
  SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
  withSessionMessageRequestTimeout,
  streamedSessionMessageID,
  streamedSessionLifecycleStatus,
  streamedSessionRevertCleanup,
  syncedSessionLifecycleStatus,
  syncedSessionRevertCleanup,
  syncedSessionMessageID,
  type AdaptedMessagePage,
} from "./directory-sync"
import { clearSessionPrefetch, setSessionPrefetch } from "@/context/global-sync/session-prefetch"
import { finishSessionActivity, startSessionActivity } from "@/utils/session-activity"
import type { ServerScope } from "@/utils/server-scope"
import { SESSION_MESSAGE_REQUEST_RETRIES } from "./session-message-request"
import { latestMessage } from "@/utils/message-order"

test("loads MCP only for an explicitly requested directory context", () => {
  const mcpRequests: string[] = []
  const serverSync = {
    child: (directory: string, options?: { mcp?: boolean }) => {
      if (options?.mcp) mcpRequests.push(directory)
      return [{ session: [] }, () => undefined]
    },
    mcp: { toggle: () => Promise.resolve() },
  }
  const serverSDK = {
    createClient: () => ({}),
    sync: { on: () => () => undefined },
    event: { on: () => () => undefined },
  }

  createRoot((dispose) => {
    const contexts = ["/first", "/second", "/third"].map((directory) =>
      createDirSyncContext(directory, serverSync as never, serverSDK as never),
    )
    const selected = contexts[1]
    if (!selected) throw new Error("second context required")

    expect(mcpRequests).toEqual([])
    selected.mcp.load()
    expect(mcpRequests).toEqual(["/second"])
    dispose()
  })
})

test("skips a force refresh only when a waited replace load already refreshed the cache", () => {
  const before = {}
  const after = {}
  expect(shouldSkipForcedSessionRefresh({ mode: "replace", before, after })).toBe(true)
  expect(shouldSkipForcedSessionRefresh({ mode: "replace", before, after: before })).toBe(false)
  expect(shouldSkipForcedSessionRefresh({ mode: "prepend", before, after })).toBe(false)
})

test("aborts a stalled foreground message read instead of leaving the timeline loading forever", async () => {
  const controller = new AbortController()
  let aborted = 0
  let attempts = 0

  await expect(
    withSessionMessageRequestTimeout({
      signal: controller.signal,
      timeoutMs: 5,
      task: (signal) => {
        attempts++
        return new Promise<never>((_resolve, _reject) => {
          signal.addEventListener("abort", () => {
            aborted++
          })
        })
      },
    }),
  ).rejects.toThrow("Session message request timed out after 2 attempts")

  expect(attempts).toBe(2)
  expect(aborted).toBe(2)
  expect(SESSION_MESSAGE_REQUEST_RETRIES).toBe(1)
  expect(SESSION_MESSAGE_REQUEST_TIMEOUT_MS).toBe(15_000)
})

test("retries one timed-out foreground message read before surfacing an error", async () => {
  const controller = new AbortController()
  let attempts = 0
  let aborted = 0

  await expect(
    withSessionMessageRequestTimeout({
      signal: controller.signal,
      timeoutMs: 5,
      task: (signal) => {
        attempts++
        if (attempts === 2) return Promise.resolve("loaded")
        return new Promise<never>((_resolve, _reject) => {
          signal.addEventListener("abort", () => {
            aborted++
          })
        })
      },
    }),
  ).resolves.toBe("loaded")

  expect(attempts).toBe(2)
  expect(aborted).toBe(1)
})

test("allows passive message reads to disable timeout retries", async () => {
  const controller = new AbortController()
  let attempts = 0

  await expect(
    withSessionMessageRequestTimeout({
      signal: controller.signal,
      timeoutMs: 5,
      retries: 0,
      task: () => {
        attempts++
        return new Promise<never>(() => {})
      },
    }),
  ).rejects.toThrow("Session message request timed out after 1 attempts")

  expect(attempts).toBe(1)
})

type Text = Extract<Part, { type: "text" }>
type File = Extract<Part, { type: "file" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-5.5" },
})

const assistantMessage = (id: string, sessionID: string, parentID: string): Message => ({
  id,
  sessionID,
  role: "assistant",
  parentID,
  time: { created: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "gpt-5.5",
  providerID: "openai",
  mode: "build",
  agent: "build",
  path: { cwd: "", root: "" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

const filePart = (id: string, sessionID: string, messageID: string, url: string): File => ({
  id,
  sessionID,
  messageID,
  type: "file",
  mime: "image/png",
  filename: "image.png",
  url,
})

test("deduplicates durable events mirrored across the sync and projected event streams", () => {
  const events = createCrossStreamEventDeduplicator()

  expect(events.accept("evt_1")).toBe(true)
  expect(events.accept("evt_1")).toBe(false)
  expect(events.accept()).toBe(true)
  events.clear()
  expect(events.accept("evt_1")).toBe(true)
})

const legacyMessage = (message: Message, parts: Part[] = [textPart(`${message.id}:text`, message.sessionID, message.id)]) =>
  ({ info: message, parts }) satisfies LegacySessionMessage

const adaptedPage = (ids: string[], input: { cursor?: string; complete?: boolean } = {}): AdaptedMessagePage => ({
  session: ids.map((id) => userMessage(id, "ses_1")),
  part: ids.map((id) => ({ id, part: [textPart(`${id}:text`, "ses_1", id)] })),
  cursor: input.cursor,
  complete: input.complete ?? !input.cursor,
})

test("mergeOptimisticPage removes the pasted-image overlay once the V2 attachment arrives", () => {
  const sessionID = "ses_1"
  const messageID = "msg_1"
  const page = mergeOptimisticPage(
    {
      session: [userMessage(messageID, sessionID)],
      part: [
        {
          id: messageID,
          part: [
            { ...textPart(`${messageID}:text`, sessionID, messageID), text: "What is shown?" },
            filePart(`${messageID}:file:0`, sessionID, messageID, "attachment://att_1"),
          ],
        },
      ],
      complete: true,
    },
    [
      {
        message: userMessage(messageID, sessionID),
        parts: [
          { ...textPart("part_1", sessionID, messageID), text: "What is shown?" },
          filePart("part_2", sessionID, messageID, "data:image/png;base64,aGVsbG8="),
        ],
      },
    ],
  )

  expect(page.confirmed).toEqual([messageID])
  expect(page.part[0]?.part.filter((part) => part.type === "file")).toEqual([
    expect.objectContaining({ id: `${messageID}:file:0`, url: "attachment://att_1" }),
  ])
})

test("mergeFetchedMessageParts replaces confirmed optimistic attachments in the persistent store", () => {
  const sessionID = "ses_1"
  const messageID = "msg_1"
  const optimistic = filePart("part_1", sessionID, messageID, "data:image/png;base64,aGVsbG8=")
  const authoritative = filePart(`${messageID}:file:0`, sessionID, messageID, "attachment://att_1")

  expect(mergeFetchedMessageParts([optimistic], [authoritative], {}, true)).toEqual([authoritative])
  expect(mergeFetchedMessageParts([optimistic], [authoritative], {}, false)).toEqual([authoritative])
  expect(mergeFetchedMessageParts([authoritative], [optimistic], {}, false)).toEqual([authoritative])
  const second = { ...authoritative, id: `${messageID}:file:1`, url: "attachment://att_2" }
  // Non-authoritative refreshes are additive for real slots, never for aliases.
  expect(mergeFetchedMessageParts([authoritative, second], [authoritative], {}, false)).toEqual([authoritative, second])
  expect(mergeFetchedMessageParts([authoritative, second], [authoritative], {}, true)).toEqual([authoritative])
})

function v2DeltaHarness(part: Record<string, Part[] | undefined>) {
  const controller = createV2SessionDeltaController()
  const store = { part, part_text_accum_delta: {} as Record<string, string | undefined> }
  let refreshes = 0
  const apply = (action: ReturnType<typeof controller.materialize>[number]) => {
    const parts = store.part[action.messageID]
    if (parts) parts[action.index] = action.part
    if (typeof action.accumulatedText === "string") {
      store.part_text_accum_delta[action.partID] = action.accumulatedText
    }
  }
  const dispatch = (event: { id?: string; type: string; data?: unknown }) => {
    const action = controller.handle(event, store)
    if (action?.kind === "delta" && action.applied) apply(action)
    if (action?.refresh) refreshes++
    return action
  }
  const materialize = (sessionID: string) => controller.materialize(sessionID, store).forEach(apply)
  return { controller, store, dispatch, materialize, refreshes: () => refreshes }
}

describe("directory sync message source fallback", () => {
  test("does not let an empty status refresh erase live-confirmed activity", () => {
    expect(
      hydratedSessionStatus({
        current: { type: "busy" },
        incoming: undefined,
        liveBusy: true,
      }),
    ).toEqual({ type: "busy" })
  })

  test("accepts an idle refresh after live activity completes", () => {
    expect(
      hydratedSessionStatus({
        current: { type: "busy" },
        incoming: undefined,
        liveBusy: false,
      }),
    ).toEqual({ type: "idle" })
  })

  test("preserves retry status during hydration when SSE confirms activity", () => {
    expect(
      hydratedSessionStatus({
        current: { type: "retry", attempt: 2, message: "rate limited", next: Date.now() + 5000 },
        incoming: { type: "idle" },
        liveBusy: true,
      }),
    ).toEqual({ type: "retry", attempt: 2, message: "rate limited", next: expect.any(Number) })
  })

  test("does not preserve retry status when SSE is not active", () => {
    expect(
      hydratedSessionStatus({
        current: { type: "retry", attempt: 1, message: "500", next: Date.now() + 3000 },
        incoming: { type: "idle" },
        liveBusy: false,
      }),
    ).toEqual({ type: "idle" })
  })

  test("does not let a stale busy snapshot override a retained lifecycle terminal", () => {
    expect(
      hydratedSessionStatus({
        current: { type: "idle" },
        incoming: { type: "busy" },
        liveBusy: false,
        liveSettled: true,
      }),
    ).toEqual({ type: "idle" })
  })

  test("replaces an optimistic message with the same id instead of duplicating it", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID)] },
      part: { msg_1: [textPart("prt_old", sessionID, "msg_1")] } as Record<string, Part[] | undefined>,
    }
    const replacement = { ...userMessage("msg_1", sessionID), time: { created: 2 } }

    applyOptimisticAdd(draft, {
      sessionID,
      message: replacement,
      parts: [textPart("prt_new", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]).toEqual([replacement])
    expect(draft.part.msg_1?.map((part) => part.id)).toEqual(["prt_new"])
  })

  test("removes every reverted message from the persistent optimistic cache", () => {
    const key = "C:/repo\u0000ses_1"
    const optimistic = new Map([
      [
        key,
        new Map([
          ["msg_reverted_user", { value: 1 }],
          ["msg_reverted_assistant", { value: 2 }],
          ["msg_kept", { value: 3 }],
        ]),
      ],
    ])

    clearOptimisticMessages(optimistic, key, ["msg_reverted_user", "msg_reverted_assistant"])
    expect([...optimistic.get(key)!.keys()]).toEqual(["msg_kept"])

    clearOptimisticMessages(optimistic, key, ["msg_kept"])
    expect(optimistic.has(key)).toBe(false)
  })

  test("releases a reverted never-settling loadOlder so refresh can complete without stale commits", async () => {
    const directory = "C:/repo"
    const sessionID = "ses_1"
    const id = (turn: number, role: "user" | "assistant") =>
      `msg_${turn.toString().padStart(4, "0")}_${role}`
    const turn = (value: number): SessionMessage[] => [
      {
        id: id(value, "user"),
        type: "user",
        time: { created: value * 2 },
        text: `user ${value}`,
      },
      {
        id: id(value, "assistant"),
        type: "assistant",
        time: { created: value * 2 + 1 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
        content: [{ type: "text", id: `text_${value}`, text: `assistant ${value}` }],
      },
    ]
    const history = Array.from({ length: 170 }, (_, index) => turn(index + 1)).flat()
    const latest = history.slice(138)
    const older = history.slice(0, 140)
    const removed = [id(70, "user"), id(70, "assistant")]
    const session = {
      id: sessionID,
      directory,
      title: "Paging revert race",
      version: "1",
      time: { created: 1, updated: 1 },
    }
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
      session: [session],
      sessionTotal: 1,
      session_status: { [sessionID]: { type: "idle" as const } },
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
      message: {} as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
    })
    let releaseOlder = () => {}
    let markOlderBlocked = () => {}
    let markRefreshStarted = () => {}
    const olderGate = new Promise<void>((resolve) => (releaseOlder = resolve))
    const olderBlocked = new Promise<void>((resolve) => (markOlderBlocked = resolve))
    const refreshStarted = new Promise<void>((resolve) => (markRefreshStarted = resolve))
    let blockOlder = true
    let olderCompleted = false
    let olderSignal: AbortSignal | undefined
    let latestReads = 0
    let eventListener: ((event: { type: string; properties?: unknown }) => void) | undefined
    const response = (data: SessionMessage[], cursor?: string) => ({ data: { data, cursor: { next: cursor } } })
    const client = {
      v2: {
        session: {
          messages: async (input: { cursor?: string }, options?: { signal?: AbortSignal }) => {
            if (!input.cursor) {
              latestReads++
              if (latestReads === 2) markRefreshStarted()
              return response(latest, "cursor-older")
            }
            if (input.cursor !== "cursor-older") throw new Error(`Unexpected cursor: ${input.cursor}`)
            if (blockOlder) {
              blockOlder = false
              olderSignal = options?.signal
              markOlderBlocked()
              await olderGate
              olderCompleted = true
            }
            return response(older)
          },
        },
      },
      session: {
        get: async () => ({ data: session }),
        messages: async () => {
          throw new Error("Legacy messages must not be read in the V2 paging regression")
        },
      },
    }
    const serverSync = {
      child: () => [store, setStore],
      data: { project: [] },
      todo: { get: () => undefined, set: () => {} },
      mcp: { toggle: () => {} },
    }
    const serverSDK = {
      scope: "directory-sync-revert-race",
      server: undefined,
      createClient: () => client,
      sync: { on: () => () => {} },
      event: {
        on: (_directory: string, listener: (event: { type: string; properties?: unknown }) => void) => {
          eventListener = listener
          return () => {}
        },
      },
    }
    let dispose = () => {}
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })
    const ids = () => context.data.message[sessionID]?.map((message) => message.id) ?? []

    try {
      await context.session.sync(sessionID)
      expect(ids()).toHaveLength(202)

      const staleLoadOlder = context.session.history.loadMore(sessionID)
      await olderBlocked
      expect(context.session.history.loading(sessionID)).toBe(true)
      expect(context.session.history.refreshing(sessionID)).toBe(false)
      let forcedRefreshSettled = false
      const forcedRefresh = context.session.sync(sessionID, { force: true }).finally(() => {
        forcedRefreshSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(forcedRefreshSettled).toBe(false)
      expect(latestReads).toBe(1)
      eventListener?.({
        type: "session.next.revert.cleaned",
        properties: { sessionID, messageIDs: removed },
      })
      expect(ids().some((messageID) => removed.includes(messageID))).toBe(false)
      expect(olderSignal?.aborted).toBe(true)

      releaseOlder()
      await staleLoadOlder
      await refreshStarted
      await forcedRefresh
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(latestReads).toBe(2)
      expect(context.session.history.loading(sessionID)).toBe(false)
      expect(olderCompleted).toBe(true)
      expect(ids()).toHaveLength(200)
      expect(ids().some((messageID) => removed.includes(messageID))).toBe(false)

      await context.session.history.loadMore(sessionID)
      expect(ids()).toHaveLength(338)
      expect(ids().some((messageID) => removed.includes(messageID))).toBe(false)
      expect(ids()).toContain(id(69, "assistant"))
      expect(ids()).toContain(id(71, "assistant"))
      expect(ids()).toContain(id(170, "assistant"))

      await context.session.sync(sessionID, { force: true })
      expect(ids()).toHaveLength(338)
      expect(ids().some((messageID) => removed.includes(messageID))).toBe(false)
      expect(context.data.part[removed[0]!]).toBeUndefined()
      expect(context.data.part[removed[1]!]).toBeUndefined()
    } finally {
      releaseOlder()
      dispose()
    }
  })

  test("projects a full terminal tool input without a delta and catches up blocked refreshes", async () => {
    const directory = "C:/repo"
    const sessionID = "ses_live"
    const session = {
      id: sessionID,
      directory,
      title: "Live projection",
      version: "1",
      time: { created: 1, updated: 1 },
    }
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
      session: [session],
      sessionTotal: 1,
      session_status: { [sessionID]: { type: "busy" } } as Record<string, SessionStatus>,
      session_working: () => true,
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
      message: {} as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
    })
    let reads = 0
    let eventListener: ((event: { id?: string; type: string; properties?: unknown }) => void) | undefined
    let unblockRefresh = () => {}
    let markRefreshStarted = () => {}
    let markCatchupStarted = () => {}
    const refreshStarted = new Promise<void>((resolve) => (markRefreshStarted = resolve))
    const catchupStarted = new Promise<void>((resolve) => (markCatchupStarted = resolve))
    const refreshGate = new Promise<void>((resolve) => (unblockRefresh = resolve))
    const rawUser: SessionMessage = {
      id: "msg_user",
      type: "user",
      time: { created: 1 },
      text: "Run the tool",
    }
    const client = {
      v2: {
        session: {
          messages: async () => {
            reads++
            if (reads === 2) {
              markRefreshStarted()
              await refreshGate
            }
            if (reads === 3) markCatchupStarted()
            return { data: { data: [rawUser], cursor: {} } }
          },
        },
      },
      session: {
        get: async () => ({ data: session }),
        status: async () => ({ data: { [sessionID]: { type: "busy" as const } } }),
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
      scope: "directory-sync-live-projection",
      server: undefined,
      createClient: () => client,
      sync: { on: () => () => {} },
      event: {
        on: (_directory: string, listener: typeof eventListener) => {
          eventListener = listener
          return () => {}
        },
      },
    }
    let dispose = () => {}
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })
    const emit = (id: string, type: string, properties: Record<string, unknown>) =>
      eventListener?.({ id, type, properties: { sessionID, ...properties } })

    try {
      await context.session.sync(sessionID)
      emit("evt_step", "session.next.step.started", {
        timestamp: 2,
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
      })
      emit("evt_tool_start", "session.next.tool.input.started", {
        timestamp: 3,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        name: "read",
      })
      const toolInput = {
        timestamp: 4,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        text: '{"path":"README.md"}',
      }
      emit("evt_tool_input", "session.next.tool.input.ended", toolInput)
      emit("evt_tool_input", "session.next.tool.input.ended.1", toolInput)
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(reads).toBe(1)
      expect(context.data.part.msg_assistant?.find((part) => part.id === "call_1")).toMatchObject({
        type: "tool",
        state: { status: "pending", raw: '{"path":"README.md"}' },
      })

      emit("evt_tool_called", "session.next.tool.called", {
        timestamp: 5,
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        tool: "read",
        input: { path: "README.md" },
        provider: { executed: false },
      })
      emit("evt_text_start", "session.next.text.started", {
        timestamp: 6,
        assistantMessageID: "msg_assistant",
        textID: "text_1",
      })
      emit("evt_text_delta", "session.next.text.delta", {
        timestamp: 7,
        assistantMessageID: "msg_assistant",
        textID: "text_1",
        delta: "Streaming now",
      })
      emit("evt_conflicting_tool_start", "session.next.tool.input.started", {
        timestamp: 9,
        assistantMessageID: "msg_assistant",
        callID: "call_conflicting",
        name: "read",
      })
      emit("evt_conflicting_tool_delta", "session.next.tool.input.delta", {
        timestamp: 10,
        assistantMessageID: "msg_assistant",
        callID: "call_conflicting",
        delta: '{"path":"stable.md"}',
      })
      emit("evt_conflicting_tool_input", "session.next.tool.input.ended", {
        timestamp: 11,
        assistantMessageID: "msg_assistant",
        callID: "call_conflicting",
        text: '{"path":"other.md"}',
      })

      await refreshStarted
      const assistant = context.data.message[sessionID]?.find((message) => message.id === "msg_assistant")
      const tool = context.data.part.msg_assistant?.find((part) => part.id === "call_1")
      const text = context.data.part.msg_assistant?.find((part) => part.id === "msg_assistant:text_1")
      const conflicting = context.data.part.msg_assistant?.find((part) => part.id === "call_conflicting")
      expect(assistant).toMatchObject({ role: "assistant", parentID: "msg_user" })
      expect(tool).toMatchObject({ type: "tool", state: { status: "running", input: { path: "README.md" } } })
      expect(text).toMatchObject({ type: "text", text: "Streaming now" })
      expect(conflicting).toMatchObject({ type: "tool", state: { status: "pending", raw: '{"path":"stable.md"}' } })
      expect(reads).toBe(2)

      emit("evt_missing_tool_input", "session.next.tool.input.ended", {
        timestamp: 12,
        assistantMessageID: "msg_assistant",
        callID: "call_missing",
        text: "{}",
      })
      emit("evt_tool_start_during_refresh", "session.next.tool.input.started", {
        timestamp: 13,
        assistantMessageID: "msg_assistant",
        callID: "call_during_refresh",
        name: "read",
      })
      emit("evt_tool_delta_during_refresh", "session.next.tool.input.delta", {
        timestamp: 14,
        assistantMessageID: "msg_assistant",
        callID: "call_during_refresh",
        delta: '{"path":"during-refresh.md"}',
      })
      emit("evt_tool_input_during_refresh", "session.next.tool.input.ended", {
        timestamp: 15,
        assistantMessageID: "msg_assistant",
        callID: "call_during_refresh",
        text: '{"path":"during-refresh.md"}',
      })
      expect(reads).toBe(2)

      unblockRefresh()
      await catchupStarted
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(context.data.message[sessionID]?.some((message) => message.id === "msg_assistant")).toBe(true)
      expect(context.data.part.msg_assistant?.find((part) => part.id === "msg_assistant:text_1")).toMatchObject({
        type: "text",
        text: "Streaming now",
      })
      expect(context.data.part.msg_assistant?.find((part) => part.id === "call_during_refresh")).toMatchObject({
        type: "tool",
        state: { status: "pending", raw: '{"path":"during-refresh.md"}' },
      })
      expect(reads).toBe(3)

      emit("evt_revert", "session.next.revert.cleaned", {
        timestamp: 16,
        messageIDs: ["msg_assistant"],
        revert: { messageID: "msg_user" },
      })
      emit("evt_step_replayed", "session.next.step.started", {
        timestamp: 17,
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
      })
      emit("evt_text_replayed", "session.next.text.started", {
        timestamp: 18,
        assistantMessageID: "msg_assistant",
        textID: "text_replayed",
      })
      expect(context.data.message[sessionID]?.some((message) => message.id === "msg_assistant")).toBe(false)
      expect(context.data.part.msg_assistant).toBeUndefined()
    } finally {
      unblockRefresh()
      dispose()
    }
  })

  test("keeps a cached long-session timeline live while another context owns its tracking", async () => {
    const directory = "C:/repo"
    const sessionID = "ses_cached_live"
    const generated = Array.from({ length: 161 }, (_, index) => {
      const turn = index + 1
      return [
        {
          id: `msg_${turn.toString().padStart(4, "0")}_0_user`,
          sessionID,
          role: "user" as const,
          time: { created: turn * 2 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        {
          id: `msg_${turn.toString().padStart(4, "0")}_1_assistant`,
          sessionID,
          role: "assistant" as const,
          parentID: `msg_${turn.toString().padStart(4, "0")}_0_user`,
          time: { created: turn * 2 + 1, completed: turn * 2 + 1 },
          agent: "build",
          modelID: "gpt-5.6",
          providerID: "openai",
          mode: "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ]
    }).flat() satisfies Message[]
    const renamed = new Map([
      ["msg_0001_0_user", "msg_80daf1f1f62f000994c26e3603"],
      ["msg_0160_0_user", "msg_06d8e45f2001F5K1Hrks6Vfk9F"],
      ["msg_0161_0_user", "msg_06da7942d001gZ4lUKMCOdb3m9"],
    ])
    const messages = generated
      .map((message) => ({
        ...message,
        id: renamed.get(message.id) ?? message.id,
        ...(message.role === "assistant" ? { parentID: renamed.get(message.parentID) ?? message.parentID } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as Message[]
    const session = {
      id: sessionID,
      directory,
      title: "Cached live tail",
      version: "1",
      time: { created: 1, updated: 1 },
    }
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
      session: [session],
      sessionTotal: 1,
      session_status: { [sessionID]: { type: "idle" as const } } as Record<string, SessionStatus>,
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
      message: { [sessionID]: messages } as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
    })
    let eventListener: ((event: { id?: string; type: string; properties?: unknown }) => void) | undefined
    const rawTail: SessionMessage = {
      id: "msg_06da7942d001gZ4lUKMCOdb3m9",
      type: "user",
      time: { created: 322 },
      text: "user 161",
    }
    const authoritativeText = "Visible progress from authoritative refresh"
    const rawAssistant: SessionMessage = {
      id: "msg_06db2f832001gcUXbdxJwK1vkJ",
      type: "assistant",
      time: { created: 400 },
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.6" },
      content: [{ id: "text_live", type: "text", text: authoritativeText }],
    }
    let reads = 0
    const client = {
      v2: { session: { messages: async () => {
        reads++
        return { data: { data: [rawTail, rawAssistant], cursor: {} } }
      } } },
      session: {
        get: async () => ({ data: session }),
        status: async () => ({ data: { [sessionID]: { type: "busy" as const } } }),
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
      scope: "directory-sync-cached-live-tail",
      server: undefined,
      createClient: () => client,
      sync: { on: () => () => {} },
      event: {
        on: (_directory: string, listener: typeof eventListener) => {
          eventListener = listener
          return () => {}
        },
      },
    }
    let dispose = () => {}
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })
    const emit = (id: string, type: string, properties: Record<string, unknown>) =>
      eventListener?.({ id, type, properties: { sessionID, ...properties } })

    try {
      emit("evt_activity", "session.next.activity.started", { activityID: "act_1" })
      emit("evt_step", "session.next.step.started", {
        timestamp: 400,
        assistantMessageID: "msg_06db2f832001gcUXbdxJwK1vkJ",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
      })
      emit("evt_tool", "session.next.tool.called", {
        timestamp: 401,
        assistantMessageID: "msg_06db2f832001gcUXbdxJwK1vkJ",
        callID: "call_live",
        tool: "bash",
        input: { command: "echo live" },
        provider: { executed: false },
      })
      emit("evt_text_start", "session.next.text.started", {
        timestamp: 402,
        assistantMessageID: "msg_06db2f832001gcUXbdxJwK1vkJ",
        textID: "text_live",
      })
      emit("evt_text_delta", "session.next.text.delta", {
        timestamp: 403,
        assistantMessageID: "msg_06db2f832001gcUXbdxJwK1vkJ",
        textID: "text_live",
        delta: "Visible progress",
      })

      expect(context.data.session_status[sessionID]).toEqual({ type: "busy" })
      expect(context.data.message[sessionID]).toHaveLength(323)
      const liveMessages = context.data.message[sessionID]!
      expect(liveMessages.map((message) => message.id)).toEqual(liveMessages.map((message) => message.id).sort())
      expect(liveMessages.find((message) => message.id === "msg_06db2f832001gcUXbdxJwK1vkJ")).toMatchObject({
        role: "assistant",
        parentID: "msg_06da7942d001gZ4lUKMCOdb3m9",
      })
      expect(latestMessage(liveMessages.filter((message) => message.role === "user"))?.id).toBe(
        "msg_06da7942d001gZ4lUKMCOdb3m9",
      )
      expect(context.data.part.msg_06db2f832001gcUXbdxJwK1vkJ?.map((part) => part.id)).toEqual([
        "call_live",
        "msg_06db2f832001gcUXbdxJwK1vkJ:text_live",
      ])
      expect(context.data.part.msg_06db2f832001gcUXbdxJwK1vkJ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "call_live", type: "tool", state: expect.objectContaining({ status: "running" }) }),
          expect.objectContaining({ id: "msg_06db2f832001gcUXbdxJwK1vkJ:text_live", type: "text", text: "Visible progress" }),
        ]),
      )

      await context.session.sync(sessionID, { force: true })
      expect(reads).toBe(1)
      expect(context.data.message[sessionID]).toHaveLength(323)
      const refreshedMessages = context.data.message[sessionID]!
      expect(refreshedMessages.map((message) => message.id)).toEqual(
        refreshedMessages.map((message) => message.id).sort(),
      )
      expect(refreshedMessages.find((message) => message.id === "msg_06db2f832001gcUXbdxJwK1vkJ")).toMatchObject({
        role: "assistant",
        parentID: "msg_06da7942d001gZ4lUKMCOdb3m9",
      })
      expect(latestMessage(refreshedMessages.filter((message) => message.role === "user"))?.id).toBe(
        "msg_06da7942d001gZ4lUKMCOdb3m9",
      )
      expect(context.data.part.msg_06db2f832001gcUXbdxJwK1vkJ?.map((part) => part.id)).toEqual([
        "call_live",
        "msg_06db2f832001gcUXbdxJwK1vkJ:text_live",
      ])
      expect(context.data.part.msg_06db2f832001gcUXbdxJwK1vkJ?.at(-1)).toMatchObject({
        type: "text",
        text: authoritativeText,
      })
    } finally {
      dispose()
    }
  })

  test("serves a completed prefetch on open while the session status is still unknown", async () => {
    const directory = "C:/repo"
    const scope = "directory-sync-prefetch-open-race" as ServerScope
    const prefetchLimit = 92
    const sessions = ["ses_prefetch_unknown", "ses_prefetch_activity_busy", "ses_prefetch_store_busy"]
    const pageMessages = (sessionID: string): Message[] =>
      Array.from({ length: prefetchLimit }, (_, index) => ({
        id: `${sessionID}_msg_${index.toString().padStart(4, "0")}`,
        sessionID,
        role: "user" as const,
        time: { created: index + 1 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6" },
      }))
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
      session: sessions.map((id) => ({ id, directory, title: id, version: "1", time: { created: 1, updated: 1 } })),
      sessionTotal: sessions.length,
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
      message: Object.fromEntries(sessions.map((id) => [id, pageMessages(id)])) as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
    })
    for (const sessionID of sessions) {
      setSessionPrefetch({
        scope,
        directory,
        sessionID,
        limit: prefetchLimit,
        cursor: `cursor_${sessionID}`,
        complete: false,
      })
    }
    let reads = 0
    const client = {
      v2: {
        session: {
          messages: async () => {
            reads++
            return { data: { data: [], cursor: {} } }
          },
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: store.session.find((session) => session.id === sessionID),
        }),
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
      scope,
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
      const [unknownStatus, activityBusy, storeBusy] = sessions

      // Race moment: the prefetch page is committed in the child store and its
      // metadata is current, but bootstrap has not populated session_status yet.
      // The opened session must serve the prefetched page without a new read.
      expect(store.session_status[unknownStatus]).toBeUndefined()
      await context.session.sync(unknownStatus)
      expect(reads).toBe(0)
      expect(context.data.message[unknownStatus]).toHaveLength(prefetchLimit)
      expect(context.session.history.more(unknownStatus)).toBe(true)
      expect(context.session.history.loading(unknownStatus)).toBe(false)

      // An explicit live busy activity still forces a fresh read on open.
      expect(startSessionActivity(directory, activityBusy)).toBe(true)
      await context.session.sync(activityBusy)
      expect(reads).toBe(1)

      // An explicit busy session_status still forces a fresh read on open.
      setStore("session_status", storeBusy, { type: "busy" })
      await context.session.sync(storeBusy)
      expect(reads).toBe(2)
    } finally {
      finishSessionActivity(directory, "ses_prefetch_activity_busy")
      clearSessionPrefetch(scope, directory, sessions)
      dispose()
    }
  })

  test("refreshes cold and cached non-idle session statuses", () => {
    expect(shouldRefreshSessionStatus()).toBe(true)
    expect(shouldRefreshSessionStatus("idle")).toBe(false)
    expect(shouldRefreshSessionStatus("busy")).toBe(true)
    expect(shouldRefreshSessionStatus("retry")).toBe(true)
  })

  test("uses streamed v2 materialization events when global sync envelopes are unavailable", () => {
    expect(
      streamedSessionMessageID({
        type: "session.next.text.ended",
        properties: { sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1", text: "done" },
      }),
    ).toBe("ses_1")
    expect(
      streamedSessionMessageID({
        type: "session.next.activity.started",
        properties: { sessionID: "ses_1", activityID: "activity_1", kind: "prompt" },
      }),
    ).toBeUndefined()
  })

  test("does not refetch materialized pages for live-only v2 deltas", () => {
    for (const type of [
      "session.next.text.delta",
      "session.next.reasoning.delta",
      "session.next.tool.input.delta",
      "session.next.compaction.delta",
    ]) {
      expect(
        streamedSessionMessageID({
          type,
          properties: { sessionID: "ses_1", delta: "stream fragment" },
        }),
      ).toBeUndefined()
    }

    for (const type of [
      "session.next.text.ended",
      "session.next.reasoning.ended",
      "session.next.tool.input.ended",
      "session.next.compaction.ended",
    ]) {
      expect(streamedSessionMessageID({ type, properties: { sessionID: "ses_1" } })).toBe("ses_1")
    }
  })

  test("refetches completed and failed activities but skips control-only status events", () => {
    for (const type of [
      "session.next.prompt.promoted",
      "session.next.agent.switched",
      "session.next.model.switched",
      "session.next.context.updated",
      "session.next.title.updated",
      "session.next.activity.interrupted",
      "session.next.compaction.started",
    ]) {
      expect(streamedSessionMessageID({ type, properties: { sessionID: "ses_1" } })).toBeUndefined()
      expect(streamedSessionMessageID({ type: `${type}.1`, properties: { sessionID: "ses_1" } })).toBeUndefined()
      expect(
        syncedSessionMessageID({
          id: `sync_${type}`,
          type: "sync",
          syncEvent: {
            id: `event_${type}`,
            type: `${type}.1`,
            seq: 1,
            aggregateID: "ses_1",
            data: { sessionID: "ses_1" },
          },
        } as never),
      ).toBeUndefined()
    }

    for (const type of [
      "session.next.reasoning.ended",
      "session.next.text.ended",
      "session.next.step.ended",
      "session.next.activity.completed",
      "session.next.activity.failed",
    ]) {
      expect(streamedSessionMessageID({ type, properties: { sessionID: "ses_1" } })).toBe("ses_1")
      expect(streamedSessionMessageID({ type: `${type}.1`, properties: { sessionID: "ses_1" } })).toBe("ses_1")
      expect(
        syncedSessionMessageID({
          id: `sync_${type}`,
          type: "sync",
          syncEvent: {
            id: `event_${type}`,
            type: `${type}.1`,
            seq: 1,
            aggregateID: "ses_1",
            data: { sessionID: "ses_1" },
          },
        } as never),
      ).toBe("ses_1")
    }
  })

  test("streams text before ended without page refetch and reconciles the boundary once", () => {
    const sessionID = "ses_1"
    const messageID = "msg_assistant"
    const partID = `${messageID}:text_1`
    const harness = v2DeltaHarness({ [messageID]: [{ ...textPart(partID, sessionID, messageID), text: "" }] })
    const first = {
      id: "evt_text_1",
      type: "session.next.text.delta",
      data: { sessionID, assistantMessageID: messageID, textID: "text_1", delta: "Hello" },
    }
    harness.dispatch(first)
    expect((harness.store.part[messageID]?.[0] as Text).text).toBe("Hello")
    expect(harness.refreshes()).toBe(0)

    harness.dispatch(first)
    harness.dispatch({
      id: "evt_text_2",
      type: "session.next.text.delta",
      data: { sessionID, assistantMessageID: messageID, textID: "text_1", delta: " world" },
    })
    expect((harness.store.part[messageID]?.[0] as Text).text).toBe("Hello world")
    expect(harness.refreshes()).toBe(0)

    const ended = {
      id: "evt_text_end",
      type: "session.next.text.ended",
      data: { sessionID, assistantMessageID: messageID, textID: "text_1", text: "Hello world" },
    }
    harness.dispatch(ended)
    harness.dispatch({ ...ended, type: "session.next.text.ended.1" })
    expect(harness.refreshes()).toBe(1)
    expect(harness.controller.reconciled(sessionID)).toEqual([partID])
    expect(harness.controller.reconciled(sessionID)).toEqual([])

    harness.dispatch({
      id: "evt_text_late",
      type: "session.next.text.delta",
      data: { sessionID, assistantMessageID: messageID, textID: "text_1", delta: " duplicate" },
    })
    expect((harness.store.part[messageID]?.[0] as Text).text).toBe("Hello world")
  })

  test("discards an exactly projected tool-input boundary without accepting late deltas", () => {
    const sessionID = "ses_1"
    const messageID = "msg_assistant"
    const callID = "call_1"
    const harness = v2DeltaHarness({
      [messageID]: [
        {
          id: callID,
          sessionID,
          messageID,
          type: "tool",
          callID,
          tool: "read",
          state: { status: "pending", input: {}, raw: '{"path":"README.md"}' },
        } as Part,
      ],
    })
    const ended = {
      id: "evt_tool_end",
      type: "session.next.tool.input.ended",
      data: { sessionID, assistantMessageID: messageID, callID, text: '{"path":"README.md"}' },
    }

    harness.dispatch(ended)
    expect(harness.refreshes()).toBe(1)
    expect(harness.controller.discardBoundary(ended)).toBe(true)
    expect(harness.controller.reconciled(sessionID)).toEqual([])
    harness.dispatch({ ...ended, type: "session.next.tool.input.ended.1" })
    expect(harness.controller.reconciled(sessionID)).toEqual([])
    harness.dispatch({
      id: "evt_tool_late",
      type: "session.next.tool.input.delta",
      data: { sessionID, assistantMessageID: messageID, callID, delta: " late" },
    })
    const tool = harness.store.part[messageID]?.find((part) => part.id === callID)
    expect(tool?.type === "tool" ? tool.state : undefined).toMatchObject({
      status: "pending",
      raw: '{"path":"README.md"}',
    })
  })

  test("streams reasoning, tool input, and materialized compaction deltas in order", () => {
    const sessionID = "ses_1"
    const assistantMessageID = "msg_assistant"
    const compactionMessageID = "msg_compaction"
    const harness = v2DeltaHarness({
      [assistantMessageID]: [
        {
          id: "reasoning_1",
          sessionID,
          messageID: assistantMessageID,
          type: "reasoning",
          text: "",
          time: { start: 1 },
        } as Part,
        {
          id: "call_1",
          sessionID,
          messageID: assistantMessageID,
          type: "tool",
          callID: "call_1",
          tool: "shell",
          state: { status: "pending", input: {}, raw: "" },
        } as Part,
      ],
      [compactionMessageID]: [
        { ...textPart(`${compactionMessageID}:summary`, sessionID, compactionMessageID), text: "" },
      ],
    })

    harness.dispatch({
      id: "evt_reasoning_1",
      type: "session.next.reasoning.delta",
      data: { sessionID, assistantMessageID, reasoningID: "reasoning_1", delta: "think" },
    })
    harness.dispatch({
      id: "evt_reasoning_2",
      type: "session.next.reasoning.delta",
      data: { sessionID, assistantMessageID, reasoningID: "reasoning_1", delta: " more" },
    })
    harness.dispatch({
      id: "evt_tool_1",
      type: "session.next.tool.input.delta",
      data: { sessionID, assistantMessageID, callID: "call_1", delta: '{"path"' },
    })
    harness.dispatch({
      id: "evt_tool_2",
      type: "session.next.tool.input.delta",
      data: { sessionID, assistantMessageID, callID: "call_1", delta: ':"README.md"}' },
    })
    harness.dispatch({
      id: "evt_compaction_1",
      type: "session.next.compaction.delta",
      data: { sessionID, messageID: compactionMessageID, text: "summary" },
    })

    const reasoning = harness.store.part[assistantMessageID]?.find((part) => part.id === "reasoning_1")
    const tool = harness.store.part[assistantMessageID]?.find((part) => part.id === "call_1")
    expect(reasoning?.type === "reasoning" ? reasoning.text : undefined).toBe("think more")
    expect(tool?.type === "tool" && tool.state.status === "pending" ? tool.state.raw : undefined).toBe(
      '{"path":"README.md"}',
    )
    expect((harness.store.part[compactionMessageID]?.[0] as Text).text).toBe("summary")
    expect(harness.refreshes()).toBe(0)
  })

  test("does not invent mismatched parts and coalesces the missing-part fallback", () => {
    const harness = v2DeltaHarness({
      msg_assistant: [{ ...textPart("msg_assistant:text_1", "ses_other", "msg_assistant"), text: "" }],
    })
    harness.dispatch({
      id: "evt_missing_1",
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", textID: "text_1", delta: "one" },
    })
    harness.dispatch({
      id: "evt_missing_2",
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", textID: "text_1", delta: "two" },
    })
    expect((harness.store.part.msg_assistant?.[0] as Text).text).toBe("")
    expect(harness.store.part.msg_assistant?.[0]?.sessionID).toBe("ses_other")
    expect(harness.refreshes()).toBe(1)

    harness.store.part.msg_assistant = [
      { ...textPart("msg_assistant:text_1", "ses_1", "msg_assistant"), text: "one" },
    ]
    harness.materialize("ses_1")
    expect((harness.store.part.msg_assistant[0] as Text).text).toBe("onetwo")
    harness.materialize("ses_1")
    expect((harness.store.part.msg_assistant[0] as Text).text).toBe("onetwo")

    const complete = v2DeltaHarness({})
    complete.dispatch({
      id: "evt_complete_1",
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", textID: "text_1", delta: "one" },
    })
    complete.dispatch({
      id: "evt_complete_2",
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", textID: "text_1", delta: "two" },
    })
    complete.store.part.msg_assistant = [
      { ...textPart("msg_assistant:text_1", "ses_1", "msg_assistant"), text: "onetwo" },
    ]
    complete.materialize("ses_1")
    expect((complete.store.part.msg_assistant[0] as Text).text).toBe("onetwo")
  })

  test("reconciles activity lifecycle from the durable sync stream", () => {
    expect(
      syncedSessionLifecycleStatus({
        id: "sync_1",
        type: "sync",
        syncEvent: {
          id: "event_1",
          type: "session.next.activity.started.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { timestamp: 1, sessionID: "ses_1", activityID: "activity_1", kind: "prompt" },
        },
      }),
    ).toEqual({
      sessionID: "ses_1",
      activityID: "activity_1",
      evidence: { timestamp: 1, eventID: "event_1", sequence: 1 },
      status: { type: "busy" },
    })
    expect(
      syncedSessionLifecycleStatus({
        id: "sync_2",
        type: "sync",
        syncEvent: {
          id: "event_2",
          type: "session.next.activity.completed.1",
          seq: 2,
          aggregateID: "ses_1",
          data: { timestamp: 2, sessionID: "ses_1", activityID: "activity_1" },
        },
      }),
    ).toEqual({
      sessionID: "ses_1",
      activityID: "activity_1",
      evidence: { timestamp: 2, eventID: "event_2", sequence: 2 },
      status: { type: "idle" },
    })
  })

  test("uses compatible fallback ordering evidence when lifecycle timestamps are missing", () => {
    expect(
      syncedSessionLifecycleStatus({
        id: "sync_missing_timestamp",
        type: "sync",
        syncEvent: {
          id: "event_0001",
          type: "session.next.activity.started.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { sessionID: "ses_1", activityID: "activity_a", kind: "prompt" } as never,
        },
      }),
    ).toMatchObject({ evidence: { timestamp: 0, eventID: "event_0001", sequence: 1 } })
    expect(
      streamedSessionLifecycleStatus({
        id: "event_0002",
        type: "session.next.activity.completed",
        properties: { sessionID: "ses_1", activityID: "activity_b" },
      }),
    ).toMatchObject({ evidence: { timestamp: 0, eventID: "event_0002" } })
  })

  test("reconciles every terminal activity lifecycle from the live stream", () => {
    for (const type of [
      "session.next.activity.completed",
      "session.next.activity.failed",
      "session.next.activity.interrupted",
    ]) {
      expect(
        streamedSessionLifecycleStatus({
          id: `event_${type}`,
          type,
          properties: { timestamp: 2, sessionID: "ses_1", activityID: "activity_1" },
        }),
      ).toEqual({
        sessionID: "ses_1",
        activityID: "activity_1",
        evidence: { timestamp: 2, eventID: `event_${type}` },
        status: { type: "idle" },
      })
    }
    expect(
      streamedSessionLifecycleStatus({
        id: "event_started",
        type: "session.next.activity.started",
        properties: { timestamp: 1, sessionID: "ses_1", activityID: "activity_1" },
      }),
    ).toEqual({
      sessionID: "ses_1",
      activityID: "activity_1",
      evidence: { timestamp: 1, eventID: "event_started" },
      status: { type: "busy" },
    })
  })

  test("reconciles versioned live activity lifecycle events", () => {
    expect(
      streamedSessionLifecycleStatus({
        id: "event_started",
        type: "session.next.activity.started.1",
        properties: { timestamp: 1, sessionID: "ses_1", activityID: "activity_1" },
      }),
    ).toEqual({
      sessionID: "ses_1",
      activityID: "activity_1",
      evidence: { timestamp: 1, eventID: "event_started" },
      status: { type: "busy" },
    })
    expect(
      streamedSessionLifecycleStatus({
        id: "event_completed",
        type: "session.next.activity.completed.2",
        properties: { timestamp: 2, sessionID: "ses_1", activityID: "activity_1" },
      }),
    ).toEqual({
      sessionID: "ses_1",
      activityID: "activity_1",
      evidence: { timestamp: 2, eventID: "event_completed" },
      status: { type: "idle" },
    })
  })

  test("applies terminal lifecycle state to an inactive session without opening it", () => {
    const directory = "/repo"
    const sessionID = "ses_inactive"
    const [store, setStore] = createStore({
      path: { directory },
      session: [],
      session_status: { [sessionID]: { type: "busy" as const } },
      message: {},
      part: {},
      part_text_accum_delta: {},
    })
    let listener: ((event: Parameters<typeof syncedSessionLifecycleStatus>[0]) => void) | undefined
    const serverSync = {
      child: () => [store, setStore],
      data: { project: [] },
      todo: { get: () => undefined, set: () => {} },
      mcp: { toggle: () => {} },
    }
    const serverSDK = {
      scope: "inactive-session-lifecycle",
      server: undefined,
      createClient: () => ({}),
      sync: {
        on: (_directory: string, next: typeof listener) => {
          listener = next
          return () => {}
        },
      },
      event: { on: () => () => {} },
    }
    let dispose = () => {}
    createRoot((cleanup) => {
      dispose = cleanup
      createDirSyncContext(directory, serverSync as never, serverSDK as never)
    })

    listener?.({
      id: "sync_terminal",
      type: "sync",
      syncEvent: {
        id: "event_terminal",
        type: "session.next.activity.completed.1",
        seq: 2,
        aggregateID: sessionID,
        data: { timestamp: 2, sessionID, activityID: "activity_1" },
      },
    })

    expect(store.session_status[sessionID]?.type as SessionStatus["type"]).toBe("idle")
    dispose()
  })

  test("extracts removed message ids from durable revert cleanup", () => {
    expect(
      syncedSessionRevertCleanup({
        directory: "/repo",
        payload: { type: "sync" },
        syncEvent: {
          type: "session.next.revert.cleaned.1",
          id: "evt_revert",
          seq: 4,
          aggregateID: "session-1",
          data: { sessionID: "session-1", messageIDs: ["msg_user", "msg_assistant"] },
        },
      } as never),
    ).toEqual({ sessionID: "session-1", messageIDs: ["msg_user", "msg_assistant"] })
  })

  test("extracts removed message ids from the live revert cleanup stream", () => {
    expect(
      streamedSessionRevertCleanup({
        type: "session.next.revert.cleaned.2",
        properties: {
          sessionID: "session-1",
          messageIDs: ["msg_user", "msg_assistant", 42],
        },
      }),
    ).toEqual({ sessionID: "session-1", messageIDs: ["msg_user", "msg_assistant"] })
  })

  test("ignores unrelated or mismatched lifecycle envelopes", () => {
    expect(
      syncedSessionLifecycleStatus({
        id: "sync_1",
        type: "sync",
        syncEvent: {
          id: "event_1",
          type: "session.next.activity.completed.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { timestamp: 1, sessionID: "ses_other", activityID: "activity_1" },
        },
      }),
    ).toBeUndefined()
    expect(
      syncedSessionLifecycleStatus({
        id: "sync_2",
        type: "sync",
        syncEvent: {
          id: "event_2",
          type: "session.next.text.ended.1",
          seq: 2,
          aggregateID: "ses_1",
          data: { timestamp: 2, sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1", text: "done" },
        },
      }),
    ).toBeUndefined()
  })

  test("uses session next sync envelopes as canonical message invalidations", () => {
    expect(
      syncedSessionMessageID({
        id: "sync_1",
        type: "sync",
        syncEvent: {
          id: "event_1",
          type: "session.next.text.ended.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { timestamp: 1, sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1", text: "done" },
        },
      }),
    ).toBe("ses_1")
    expect(
      syncedSessionMessageID({
        id: "sync_2",
        type: "sync",
        syncEvent: {
          id: "event_2",
          type: "session.next.text.ended.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { timestamp: 1, sessionID: "ses_other", assistantMessageID: "msg_1", textID: "text_1", text: "done" },
        },
      }),
    ).toBeUndefined()
    expect(
      syncedSessionMessageID({
        id: "sync_3",
        type: "sync",
        syncEvent: {
          id: "event_3",
          type: "session.next.activity.started.1",
          seq: 1,
          aggregateID: "ses_1",
          data: { timestamp: 1, sessionID: "ses_1", activityID: "activity_1", kind: "prompt" },
        },
      }),
    ).toBeUndefined()
    expect(
      syncedSessionMessageID({
        id: "sync_4",
        type: "sync",
        syncEvent: {
          id: "event_4",
          type: "session.next.text.ended.1",
          seq: 2,
          aggregateID: "ses_1",
          data: {
            timestamp: 2,
            sessionID: "ses_1",
            assistantMessageID: "msg_1",
            textID: "text_1",
            text: "done",
          },
        },
      }),
    ).toBe("ses_1")
  })

  test("keeps legacy history while adding newer v2-only errors", () => {
    const sessionID = "ses_1"
    const legacy: AdaptedMessagePage = {
      cursor: "older",
      complete: false,
      session: [userMessage("msg_1", sessionID), assistantMessage("msg_2", sessionID, "msg_1")],
      part: [
        { id: "msg_1", part: [textPart("part_1", sessionID, "msg_1")] },
        { id: "msg_2", part: [textPart("part_2", sessionID, "msg_2")] },
      ],
    }
    const v2OnlyError: AdaptedMessagePage = {
      complete: true,
      session: [userMessage("msg_3", sessionID), assistantMessage("msg_4", sessionID, "msg_3")],
      part: [
        { id: "msg_3", part: [textPart("part_3", sessionID, "msg_3")] },
        { id: "msg_4", part: [textPart("part_4", sessionID, "msg_4")] },
      ],
    }

    const merged = mergeAdaptedMessagePages(legacy, v2OnlyError)

    expect(merged.cursor).toBe("older")
    expect(merged.complete).toBe(false)
    expect(merged.session.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect(merged.part.map((item) => item.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
  })

  test("checks legacy history when a v2 first page is visibly incomplete", () => {
    expect(shouldOverlayLegacyHistory({ requested: 25, adapted: 2 })).toBe(true)
    expect(shouldOverlayLegacyHistory({ requested: 80, adapted: 2 })).toBe(true)
    expect(shouldOverlayLegacyHistory({ mode: "prepend", requested: 80, adapted: 2 })).toBe(false)
    expect(shouldOverlayLegacyHistory({ requested: 2, adapted: 2 })).toBe(false)
    expect(shouldOverlayLegacyHistory({ requested: 214, adapted: 202, lookbehind: 12 })).toBe(false)
    expect(shouldOverlayLegacyHistory({ requested: 338, adapted: 200, lookbehind: 12, source: "v2" })).toBe(false)
  })

  test("does not reuse shallow incomplete session caches", () => {
    expect(
      shouldUseCachedSessionMessages({
        messageLoaded: true,
        limit: 2,
        complete: false,
        minLimit: 25,
      }),
    ).toBe(false)

    expect(
      shouldUseCachedSessionMessages({
        messageLoaded: true,
        limit: 2,
        complete: true,
        minLimit: 25,
      }),
    ).toBe(true)
  })

  test("serves cached pages to opened sessions whose status is not known yet", () => {
    expect(shouldServeCachedSessionMessages({ cached: true })).toBe(true)
    expect(shouldServeCachedSessionMessages({ cached: true, status: "idle" })).toBe(true)
    expect(shouldServeCachedSessionMessages({ cached: true, status: "busy" })).toBe(false)
    expect(shouldServeCachedSessionMessages({ cached: true, status: "retry" })).toBe(false)
    expect(shouldServeCachedSessionMessages({ cached: true, status: "waiting_for_user" })).toBe(false)
    expect(shouldServeCachedSessionMessages({ cached: true, activity: "busy" })).toBe(false)
    expect(shouldServeCachedSessionMessages({ cached: true, status: "idle", activity: "busy" })).toBe(false)
    expect(shouldServeCachedSessionMessages({ cached: false, status: "idle" })).toBe(false)
  })

  test("reloads shallow session caches with at least the initial page size", () => {
    expect(nextSessionMessageLimit({ limit: 2, minLimit: 25, maxLimit: 200 })).toBe(25)
    expect(nextSessionMessageLimit({ limit: 80, minLimit: 25, maxLimit: 200 })).toBe(80)
    expect(nextSessionMessageLimit({ limit: 300, minLimit: 25, maxLimit: 200 })).toBe(200)
    expect(nextSessionMessageLimit({ limit: 600, minLimit: 25, maxLimit: 600 })).toBe(600)
  })

  test("caps v2 read limits after adding lookbehind", () => {
    expect(nextSessionMessageReadLimit({ limit: 25, lookbehind: 12 })).toBe(37)
    expect(nextSessionMessageReadLimit({ limit: 200, lookbehind: 12 })).toBe(200)
    expect(nextSessionMessageReadLimit({ limit: 600, lookbehind: 12 })).toBe(200)
  })

  test("merges cached messages when replace snapshots would reduce visible history", () => {
    expect(shouldMergeCachedSessionMessages({ mode: "replace", status: "idle", cached: 80, incoming: 25 })).toBe(true)
    expect(shouldMergeCachedSessionMessages({ mode: "replace", status: "busy", cached: 25, incoming: 25 })).toBe(true)
    expect(shouldMergeCachedSessionMessages({ mode: "prepend", status: "idle", cached: 25, incoming: 25 })).toBe(true)
    expect(shouldMergeCachedSessionMessages({ mode: "replace", status: "idle", cached: 25, incoming: 80 })).toBe(false)
  })

  test("pages real legacy messages without relying on v2 limit cursors", () => {
    const sessionID = "ses_1"
    const legacy = [
      userMessage("msg_1", sessionID),
      assistantMessage("msg_2", sessionID, "msg_1"),
      userMessage("msg_3", sessionID),
      assistantMessage("msg_4", sessionID, "msg_3"),
      userMessage("msg_5", sessionID),
    ].map((message, index) => legacyMessage({ ...message, time: { created: index + 1 } }))

    const first = pageLegacyMessages(legacy, { limit: 2 })
    const older = pageLegacyMessages(legacy, { limit: 2, cursor: first.cursor })

    expect(first.session.map((message) => message.id)).toEqual(["msg_4", "msg_5"])
    expect(first.cursor).toBe("msg_4")
    expect(first.complete).toBe(false)
    expect(older.session.map((message) => message.id)).toEqual(["msg_2", "msg_3"])
    expect(older.cursor).toBe("msg_2")
    expect(older.complete).toBe(false)
  })

  test("pages more than 200 mixed-generation legacy messages by chronology with ID-sorted output", () => {
    const sessionID = "ses_1"
    const messageIDs = Array.from({ length: 205 }, (_, index) =>
      index === 0 ? "msg_z_old" : `msg_a_${String(index).padStart(3, "0")}`,
    )
    const legacy = messageIDs.map((id, index) =>
      legacyMessage(
        { ...userMessage(id, sessionID), time: { created: index + 1 } },
        [textPart(`${id}:z`, sessionID, id), textPart(`${id}:A`, sessionID, id)],
      ),
    )

    const first = pageLegacyMessages(legacy, { limit: 200 })
    const older = pageLegacyMessages(legacy, { limit: 200, cursor: first.cursor })
    const firstIDs = messageIDs.slice(5).sort()
    const olderIDs = messageIDs.slice(0, 5).sort()
    const pagedIDs = [...older.session, ...first.session].map((message) => message.id)

    expect(first.session.map((message) => message.id)).toEqual(firstIDs)
    expect(first.part.map((item) => item.id)).toEqual(firstIDs)
    expect(first.part.map((item) => item.part.map((part) => part.id))).toEqual(
      firstIDs.map((id) => [`${id}:A`, `${id}:z`]),
    )
    expect(first.cursor).toBe(messageIDs[5])
    expect(first.complete).toBe(false)
    expect(older.session.map((message) => message.id)).toEqual(olderIDs)
    expect(older.part.map((item) => item.id)).toEqual(olderIDs)
    expect(older.cursor).toBeUndefined()
    expect(older.complete).toBe(true)
    expect(new Set(pagedIDs).size).toBe(messageIDs.length)
    expect(pagedIDs.slice().sort()).toEqual(messageIDs.slice().sort())
  })

  test("uses the binary ID tie-break at legacy page boundaries", () => {
    const sessionID = "ses_1"
    const legacy = ["msg_a", "msg_-", "msg_Z"].map((id) =>
      legacyMessage({ ...userMessage(id, sessionID), time: { created: 10 } }),
    )

    const first = pageLegacyMessages(legacy, { limit: 2 })
    const older = pageLegacyMessages(legacy, { limit: 2, cursor: first.cursor })

    expect(first.session.map((message) => message.id)).toEqual(["msg_Z", "msg_a"])
    expect(first.part.map((item) => item.id)).toEqual(["msg_Z", "msg_a"])
    expect(first.cursor).toBe("msg_Z")
    expect(older.session.map((message) => message.id)).toEqual(["msg_-"])
    expect(older.complete).toBe(true)
  })

  test("uses server legacy pagination cursor instead of deriving it from a partial response", () => {
    const sessionID = "ses_1"
    const page = pageLegacyMessageResponse(
      [userMessage("msg_4", sessionID), userMessage("msg_5", sessionID)].map((message) => legacyMessage(message)),
      { limit: 2, cursor: "server-cursor" },
    )

    expect(page.session.map((message) => message.id)).toEqual(["msg_4", "msg_5"])
    expect(page.cursor).toBe("server-cursor")
    expect(page.complete).toBe(false)
  })

  test("detects wrapped invalid v2 cursors", () => {
    expect(
      isInvalidCursorError(
        new Error("Invalid cursor", {
          cause: { status: 400, body: { _tag: "InvalidCursorError", message: "Invalid cursor" } },
        }),
      ),
    ).toBe(true)
    expect(isInvalidCursorError(new Error("Invalid cursor", { cause: { status: 500 } }))).toBe(false)
  })

  test("refreshes a known legacy replace page through the first cached overlap", async () => {
    const calls: { limit: number; cursor?: string }[] = []
    const result = await loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_0100", "msg_0101"],
      history: { cursor: "cached-older", complete: false },
      read: async (input) => {
        calls.push(input)
        return adaptedPage(["msg_0101", "msg_0102"], { cursor: "server-next" })
      },
    })

    expect(calls).toEqual([{ limit: 25, cursor: undefined }])
    expect(result.mergeCached).toBe(true)
    expect(result.pages).toBe(1)
    expect(result.page.cursor).toBe("cached-older")
    expect(result.page.complete).toBe(false)
    expect(result.page.session.map((message) => message.id)).toEqual(["msg_0101", "msg_0102"])
  })

  test("closes a legacy refresh gap larger than 200 messages", async () => {
    const id = (value: number) => `msg_${value.toString().padStart(4, "0")}`
    const pages = [
      adaptedPage(Array.from({ length: 25 }, (_, index) => id(236 + index)), { cursor: "page-2" }),
      adaptedPage(Array.from({ length: 50 }, (_, index) => id(186 + index)), { cursor: "page-3" }),
      adaptedPage(Array.from({ length: 100 }, (_, index) => id(86 + index)), { cursor: "page-4" }),
      adaptedPage([id(0), ...Array.from({ length: 85 }, (_, index) => id(1 + index))], { cursor: "older" }),
    ]
    const calls: { limit: number; cursor?: string }[] = []
    const result = await loadAdaptiveLegacyRefresh({
      cachedIDs: [id(0)],
      history: { cursor: "cached-older", complete: false },
      read: async (input) => {
        calls.push(input)
        return pages[calls.length - 1]!
      },
    })

    expect(calls).toEqual([
      { limit: 25, cursor: undefined },
      { limit: 50, cursor: "page-2" },
      { limit: 100, cursor: "page-3" },
      { limit: 200, cursor: "page-4" },
    ])
    expect(result.mergeCached).toBe(true)
    expect(result.page.cursor).toBe("cached-older")
    expect(result.page.complete).toBe(false)
    expect(result.page.session).toHaveLength(261)
    expect(result.page.part).toHaveLength(261)
    expect(result.page.session.map((message) => message.id)).toEqual(
      Array.from({ length: 261 }, (_, index) => id(index)),
    )
  })

  test("replaces a stale legacy cache when the complete server history has no overlap", async () => {
    const pages = [adaptedPage(["msg_0003"], { cursor: "page-2" }), adaptedPage(["msg_0001", "msg_0002"])]
    const result = await loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_stale"],
      history: { cursor: "cached-older", complete: false },
      read: async () => pages.shift()!,
    })

    expect(result.mergeCached).toBe(false)
    expect(result.pages).toBe(2)
    expect(result.page.cursor).toBeUndefined()
    expect(result.page.complete).toBe(true)
    expect(result.page.session.map((message) => message.id)).toEqual(["msg_0001", "msg_0002", "msg_0003"])
  })

  test("preserves complete cached history metadata after an overlapping refresh", async () => {
    const result = await loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_0001"],
      history: { complete: true },
      read: async () => adaptedPage(["msg_0001", "msg_0002"], { cursor: "server-next" }),
    })

    expect(result.page.cursor).toBeUndefined()
    expect(result.page.complete).toBe(true)
  })

  test("rejects a repeated legacy refresh cursor instead of recursing forever", async () => {
    let calls = 0
    const result = loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_cached"],
      history: { cursor: "cached-older", complete: false },
      read: async () => {
        calls++
        return adaptedPage([`msg_new_${calls}`], { cursor: "same-cursor" })
      },
    })

    await expect(result).rejects.toThrow("Legacy message refresh cursor repeated")
    expect(calls).toBe(2)
  })

  test("rejects an A to B to A legacy refresh cursor cycle", async () => {
    const cursors = ["cursor-a", "cursor-b", "cursor-a"]
    let calls = 0
    const result = loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_cached"],
      history: { cursor: "cached-older", complete: false },
      read: async () => {
        const cursor = cursors[calls]
        calls++
        return adaptedPage([`msg_new_${calls}`], { cursor })
      },
    })

    await expect(result).rejects.toThrow("Legacy message refresh cursor repeated")
    expect(calls).toBe(3)
  })

  test("stops a progressing legacy refresh at its hard page budget", async () => {
    let calls = 0
    const result = loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_cached"],
      history: { cursor: "cached-older", complete: false },
      maxPages: 3,
      read: async () => {
        calls++
        return adaptedPage([`msg_new_${calls}`], { cursor: `cursor-${calls}` })
      },
    })

    await expect(result).rejects.toThrow("Legacy message refresh exceeded 3 pages")
    expect(calls).toBe(3)
  })

  test("rejects an invalid-cursor fallback that restarts without message progress", async () => {
    let calls = 0
    const result = loadAdaptiveLegacyRefresh({
      cachedIDs: ["msg_cached"],
      history: { cursor: "cached-older", complete: false },
      read: async () => {
        calls++
        return adaptedPage(["msg_latest"], { cursor: calls === 1 ? "invalid-next" : "restarted-next" })
      },
    })

    await expect(result).rejects.toThrow("Legacy message refresh did not add messages")
    expect(calls).toBe(2)
  })

  test("keeps initial, unknown, and prepend legacy loads on the existing path", () => {
    expect(shouldLoadAdaptiveLegacyRefresh({ source: "legacy", mode: "replace", cached: 25 })).toBe(true)
    expect(shouldLoadAdaptiveLegacyRefresh({ source: "legacy", cached: 25 })).toBe(true)
    expect(shouldLoadAdaptiveLegacyRefresh({ source: "legacy", mode: "prepend", cached: 25 })).toBe(false)
    expect(shouldLoadAdaptiveLegacyRefresh({ source: "legacy", mode: "replace", cached: 0 })).toBe(false)
    expect(shouldLoadAdaptiveLegacyRefresh({ source: undefined, mode: "replace", cached: 25 })).toBe(false)
  })
})
