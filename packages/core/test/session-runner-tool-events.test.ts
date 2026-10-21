import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.sync ? EventV2.versionedType(definition.type, definition.sync.version) : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: () => Effect.void,
    registerCheckpointAdapter: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    createCheckpoint: () => Effect.succeed(undefined),
    checkpoint: () => Effect.succeed(undefined),
    compactCheckpoint: () => Effect.succeed(undefined),
    replayCheckpoint: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
      cost: [],
    }),
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("step started event does not expose publisher cost input", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-cost" })))

  const started = published.find((event) => event.type === "session.next.step.started.1")
  expect(started?.data).not.toHaveProperty("cost")
})

test("coalesces burst text deltas without changing content", async () => {
  const { published, publisher } = capture()
  const chunks = Array.from({ length: 64 }, (_, index) => `${index},`)
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-burst" })))
  for (const delta of chunks)
    await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-burst", text: delta })))
  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "text-burst" })))

  const deltas = published.filter((event) => event.type === "session.next.text.delta")
  expect(deltas).toHaveLength(1)
  expect(deltas.map((event) => (event.data as { delta: string }).delta).join("")).toBe(chunks.join(""))
})

test("publishes a short text delta within the bounded window", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* publisher.publish(LLMEvent.textStart({ id: "text-window" }))
      yield* publisher.publish(LLMEvent.textDelta({ id: "text-window", text: "visible" }))
      yield* Effect.sleep("32 millis")
    }),
  )

  expect(published.find((event) => event.type === "session.next.text.delta")?.data).toMatchObject({
    delta: "visible",
  })
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.2")).toBe(true)
})

test("runner interruption publishes explicit provenance", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.failUnsettledTools("Tool execution interrupted", false, { source: "session" }),
  )

  expect(published.find((event) => event.type === "session.next.tool.failed.2")?.data).toMatchObject({
    interruption: { source: "session" },
  })
})

test("tool-error for a started but uncalled call persists the failed invocation", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call-bad", name: "write" })))
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolInputDelta({ id: "call-bad", name: "write", text: '{"content":' })),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolError({
        id: "call-bad",
        name: "write",
        message: "ProviderShared.stream: Invalid JSON input for openai-chat tool call write",
      }),
    ),
  )

  const called = published.find((event) => event.type === "session.next.tool.called.1")
  expect(called?.data).toMatchObject({ callID: "call-bad", tool: "write", input: {} })
  const failed = published.find((event) => event.type === "session.next.tool.failed.2")
  expect(failed?.data).toMatchObject({
    callID: "call-bad",
    error: { type: "unknown", message: "ProviderShared.stream: Invalid JSON input for openai-chat tool call write" },
  })
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})
