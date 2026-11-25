import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { eq } from "drizzle-orm"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.effect("shares renewal decisions without converting a refusal into consent", () =>
    Effect.gen(function* () {
      for (const decision of [true, false]) {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<boolean>()
        let calls = 0
        const renewal = Effect.gen(function* () {
          calls++
          yield* Deferred.succeed(entered, undefined)
          return yield* Deferred.await(release)
        })
        const owner = yield* SkillTool.sharedRenewal(`decision-${decision}`, renewal).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const follower = yield* SkillTool.sharedRenewal(`decision-${decision}`, renewal).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, decision)
        expect(yield* Fiber.join(owner)).toBe(decision)
        expect(yield* Fiber.join(follower)).toBe(decision)
        expect(calls).toBe(1)
      }
    }),
  )

  it.effect("releases interrupted renewal claims without granting waiting loads", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const renewal = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      const owner = yield* SkillTool.sharedRenewal("interrupted", renewal).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const follower = yield* SkillTool.sharedRenewal("interrupted", Effect.succeed(true)).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(owner)
      expect(yield* Fiber.join(follower)).toBe(false)
      expect(yield* SkillTool.sharedRenewal("interrupted", Effect.succeed(true))).toBe(true)
      expect(yield* SkillTool.sharedRenewal("failed", Effect.fail(new Error("host unavailable")))).toBe(false)
    }),
  )

  it.live("lists available skills, authorizes the selected name, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: PermissionV2.AssertInput[] = []
          let deny = false
          let bootWaited = false
          const boot = Layer.succeed(
            PluginBoot.Service,
            PluginBoot.Service.of({
              wait: () =>
                Effect.sync(() => {
                  bootWaited = true
                }),
              refreshMcpCommands: () => Effect.void,
            }),
          )
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              materializationRules: () => Effect.succeed([]),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const database = Database.layerFromPath(":memory:")
          const groupConfig = {
            enabled: true,
            groups: [{ id: "media", title: "Media", description: "Media production" }],
          }
          let groupAgent = new AgentV2.Info(AgentV2.Info.empty(toolIdentity.agent))
          const tool = SkillTool.layer.pipe(
            Layer.provide(Layer.mock(AgentV2.Service, { get: () => Effect.succeed(groupAgent) })),
            Layer.provide(
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({ type: "document", info: new Config.Info({ skill_groups: groupConfig }) }),
                    ]),
                }),
              ),
            ),
            Layer.provide(database),
            Layer.provide(registry),
            Layer.provide(permission),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(boot),
            Layer.provide(skills),
          )
          const layer = Layer.mergeAll(database, permission, skills, registry, boot, tool)

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect(bootWaited).toBe(true)
            expect((yield* toolDefinitions(registry))[0].inputSchema).toMatchObject({
              type: "object",
              properties: { name: { type: "string" }, group: { type: "string" } },
            })
            expect((yield* toolDefinitions(registry))[0].inputSchema).not.toHaveProperty("anyOf")
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(
              `Base directory for this skill: ${pathToFileURL(directory).href}`,
            )
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: { structured: { name: "effect" } },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const flat = new SkillV2.Info({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })

            const db = (yield* Database.Service).db
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "skill",
                directory: tmp.path,
                title: "Skill",
                version: "test",
                agent: "build",
              })
              .run()
              .pipe(Effect.orDie)
            const encode = (message: SessionMessage.Message) => {
              const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
              return data
            }
            const userID = SessionMessage.ID.make("msg_skill_manual_user")
            const messages = [
              new SessionMessage.User({
                id: userID,
                type: "user",
                text: "Do not load manual skills",
                files: [],
                agents: [],
                time: { created: DateTime.makeUnsafe(0) },
              }),
              new SessionMessage.Assistant({
                id: toolIdentity.assistantMessageID,
                type: "assistant",
                agent: "build",
                model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
                content: [],
                time: { created: DateTime.makeUnsafe(1) },
              }),
              new SessionMessage.User({
                id: SessionMessage.ID.make("msg_skill_later_user"),
                type: "user",
                text: "/public",
                files: [],
                agents: [],
                time: { created: DateTime.makeUnsafe(2) },
              }),
            ]
            yield* db
              .insert(SessionMessageTable)
              .values(
                messages.map((message, seq) => {
                  const encoded = encode(message)
                  return { id: message.id, type: message.type, session_id: sessionID, seq, data: encoded }
                }),
              )
              .run()
              .pipe(Effect.orDie)
            yield* db.insert(SessionInputTable).values({ id: userID, session_id: sessionID, prompt: { text: "Do not load manual skills" }, delivery: "steer", origin: "interactive", admitted_seq: 0, promoted_seq: 0 }).run().pipe(Effect.orDie)
            current = [new SkillV2.Info({ ...flat, disableModelInvocation: true, aliases: ["manual-alias"] })]
            const invoke = (id: string) =>
              executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "skill", input: { name: "public" } },
              })
            const assertionCount = assertions.length
            // A later user slash cannot retroactively authorize this call.
            expect(yield* invoke("call-manual-implicit")).toEqual({
              type: "error",
              value: "Skill public requires an explicit /public invocation",
            })
            expect(assertions).toHaveLength(assertionCount)
            for (const text of [
              "/public check",
              "/manual-alias check",
              "Please use /public for this check",
              "Bitte prüfen\n\n/other\n\n/manual-alias",
            ]) {
              yield* db
                .update(SessionMessageTable)
                .set({
                  data: encode(new SessionMessage.User({ ...messages[0], type: "user", text, files: [], agents: [] })),
                })
                .where(eq(SessionMessageTable.id, userID))
                .run()
                .pipe(Effect.orDie)
              yield* db.update(SessionInputTable).set({ prompt: { text } }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
              expect(yield* invoke("call-manual-explicit")).toEqual({
                type: "text",
                value: SkillTool.toModelOutput(current[0]!, []),
              })
            }
            yield* db.update(SessionInputTable).set({ origin: "plugin" }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            expect(yield* invoke("call-manual-plugin")).toEqual({ type: "error", value: "Skill public requires an explicit /public invocation" })
            yield* db.update(SessionInputTable).set({ origin: null }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            expect(yield* invoke("call-manual-unattested")).toEqual({ type: "error", value: "Skill public requires an explicit /public invocation" })
            yield* db.update(SessionInputTable).set({ origin: "interactive" }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            deny = true
            expect(yield* invoke("call-manual-denied")).toEqual({ type: "error", value: "Unable to load skill public" })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                assistantMessageID: SessionMessage.ID.make("msg_missing"),
                call: { type: "tool-call", id: "call-manual-no-source", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "error", value: "Skill public requires an explicit /public invocation" })
            deny = false
            current = ["image", "video", "audio"].map(
              (name) =>
                new SkillV2.Info({
                  ...flat,
                  name,
                  groups: ["media"],
                  description:
                    "Specialized media workflow with controlled input, correct dependencies and verified output for " +
                    name,
                  content: "BODY MUST NOT LEAK",
                }),
            )
            const expand = (skillGroupOutputs?: ReadonlyArray<string>, policy?: AgentV2.Info["tools"]) =>
              registry.materialize(undefined, policy).pipe(
                Effect.flatMap((materialized) =>
                  materialized.settle({
                    sessionID,
                    ...toolIdentity,
                    skillGroupOutputs,
                    call: { type: "tool-call", id: "group-call", name: "skill", input: { group: "media" } },
                  }),
                ),
                Effect.map((settlement) => settlement.result),
              )
            const full = SkillCatalog.expand(SkillCatalog.project(current, groupConfig), "media")!
            expect(yield* expand()).toEqual({ type: "text", value: full })
            expect(full).not.toContain("BODY MUST NOT LEAK")
            const groupPart = new SessionMessage.AssistantTool({
              type: "tool",
              name: "skill",
              id: "previous-group",
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { group: "media" },
                outputPaths: [],
                structured: {},
                content: [{ type: "text", text: full }],
              }),
              time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
            })
            const persist = (content: SessionMessage.AssistantTool[]) =>
              db
                .update(SessionMessageTable)
                .set({
                  data: encode(
                    new SessionMessage.Assistant({
                      ...messages[1],
                      type: "assistant",
                      agent: "build",
                      model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
                      content,
                      time: { created: DateTime.makeUnsafe(1) },
                    }),
                  ),
                })
                .where(eq(SessionMessageTable.id, toolIdentity.assistantMessageID))
                .run()
                .pipe(Effect.orDie)
            yield* persist([groupPart])
            expect(yield* expand()).toEqual({ type: "text", value: full })
            expect(yield* expand([full])).toEqual({ type: "text", value: expect.stringContaining("already present") })
            yield* persist([])
            expect(yield* expand()).toEqual({ type: "text", value: full })
            yield* persist([
              new SessionMessage.AssistantTool({
                ...groupPart,
                time: { ...groupPart.time, pruned: DateTime.makeUnsafe(2) },
              }),
            ])
            expect(yield* expand()).toEqual({ type: "text", value: full })
            current = current.map((item, index) =>
              index === 0 ? new SkillV2.Info({ ...item, requiredTools: ["probe"] }) : item,
            )
            const restricted: AgentV2.Info["tools"] = {
              mode: "explicit",
              entries: { skill: { visible: true, permission: "allow" } },
            }
            expect(yield* expand(undefined, restricted)).toEqual({ type: "error", value: "Unable to load skill media" })
            expect(
              yield* expand(undefined, {
                ...restricted,
                entries: { ...restricted.entries, probe: { visible: true, permission: "allow" } },
              }),
            ).toMatchObject({ type: "text", value: expect.stringContaining("<skill_group") })
            expect(yield* expand(undefined, restricted)).toEqual({ type: "error", value: "Unable to load skill media" })
            groupAgent = new AgentV2.Info({
              ...groupAgent,
              permissions: [{ action: "skill", resource: "audio", effect: "deny" }],
            })
            expect(yield* expand()).toEqual({ type: "error", value: "Unable to load skill media" })
          }).pipe(Effect.provide(layer))
        }),
      ),
    ),
  )

  it.live("resolves effective invocation policy for hidden allow, ask consent and deny", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mk = (name: string, extra: Partial<SkillV2.Info> = {}): SkillV2.Info => ({
            name,
            description: `Guidance for ${name}`,
            location: AbsolutePath.make(path.join(tmp.path, `${name}.md`)),
            content: `Instructions for ${name}`,
            ...extra,
          })
          let current: SkillV2.Info[] = [
            mk("hidden-allow", { disableModelInvocation: true }),
            mk("asked"),
            mk("blocked"),
          ]
          let groupAgent = new AgentV2.Info(AgentV2.Info.empty(toolIdentity.agent))
          const invocationConfig = {
            entries: {
              "hidden-allow": { visible: false, invocation: "allow" as const },
              asked: { invocation: "ask" as const },
              blocked: { invocation: "deny" as const },
            },
          }
          const assertions: PermissionV2.AssertInput[] = []
          const boot = Layer.succeed(
            PluginBoot.Service,
            PluginBoot.Service.of({ wait: () => Effect.void, refreshMcpCommands: () => Effect.void }),
          )
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) => Effect.sync(() => assertions.push(input)),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              materializationRules: () => Effect.succeed([]),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
          const database = Database.layerFromPath(":memory:")
          const tool = SkillTool.layer.pipe(
            Layer.provide(Layer.mock(AgentV2.Service, { get: () => Effect.succeed(groupAgent) })),
            Layer.provide(
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({ skill_invocation: invocationConfig }),
                      }),
                    ]),
                }),
              ),
            ),
            Layer.provide(database),
            Layer.provide(registry),
            Layer.provide(permission),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(boot),
            Layer.provide(skills),
          )
          const layer = Layer.mergeAll(database, permission, skills, registry, boot, tool)

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const db = (yield* Database.Service).db
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "policy",
                directory: tmp.path,
                title: "Policy",
                version: "test",
                agent: "build",
              })
              .run()
              .pipe(Effect.orDie)
            const encode = (message: SessionMessage.Message) => {
              const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
              return data
            }
            const userID = SessionMessage.ID.make("msg_policy_user")
            const userMessage = (text: string) =>
              new SessionMessage.User({
                id: userID,
                type: "user",
                text,
                files: [],
                agents: [],
                time: { created: DateTime.makeUnsafe(0) },
              })
            yield* db
              .insert(SessionMessageTable)
              .values([
                {
                  id: userID,
                  type: "user",
                  session_id: sessionID,
                  seq: 0,
                  data: encode(userMessage("Check the repository state")),
                },
                {
                  id: toolIdentity.assistantMessageID,
                  type: "assistant",
                  session_id: sessionID,
                  seq: 1,
                  data: encode(
                    new SessionMessage.Assistant({
                      id: toolIdentity.assistantMessageID,
                      type: "assistant",
                      agent: "build",
                      model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test", providerID: "test" }),
                      content: [],
                      time: { created: DateTime.makeUnsafe(1) },
                    }),
                  ),
                },
              ])
              .onConflictDoUpdate({ target: SessionMessageTable.id, set: { data: encode(userMessage("Check the repository state")) } })
              .run()
              .pipe(Effect.orDie)
            yield* db.insert(SessionInputTable).values({ id: userID, session_id: sessionID, prompt: { text: "Check the repository state" }, delivery: "steer", origin: "interactive", admitted_seq: 0, promoted_seq: 0 }).run().pipe(Effect.orDie)
            const writeUser = (text: string) => Effect.gen(function* () {
              yield* db
                .update(SessionMessageTable)
                .set({ data: encode(userMessage(text)) })
                .where(eq(SessionMessageTable.id, userID))
                .run()
                .pipe(Effect.orDie)
              yield* db.update(SessionInputTable).set({ prompt: { text } }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            })

            const invoke = (id: string, name: string) =>
              executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "skill", input: { name } },
              })

            // Hidden + allow: model self-load without any selection, no extra ask layer.
            expect(yield* invoke("call-hidden-allow", "hidden-allow")).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(current[0]!, []),
            })
            expect(assertions.at(-1)).toMatchObject({ action: "skill", resources: ["hidden-allow"] })
            expect(assertions.at(-1)?.extraRules).toBeUndefined()

            // Ask without selection: the extra ask rule travels with the assert.
            expect(yield* invoke("call-asked-unselected", "asked")).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(current[1]!, []),
            })
            expect(assertions.at(-1)?.extraRules).toEqual([{ action: "skill", resource: "asked", effect: "ask" }])

            // Deny blocks even an anchored selection, before any permission assert.
            yield* writeUser("/blocked please")
            const beforeDeny = assertions.length
            expect(yield* invoke("call-blocked", "blocked")).toEqual({
              type: "error",
              value: "Skill blocked is blocked by configuration (invocation: deny)",
            })
            expect(assertions).toHaveLength(beforeDeny)

            // Ask with an authentic anchored selection: no extra ask layer.
            yield* writeUser("Please /asked this")
            expect(yield* invoke("call-asked-selected", "asked")).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(current[1]!, []),
            })
            expect(assertions.at(-1)?.extraRules).toBeUndefined()

            yield* db.update(SessionInputTable).set({ origin: "plugin" }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            yield* invoke("call-asked-plugin", "asked")
            expect(assertions.at(-1)?.extraRules).toEqual([{ action: "skill", resource: "asked", effect: "ask" }])
            yield* db.update(SessionInputTable).set({ origin: "interactive", prompt: { text: "different text" } }).where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
            yield* invoke("call-asked-mismatched-input", "asked")
            expect(assertions.at(-1)?.extraRules).toEqual([{ action: "skill", resource: "asked", effect: "ask" }])
            yield* writeUser("Please /asked this")

            // A per-agent override replaces the global mode.
            groupAgent = new AgentV2.Info({
              ...groupAgent,
              skills: { asked: { invocation: "allow" } },
            })
            yield* writeUser("Check the repository state")
            expect(yield* invoke("call-asked-agent-allow", "asked")).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(current[1]!, []),
            })
            expect(assertions.at(-1)?.extraRules).toBeUndefined()
          }).pipe(Effect.provide(layer))
        }),
      ),
    ),
  )
})
