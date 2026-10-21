import { describe, expect, test } from "bun:test"
import { Usage } from "@opencode-ai/llm"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { AttachmentTable } from "@opencode-ai/core/attachment.sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provideMerge(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)
const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("refreshes updated time when session title changes", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Updated.type) {
          const info = (event.data as typeof SessionNs.Event.Updated.data.Type).info as SessionNs.Info
          if (info.title === "renamed") Deferred.doneUnsafe(received, Effect.succeed(info))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* Effect.sleep("1 millis")
      yield* session.setTitle({ sessionID: info.id, title: "renamed" })
      const updated = yield* awaitDeferred(received, "timed out waiting for session rename")

      expect(updated.time.updated).toBeGreaterThan(info.time.updated)

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("rebinds managed attachments to the forked session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const database = yield* Database.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "attachment-fork" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* database.db
        .insert(AttachmentTable)
        .values({
          id: "att_original",
          session_id: created.id,
          message_id: messageID,
          mime: "image/png",
          filename: "tiny.png",
          size_bytes: 5,
          storage_path: "content/aa/test",
          blob_sha256: "a".repeat(64),
          created_at: Date.now(),
        })
        .run()
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID,
        type: "file",
        mime: "image/png",
        filename: "tiny.png",
        url: "attachment://att_original",
      })

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const file = (yield* session.messages({ sessionID: fork.id }))[0]?.parts.find((part) => part.type === "file")
      expect(file?.type).toBe("file")
      if (!file || file.type !== "file") return
      expect(file.url).toStartWith("attachment://")
      expect(file.url).not.toBe("attachment://att_original")
      const rebound = yield* database.db
        .select()
        .from(AttachmentTable)
        .where(eq(AttachmentTable.id, file.url.slice("attachment://".length)))
        .get()
      expect(rebound).toMatchObject({
        session_id: fork.id,
        blob_sha256: "a".repeat(64),
        storage_path: "content/aa/test",
      })
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    expect(Token.estimate("x".repeat(4000))).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    expect(Token.estimate("y".repeat(20_000))).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: {
          input: 0,
          output: 15,
          cache: { read: 0, write: 0 },
        },
      }),
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000 }),
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: {
          input: 3,
          output: 15,
          cache: { read: 0.3, write: 3.75 },
        },
      }),
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 1_000_000,
        output: 32_000,
        cost: {
          input: 1,
          output: 2,
          cache: { read: 0.1, write: 0.5 },
          tiers: [
            {
              input: 3,
              output: 4,
              cache: { read: 0.3, write: 1.5 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 0.5, write: 2.5 },
              tier: { type: "context", size: 500_000 },
            },
          ],
          experimentalOver200K: {
            input: 100,
            output: 100,
            cache: { read: 100, write: 100 },
          },
        },
      }),
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 1_000_000,
        output: 32_000,
        cost: {
          input: 1,
          output: 2,
          cache: { read: 0.1, write: 0.5 },
          tiers: [
            {
              input: 5,
              output: 6,
              cache: { read: 0.5, write: 2.5 },
              tier: { type: "context", size: 500_000 },
            },
          ],
          experimentalOver200K: {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
          },
        },
      }),
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model: createModel({ context: 100_000, output: 32_000, npm }),
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model: createModel({ context: 100_000, output: 32_000, npm }),
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const result = SessionNs.getUsage({
      model: createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" }),
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
