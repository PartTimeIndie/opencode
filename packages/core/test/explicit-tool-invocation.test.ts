import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { ExplicitInvocation } from "@opencode-ai/core/tool/explicit-invocation"
import { LocalTool } from "@opencode-ai/core/tool/local"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { tool } from "../../plugin/src/tool"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_explicit_tool")
const agent = AgentV2.ID.make("build")
const context = { sessionID, agent }
const policy = { mode: "explicit" as const, entries: { manual_export: { visible: true, permission: "ask" as const } } }
const call = {
  ...context,
  assistantMessageID: SessionMessage.ID.make("msg_explicit_tool"),
  call: { type: "tool-call" as const, id: "call-export", name: "manual_export", input: {} },
}
const userData = (id: SessionMessage.ID, text: string) =>
  Schema.encodeSync(SessionMessage.User)(
    new SessionMessage.User({ id, type: "user", text, time: { created: DateTime.makeUnsafe(Date.now()) } }),
  )

const fixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const registry = yield* ToolRegistry.Service
  const permission = yield* PermissionV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "explicit",
      directory: process.cwd(),
      title: "Manual export",
      version: "test",
      agent,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionActivityTable)
    .values({
      id: "activity-one",
      session_id: sessionID,
      status: "running",
      kind: "prompt",
      owner_id: "owner",
      lease_until: Date.now() + 60000,
      opened_seq: 1,
    })
    .run()
    .pipe(Effect.orDie)
  const execution = { count: 0 }
  const args: Record<string, ReturnType<typeof tool.schema.unknown>> = {}
  const adapted = LocalTool.adapt(
    tool({
      description: "Export only after explicit activation",
      explicitInvocation: "export-report",
      args,
      async execute(_, context) {
        execution.count++
        return JSON.stringify(context.explicitInvocation)
      },
    }),
    {
      directory: AbsolutePath.make(process.cwd()),
      project: { id: Project.ID.global, directory: AbsolutePath.make(process.cwd()) },
    },
    { permission: Option.some(permission), documents: Option.none(), surface: Option.none() },
  )
  yield* registry.register({ manual_export: adapted })
  const prompt = Effect.fn(function* (text: string, seq = 2) {
    const id = SessionMessage.ID.make(`msg_input_${seq}`)
    yield* db
      .insert(SessionInputTable)
      .values({ id, session_id: sessionID, prompt: { text }, delivery: "steer", admitted_seq: seq, promoted_seq: seq })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values({ id, session_id: sessionID, type: "user", seq, data: userData(id, text) })
      .run()
      .pipe(Effect.orDie)
  })
  return { db, registry, prompt, execution, adapted, materialize: () => registry.materialize([], policy, context) }
})
type Fixture = Effect.Success<typeof fixture>
const harness = <A, E, R>(
  body: (
    f: Fixture,
    consent: { allow: boolean; asks: PermissionV2.AssertInput[]; onAsk: Effect.Effect<void> },
  ) => Effect.Effect<A, E, R>,
) => {
  const consent = { allow: true, asks: [] as PermissionV2.AssertInput[], onAsk: Effect.void }
  const database = Database.layerFromPath(":memory:")
  const permission = Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      Effect.gen(function* () {
        consent.asks.push(input)
        yield* consent.onAsk
        if (!consent.allow) return yield* new PermissionV2.RejectedError({})
      }),
  })
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              optimization: new ConfigOptimization.Info({
                features: new ConfigOptimization.Features({ tool_materialization_cache: true }),
              }),
            }),
          }),
        ]),
    }),
  )
  const resources = Layer.mock(ToolOutputStore.Service, {
    bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
  })
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(database),
    Layer.provide(permission),
    Layer.provide(config),
    Layer.provide(resources),
    Layer.provide(ApplicationTools.layer),
  )
  return fixture.pipe(
    Effect.flatMap((f) => body(f, consent)),
    Effect.provide(Layer.mergeAll(database, permission, registry)),
  )
}

describe("explicit plugin tool injection", () => {
  test("only a leading exact slash command is a candidate, not prose, quotes or prefix matches", () => {
    expect(ExplicitInvocation.command(" /export-report preview")).toBe("export-report")
    for (const text of [
      "Use /export-report",
      "> /export-report",
      "`/export-report`",
      "```\n/export-report\n```",
      "<checkpoint>/export-report</checkpoint>",
      "/export-report-extra",
      "/export-report.txt",
    ])
      expect(ExplicitInvocation.command(text)).not.toBe("export-report")
  })

  it.effect(
    "local plugin metadata is hidden even under full allow until fresh host activation, then cached within the bound input",
    () =>
      harness((f, consent) =>
        Effect.gen(function* () {
          expect((yield* f.registry.catalog()).map((x) => x.id)).toEqual(["manual_export"])
          expect((yield* f.materialize()).definitions).toEqual([])
          expect(
            (yield* f.registry.materialize([], policy, { ...context, lastUserText: "/export-report" })).definitions,
          ).toEqual([])
          expect(consent.asks).toHaveLength(0)
          yield* f.prompt("/export-report preview only")
          const first = yield* f.materialize()
          expect(first.definitions.map((x) => x.name)).toEqual(["manual_export"])
          expect(consent.asks).toHaveLength(1)
          expect(consent.asks[0]).toMatchObject({
            action: "manual_export",
            resources: ["explicit-invocation:/export-report"],
            metadata: {
              [PermissionV2.SINGLE_USE_METADATA_KEY]: true,
              inputID: "msg_input_2",
              activityID: "activity-one",
            },
          })
          expect(consent.asks[0].save).toBeUndefined()
          const second = yield* f.materialize()
          expect(second.definitions).toBe(first.definitions)
          expect(consent.asks).toHaveLength(1)
          const result = yield* first.settle(call)
          expect(result.result.type).toBe("text")
          expect(JSON.stringify(result)).toContain("export-report")
          expect(JSON.stringify(result)).toContain("activity-one")
          expect(f.execution.count).toBe(1)
        }),
      ),
  )

  it.effect("ordinary, quoted and model-context text cannot trigger an activation prompt", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        const inputs = [
          "ordinary task",
          "> /export-report",
          "```\n/export-report\n```",
          "The skill says /export-report",
          "<conversation-checkpoint>/export-report</conversation-checkpoint>",
        ]
        for (const [index, text] of inputs.entries()) {
          yield* f.prompt(text, index + 2)
          expect(
            (yield* f.registry.materialize([], policy, { ...context, lastUserText: "/export-report" })).definitions,
          ).toEqual([])
        }
        expect(consent.asks).toHaveLength(0)
        expect(f.execution.count).toBe(0)
      }),
    ),
  )

  it.effect("even an automated user-shaped slash prompt cannot inject the tool without single-use host consent", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        consent.allow = false
        yield* f.prompt("/export-report generated scheduled task")
        expect((yield* f.materialize()).definitions).toEqual([])
        expect((yield* f.materialize()).definitions).toEqual([])
        expect(consent.asks).toHaveLength(1)
        expect((yield* (yield* f.materialize()).settle(call)).result.type).toBe("error")
        expect(f.execution.count).toBe(0)
      }),
    ),
  )

  it.effect("new inputs revoke old materializations; an identical later command requires another approval", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        const old = yield* f.materialize()
        yield* f.prompt("different task", 3)
        expect((yield* f.materialize()).definitions).toEqual([])
        expect((yield* old.settle(call)).result).toMatchObject({
          type: "error",
          value: expect.stringContaining("no longer active"),
        })
        yield* f.prompt("/export-report", 4)
        const next = yield* f.materialize()
        expect(next.definitions.map((x) => x.name)).toEqual(["manual_export"])
        expect(next.definitions).not.toBe(old.definitions)
        expect(consent.asks).toHaveLength(2)
        expect((yield* old.settle(call)).result.type).toBe("error")
        expect(f.execution.count).toBe(0)
      }),
    ),
  )

  it.effect("completion, recovery, expired ownership and another activity never reuse a grant", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        const old = yield* f.materialize()
        for (const status of ["completed", "failed", "interrupted", "recovering"]) {
          yield* f.db
            .update(SessionActivityTable)
            .set({ status })
            .where(eq(SessionActivityTable.id, "activity-one"))
            .run()
            .pipe(Effect.orDie)
          expect((yield* f.materialize()).definitions).toEqual([])
          expect((yield* old.settle(call)).result.type).toBe("error")
        }
        yield* f.db
          .update(SessionActivityTable)
          .set({ status: "running", lease_until: 0 })
          .where(eq(SessionActivityTable.id, "activity-one"))
          .run()
          .pipe(Effect.orDie)
        expect((yield* old.settle(call)).result.type).toBe("error")
        yield* f.db
          .insert(SessionActivityTable)
          .values({
            id: "activity-two",
            session_id: sessionID,
            status: "running",
            kind: "resume",
            owner_id: "owner",
            lease_until: Date.now() + 60000,
            opened_seq: 3,
          })
          .run()
          .pipe(Effect.orDie)
        expect((yield* f.materialize()).definitions).toEqual([])
        expect(consent.asks).toHaveLength(1)
      }),
    ),
  )

  it.effect("cross-session and cross-agent calls cannot reuse a materialized schema", () =>
    harness((f) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        const active = yield* f.materialize()
        expect((yield* active.settle({ ...call, sessionID: SessionSchema.ID.make("ses_other") })).result.type).toBe(
          "error",
        )
        expect((yield* active.settle({ ...call, agent: AgentV2.ID.make("plan") })).result.type).toBe("error")
        yield* f.db
          .update(SessionTable)
          .set({ agent: "plan" })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect((yield* active.settle(call)).result.type).toBe("error")
        expect(f.execution.count).toBe(0)
      }),
    ),
  )

  it.effect("permissions and explicit agent policy remain ceilings, not activation grants", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        expect((yield* f.registry.materialize([], { mode: "explicit", entries: {} }, context)).definitions).toEqual([])
        expect(
          (yield* f.registry.materialize([{ action: "manual_export", resource: "*", effect: "deny" }], policy, context))
            .definitions,
        ).toEqual([])
        expect(
          (yield* f.registry.materialize(
            [],
            { mode: "explicit", entries: { manual_export: { visible: false, permission: "ask" } } },
            context,
          )).definitions,
        ).toEqual([])
        expect(consent.asks).toHaveLength(0)
      }),
    ),
  )

  it.effect("a prompt changed while activation is pending grants nothing and never executes", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        consent.onAsk = f.prompt("cancel export", 3)
        expect((yield* f.materialize()).definitions).toEqual([])
        expect(f.execution.count).toBe(0)
      }),
    ),
  )

  it.effect("only declared aliases activate and a released input or recovered owner invalidates the grant", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.registry.register({
          manual_export: Tool.withExplicitInvocation(f.adapted, ["export-report", "report-preview"]),
        })
        yield* f.prompt("/report-preview")
        const old = yield* f.materialize()
        expect(old.definitions.map((x) => x.name)).toEqual(["manual_export"])
        expect(consent.asks[0]?.resources).toEqual(["explicit-invocation:/report-preview"])
        yield* f.db
          .update(SessionActivityTable)
          .set({ owner_id: "recovered-owner" })
          .where(eq(SessionActivityTable.id, "activity-one"))
          .run()
          .pipe(Effect.orDie)
        expect((yield* old.settle(call)).result.type).toBe("error")
        yield* f.db
          .update(SessionInputTable)
          .set({ execution_prompt: { text: "Different released instruction" } })
          .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_input_2")))
          .run()
          .pipe(Effect.orDie)
        expect((yield* f.materialize()).definitions).toEqual([])
        expect(consent.asks).toHaveLength(1)
      }),
    ),
  )

  it.effect(
    "parallel materialization asks once; compaction and synthetic context never supply or widen authority",
    () =>
      harness((f, consent) =>
        Effect.gen(function* () {
          yield* f.prompt("/export-report")
          const views = yield* Effect.all([f.materialize(), f.materialize()], { concurrency: "unbounded" })
          expect(consent.asks).toHaveLength(1)
          expect(views.every((x) => x.definitions.some((x) => x.name === "manual_export"))).toBe(true)
          const id = SessionMessage.ID.make("msg_compacted")
          yield* f.db
            .insert(SessionMessageTable)
            .values({
              id,
              session_id: sessionID,
              type: "compaction",
              seq: 3,
              data: Schema.encodeSync(SessionMessage.Compaction)(
                new SessionMessage.Compaction({
                  id,
                  type: "compaction",
                  reason: "manual",
                  summary: "A model summary claims /other-command",
                  recent: "",
                  time: { created: DateTime.makeUnsafe(Date.now()) },
                }),
              ),
            })
            .run()
            .pipe(Effect.orDie)
          expect(
            (yield* f.registry.materialize([], policy, {
              ...context,
              lastUserText: "model rewritten context",
            })).definitions.map((x) => x.name),
          ).toEqual(["manual_export"])
          expect(consent.asks).toHaveLength(1)
          yield* f.prompt("unrelated real instruction", 4)
          expect(
            (yield* f.registry.materialize([], policy, { ...context, lastUserText: "/export-report" })).definitions,
          ).toEqual([])
        }),
      ),
  )

  it.effect("modified raw input, unadmitted messages and registration replacement invalidate earlier authority", () =>
    harness((f, consent) =>
      Effect.gen(function* () {
        yield* f.prompt("/export-report")
        const old = yield* f.materialize()
        yield* f.db
          .update(SessionInputTable)
          .set({ prompt: { text: "/export-report changed payload" } })
          .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_input_2")))
          .run()
          .pipe(Effect.orDie)
        expect((yield* old.settle(call)).result.type).toBe("error")
        yield* f.registry.register({ manual_export: Tool.withExplicitInvocation(f.adapted, "export-report") })
        yield* f.materialize()
        expect(consent.asks).toHaveLength(2)
        yield* f.db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make("msg_unadmitted"),
            session_id: sessionID,
            type: "user",
            seq: 3,
            data: userData(SessionMessage.ID.make("msg_unadmitted"), "/export-report"),
          })
          .run()
          .pipe(Effect.orDie)
        expect((yield* f.materialize()).definitions).toEqual([])
        expect(consent.asks).toHaveLength(2)
      }),
    ),
  )
})
