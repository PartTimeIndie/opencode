import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAccess } from "@opencode-ai/core/session/access"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionReadTool } from "@opencode-ai/core/tool/session-read"
import { SessionSendTool } from "@opencode-ai/core/tool/session-send"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sourceID = SessionV2.ID.make("ses_session_reference_source")
const targetID = SessionV2.ID.make("ses_session_reference_target")
const targetSession = new SessionSchema.Info({
  id: targetID,
  projectID: ProjectV2.ID.make("project_session_reference"),
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  title: "Target session",
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const assertions: PermissionV2.AssertInput[] = []
const readRequests: SessionAccess.MessagesInput[] = []
const messagePages: SessionMessage.Message[][] = []
let allow = true
let sent: Parameters<SessionAccess.Interface["send"]>[0] | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.DeniedError({ rules: [] }))),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const access = Layer.succeed(
  SessionAccess.Service,
  SessionAccess.Service.of({
    get: () => Effect.succeed(targetSession),
    activity: () => Effect.succeed({ type: "idle" as const }),
    messages: (input) =>
      Effect.sync(() => {
        readRequests.push(input)
        return { messages: messagePages.shift() ?? [], hasMore: false }
      }),
    send: (input) =>
      Effect.gen(function* () {
        sent = input
        return new SessionInput.Admitted({
          admittedSeq: 1,
          id: SessionMessage.ID.make("msg_session_reference"),
          sessionID: input.sessionID,
          prompt: input.prompt,
          delivery: input.delivery,
          timeCreated: yield* DateTime.now,
        })
      }),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const read = SessionReadTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(access))
const send = SessionSendTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(access))
const it = testEffect(Layer.mergeAll(registry, permission, access, read, send))

describe("Session reference tools", () => {
  beforeEach(() => {
    assertions.length = 0
    readRequests.length = 0
    messagePages.length = 0
    allow = true
    sent = undefined
  })

  it.effect("registers separate read and send tools", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(tools)).map((tool) => tool.name).toSorted()).toEqual(["session_read", "session_send"])
    }),
  )

  it.effect("routes natural coordination requests to session_send without extra grants", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(tools)).find((tool) => tool.name === "session_send")
      expect(definition?.description).toContain("coordinate")
      expect(definition?.description).toContain("never invent or guess a Session ID")
      expect(definition?.description).toContain("provenance")
      expect(definition?.description).toContain("not a completed answer")
      expect(definition?.description).toContain("never spawn a Session")
    }),
  )

  it.effect("keeps session_read history access separate from coordination requests", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(tools)).find((tool) => tool.name === "session_read")
      expect(definition?.description).toContain("a request to communicate or coordinate alone does not authorize reading")
    }),
  )

  it.effect("documents the safe session read cursor protocol", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(tools)).find((tool) => tool.name === "session_read")
      expect(definition?.description).toContain("omit cursor entirely")
      expect(definition?.description).toContain("exact cursor object returned")
      expect(JSON.stringify(definition?.inputSchema)).toContain("Omit this field entirely on the first read")
      expect(JSON.stringify(definition?.inputSchema)).toContain('"pattern":"^msg_"')
    }),
  )

  it.effect("checks read permission before looking up the target", () =>
    Effect.gen(function* () {
      allow = false
      const tools = yield* ToolRegistry.Service
      const result = yield* executeTool(tools, {
        sessionID: sourceID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-session-read",
          name: "session_read",
          input: { session_id: targetID },
        },
      })
      expect(result).toMatchObject({ type: "error", value: expect.stringContaining("Permission denied") })
      expect(assertions).toMatchObject([{ action: "session_read", resources: [targetID], save: [targetID] }])
    }),
  )

  it.effect("omits the cursor on the first page and accepts the exact returned cursor for the next page", () =>
    Effect.gen(function* () {
      messagePages.push(
        [
          new SessionMessage.User({
            id: SessionMessage.ID.make("msg_session_reference_page_one"),
            type: "user",
            text: "First page",
            files: [],
            agents: [],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ],
        [
          new SessionMessage.User({
            id: SessionMessage.ID.make("msg_session_reference_page_two"),
            type: "user",
            text: "Second page",
            files: [],
            agents: [],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ],
      )
      const tools = yield* ToolRegistry.Service
      const first = yield* settleTool(tools, {
        sessionID: sourceID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-session-read-first-page",
          name: "session_read",
          input: { session_id: targetID },
        },
      })

      expect(readRequests[0]).toEqual({ sessionID: targetID, limit: 50, order: "desc" })
      expect(first.result.type).toBe("text")
      expect(first.output?.structured).toMatchObject({
        cursor: {
          next: { id: "msg_session_reference_page_one", direction: "next" },
        },
      })
      const nextCursor = (first.output?.structured as {
        cursor: { next?: { id: SessionMessage.ID; direction: "next" } }
      }).cursor.next
      if (!nextCursor) throw new Error("First page did not return a next cursor")

      const second = yield* settleTool(tools, {
        sessionID: sourceID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-session-read-next-page",
          name: "session_read",
          input: { session_id: targetID, cursor: nextCursor },
        },
      })

      expect(readRequests[1]).toEqual({ sessionID: targetID, limit: 50, order: "desc", cursor: nextCursor })
      expect(second.output?.structured).toMatchObject({
        cursor: {
          next: { id: "msg_session_reference_page_two", direction: "next" },
        },
      })
    }),
  )

  it.effect("rejects an invalid session_read cursor ID before accessing the session", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const result = yield* executeTool(tools, {
        sessionID: sourceID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-session-read-invalid-cursor",
          name: "session_read",
          input: { session_id: targetID, cursor: { id: "", direction: "previous" } },
        },
      })

      expect(result).toMatchObject({ type: "error", value: expect.stringContaining('Expected a string starting with "msg_"') })
      expect(readRequests).toHaveLength(0)
    }),
  )

  it.effect("sends a provenance-marked steer message by default", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      expect(
        yield* executeTool(tools, {
          sessionID: sourceID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-session-send",
            name: "session_send",
            input: { session_id: targetID, message: "Please report status" },
          },
        }),
      ).toEqual({ type: "text", value: `Sent steer message to Session ${targetID}.` })
      expect(assertions).toMatchObject([{ action: "session_send", resources: [targetID], save: [targetID] }])
      expect(sent).toMatchObject({ sessionID: targetID, delivery: "steer" })
      expect(sent?.prompt.text).toBe(`[Cross-session message from ${sourceID}]\n\nPlease report status`)
    }),
  )

  it.effect("rejects sending to the current Session before admission", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const result = yield* executeTool(tools, {
        sessionID: sourceID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-session-self",
          name: "session_send",
          input: { session_id: sourceID, message: "loop" },
        },
      })
      expect(result).toMatchObject({ type: "error", value: expect.stringContaining("current Session") })
      expect(sent).toBeUndefined()
    }),
  )
})
