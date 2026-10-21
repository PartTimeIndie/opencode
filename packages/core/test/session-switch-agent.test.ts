import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const interruptCalls: Array<string> = []
const waitCalls: Array<string> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resumeOrJoin: () => Effect.void,
    resume: () => Effect.void,
    queueContinuation: () => Effect.void,
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    interruptActivity: () => Effect.succeed(false),
    cancelTool: () => Effect.succeed(false),
    wait: (sessionID) =>
      Effect.sync(() => {
        waitCalls.push(sessionID)
      }),
    wake: () => Effect.void,
  }),
)
const content = Layer.succeed(
  ContentStore.Service,
  ContentStore.Service.of({
    putBlob: (input) =>
      Effect.succeed({ sha256: "0".repeat(64), mime: input.mime, path: "content", sizeBytes: input.bytes.byteLength }),
    locateBlob: () => Effect.succeed(undefined),
    readBlob: () => Effect.succeed(undefined),
    storeAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake", mime: input.mime, name: input.name })),
    storeTextAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake-text", mime: input.mime, name: input.name })),
    normalizePrompt: (input) =>
      Effect.succeed(
        new Prompt({
          ...input.prompt,
          files: input.prompt.files?.map(
            (file, index) =>
              new FileAttachment({ ...file, uri: `${ContentStore.URI_PREFIX}${input.messageID}_${index}` }),
          ),
        }),
      ),
    normalizeFiles: (input) => Effect.succeed(input.files),
    locate: () => Effect.succeed(undefined),
    resolve: () => Effect.succeed(undefined),
    materialize: (input) => Effect.succeed(input.file),
  }),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
  Layer.provide(content),
)
const it = testEffect(Layer.mergeAll(database, events, projector, store, execution, content, sessions))

const model = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") }
const switchedModel = { id: ModelV2.ID.make("next-model"), providerID: ProviderV2.ID.make("test") }
const chain = {
  id: "chain-a",
  name: "Chain A",
  active: 0,
  steps: [
    { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
    { id: ModelV2.ID.make("step-two"), providerID: ProviderV2.ID.make("test") },
  ],
}
const chainedModel = { ...model, chain }

const setup = (input?: { model?: ModelV2.Ref }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const service = yield* SessionV2.Service
    return yield* service.create({
      agent: AgentV2.ID.make("build"),
      ...(input?.model ? { model: input.model } : { model }),
      location: { directory: AbsolutePath.make("/project") },
    })
  })

const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

const agentSwitchedCount = eventCount(EventV2.versionedType(SessionEvent.AgentSwitched.type, 1))
const modelSwitchedCount = eventCount(EventV2.versionedType(SessionEvent.ModelSwitched.type, 1))
const heldInputCount = Database.Service.use(({ db }) =>
  db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)

describe("V2 Session switchAgent", () => {
  it.effect(
    "re-affirming the stored agent and model does not interrupt an in-flight turn",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup()
        const service = yield* SessionV2.Service
        // The request omits the variant; the stored record normalized it to
        // "default". That is still the same selection.
        yield* service.switchAgent({ sessionID: created.id, agent: "build", model })

        expect(interruptCalls).toEqual([])
        expect(waitCalls).toEqual([])
        expect(yield* agentSwitchedCount).toBe(0)
        expect(yield* modelSwitchedCount).toBe(0)
        expect(yield* heldInputCount).toBe(0)
      }),
  )

  it.effect(
    "re-affirming the stored agent without a model does not interrupt",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup()
        const service = yield* SessionV2.Service
        yield* service.switchAgent({ sessionID: created.id, agent: "build" })

        expect(interruptCalls).toEqual([])
        expect(waitCalls).toEqual([])
        expect(yield* agentSwitchedCount).toBe(0)
      }),
  )

  it.effect(
    "re-affirming the stored agent with the identical chain does not interrupt",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup({ model: chainedModel })
        const service = yield* SessionV2.Service
        yield* service.switchAgent({ sessionID: created.id, agent: "build", model: chainedModel })

        expect(interruptCalls).toEqual([])
        expect(waitCalls).toEqual([])
        expect(yield* agentSwitchedCount).toBe(0)
        expect(yield* modelSwitchedCount).toBe(0)
      }),
  )

  it.effect(
    "a bare same-active-model request keeps the stored chain without interrupt",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup({ model: chainedModel })
        const service = yield* SessionV2.Service
        // The composer re-affirmation sends the active model without a chain;
        // the override contract resolves it onto the stored chain, so this is
        // not a chain change and must not interrupt the turn.
        yield* service.switchAgent({
          sessionID: created.id,
          agent: "build",
          model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
        })

        expect(interruptCalls).toEqual([])
        expect(waitCalls).toEqual([])
        expect(yield* agentSwitchedCount).toBe(0)
        expect(yield* modelSwitchedCount).toBe(0)
      }),
  )

  it.effect(
    "a real variant change on the same chain stays a real switch",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup({ model: chainedModel })
        const service = yield* SessionV2.Service
        yield* service.switchAgent({
          sessionID: created.id,
          agent: "build",
          model: {
            id: ModelV2.ID.make("test-model"),
            providerID: ProviderV2.ID.make("test"),
            variant: ModelV2.VariantID.make("high"),
            chain: chainedModel.chain,
          },
        })

        expect(interruptCalls).toEqual([created.id])
        expect(waitCalls).toEqual([created.id])
        expect(yield* agentSwitchedCount).toBe(1)
        expect(yield* modelSwitchedCount).toBe(1)
      }),
  )

  it.effect(
    "a real chain change on the same active model stays a real switch",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup({ model: chainedModel })
        const service = yield* SessionV2.Service
        const otherChain = {
          id: "chain-b",
          name: "Chain B",
          active: 0,
          steps: [{ id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") }],
        }
        yield* service.switchAgent({
          sessionID: created.id,
          agent: "build",
          model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"), chain: otherChain },
        })

        expect(interruptCalls).toEqual([created.id])
        expect(waitCalls).toEqual([created.id])
        expect(yield* agentSwitchedCount).toBe(1)
        expect(yield* modelSwitchedCount).toBe(1)
      }),
  )

  it.effect(
    "a real agent change interrupts, waits, and records the switch",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup()
        const service = yield* SessionV2.Service
        yield* service.switchAgent({ sessionID: created.id, agent: "plan" })

        expect(interruptCalls).toEqual([created.id])
        expect(waitCalls).toEqual([created.id])
        expect(yield* agentSwitchedCount).toBe(1)
      }),
  )

  it.effect(
    "a real model change on the same agent still interrupts and records the model",
    () =>
      Effect.gen(function* () {
        interruptCalls.length = 0
        waitCalls.length = 0
        const created = yield* setup()
        const service = yield* SessionV2.Service
        yield* service.switchAgent({ sessionID: created.id, agent: "build", model: switchedModel })

        expect(interruptCalls).toEqual([created.id])
        expect(waitCalls).toEqual([created.id])
        expect(yield* agentSwitchedCount).toBe(1)
        expect(yield* modelSwitchedCount).toBe(1)
      }),
  )
})
