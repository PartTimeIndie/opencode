import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createRoot } from "solid-js"

let groupPartsCalls = 0

mock.module("@opencode-ai/ui/message-part", () => ({
  renderable(part: { type: string; text?: string }, showReasoningSummaries = true) {
    if (part.type === "text") return !!part.text?.trim()
    if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
    return true
  },
  groupParts(refs: { messageID: string; part: { id: string } }[]) {
    groupPartsCalls += 1
    return refs.map((ref) => ({
      key: `part:${ref.messageID}:${ref.part.id}`,
      type: "part",
      ref: { messageID: ref.messageID, partID: ref.part.id },
    }))
  },
}))

const { createMessageRowCache, createTimelineProjection } = await import("./projection")

type CacheInput = Parameters<ReturnType<typeof createMessageRowCache>["rows"]>[0]

const userMessage = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
} as UserMessage

const assistantMessage = {
  id: "assistant",
  sessionID: "session",
  parentID: userMessage.id,
  role: "assistant",
  time: { created: 2 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
} as unknown as AssistantMessage

const userParts: Part[] = []
const assistantParts = [part("part")]

describe("timeline chronology", () => {
  test("orders assistant output and chooses the newest unfinished turn across mixed ID generations", () => {
    createRoot((dispose) => {
      const root = { ...userMessage, id: "msg_80daf1f1f62f000994c26e3603", time: { created: 1788418804026 } }
      const resumed = { ...userMessage, id: "msg_06d8e45f2001F5K1Hrks6Vfk9F", time: { created: 1788544435744 } }
      const old = { ...assistantMessage, id: "msg_90_old", parentID: root.id, time: { created: root.time.created + 1 } }
      const first = { ...assistantMessage, id: "msg_07_first", parentID: resumed.id, time: { created: resumed.time.created + 1 } }
      const last = { ...assistantMessage, id: "msg_06_last", parentID: resumed.id, time: { created: resumed.time.created + 2 } }
      const messages = [root, resumed, old, first, last].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const projection = createTimelineProjection({
        messages: () => messages,
        userMessages: () => [root, resumed],
        parts: () => [],
        status: () => ({ type: "busy" }),
        showReasoningSummaries: () => true,
      })

      expect(projection.assistantMessagesByParent().get(resumed.id)?.map((message) => message.id)).toEqual([first.id, last.id])
      expect(projection.activeMessageID()).toBe(resumed.id)
      dispose()
    })
  })

  test("busy fallback targets the chronologically latest user when no assistant has started", () => {
    createRoot((dispose) => {
      const root = { ...userMessage, id: "msg_80daf1f1f62f000994c26e3603", time: { created: 1788418804026 } }
      const resumed = { ...userMessage, id: "msg_06d8e45f2001F5K1Hrks6Vfk9F", time: { created: 1788544435744 } }
      const projection = createTimelineProjection({
        messages: () => [resumed, root],
        userMessages: () => [root, resumed],
        parts: () => [],
        status: () => ({ type: "busy" }),
        showReasoningSummaries: () => true,
      })

      expect(projection.activeMessageID()).toBe(resumed.id)
      dispose()
    })
  })
})

describe("createMessageRowCache", () => {
  test("reuses cached rows without reconstructing unchanged turns", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const first = cache.rows(input())
    const second = cache.rows(input())

    expect(second).toBe(first)
    expect(groupPartsCalls).toBe(1)
  })

  test("invalidates when assistant part arrays change", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const first = cache.rows(input())
    const second = cache.rows(input({ assistantParts: [[...assistantParts, part("part-2")]] }))

    expect(second).not.toBe(first)
    expect(second.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart", "AssistantPart"])
    expect(groupPartsCalls).toBe(2)
  })

  test("keeps cached rows for visible text changes", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const parts = [part("part", "first")]
    const first = cache.rows(input({ assistantParts: [parts] }))
    parts[0] = part("part", "second")
    const second = cache.rows(input({ assistantParts: [parts] }))

    expect(second).toBe(first)
    expect(groupPartsCalls).toBe(1)
  })

  test("invalidates when text becomes renderable", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const parts = [part("part", "")]
    const first = cache.rows(input({ assistantParts: [parts] }))
    parts[0] = part("part", "visible")
    const second = cache.rows(input({ assistantParts: [parts] }))

    expect(first.map((row) => row._tag)).toEqual(["UserMessage"])
    expect(second.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
    expect(groupPartsCalls).toBe(2)
  })

  test("renders an assistant failure even when no content part was emitted", () => {
    const cache = createMessageRowCache()
    const failed = {
      ...assistantMessage,
      time: { created: 2, completed: 3 },
      finish: "error",
      error: {
        name: "UnknownError",
        data: { message: "GPT-5.6 max is unavailable for the current OAuth connection" },
      },
    } as AssistantMessage

    const rows = cache.rows(input({ assistantMessages: [failed], assistantParts: [[]] }))

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "Error"])
    expect(rows[1]).toMatchObject({
      _tag: "Error",
      text: "GPT-5.6 max is unavailable for the current OAuth connection",
    })
  })

  test("invalidates when prepending changes the turn gap", () => {
    const cache = createMessageRowCache()
    const first = cache.rows(input())
    const second = cache.rows(input({ previousUserMessage: true }))

    expect(second).not.toBe(first)
    expect(second.map((row) => row._tag)).toEqual(["TurnGap", "UserMessage", "AssistantPart"])
  })

  test("invalidates when active busy state changes visible rows", () => {
    const cache = createMessageRowCache()
    const first = cache.rows(input({ assistantParts: [[]] }))
    const second = cache.rows(input({ assistantParts: [[]], active: true, status: "busy" }))

    expect(first.map((row) => row._tag)).toEqual(["UserMessage"])
    expect(second.map((row) => row._tag)).toEqual(["UserMessage", "Thinking"])
  })

  test("keeps inactive rows cached when session status changes", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const first = cache.rows(input({ status: "idle" }))
    const second = cache.rows(input({ status: "busy" }))

    expect(second).toBe(first)
    expect(groupPartsCalls).toBe(1)
  })

  test("prunes rows outside the visible user window", () => {
    groupPartsCalls = 0
    const cache = createMessageRowCache()
    const first = cache.rows(input())
    cache.prune(new Set())
    const second = cache.rows(input())

    expect(second).not.toBe(first)
    expect(groupPartsCalls).toBe(2)
  })
})

function input(overrides: Partial<CacheInput> = {}): CacheInput {
  return {
    userMessage,
    userParts,
    assistantMessages: [assistantMessage],
    assistantParts: [assistantParts],
    previousUserMessage: false,
    showReasoningSummaries: true,
    status: "idle",
    active: false,
    ...overrides,
  }
}

function part(id: string, text = id) {
  return {
    id,
    sessionID: "session",
    messageID: assistantMessage.id,
    type: "text",
    text,
  } as Part
}
