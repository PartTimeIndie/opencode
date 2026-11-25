import { describe, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Config } from "@opencode-ai/core/config"
import { ConfigFileWriter } from "@opencode-ai/core/config/file-writer"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { DelegationPreferences } from "@opencode-ai/core/session/delegation-preferences"
import { DelegationSettings } from "@opencode-ai/core/session/delegation-settings"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DelegationPreferencesTool } from "@opencode-ai/core/tool/delegation-preferences"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { it } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_preferences_tool")

describe("native delegation preferences tool", () => {
  it.live("registers and shares permission, Session CAS and versioned JSONC writes", () =>
    Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
      const assertions: PermissionV2.AssertInput[] = []
      const state = { deny: false, refreshes: 0 }
      const permission = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
        assert: (input) => Effect.suspend(() => {
          assertions.push(input)
          return state.deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void
        }),
        ask: () => Effect.die("unused"), reply: () => Effect.die("unused"),
        materializationRules: () => Effect.succeed([]), get: () => Effect.die("unused"),
        forSession: () => Effect.die("unused"), list: () => Effect.die("unused"),
      }))
      const database = Database.layerFromPath(":memory:")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
      const global = Global.layerWith({ config: path.join(tmp.path, "config"), state: path.join(tmp.path, "state") })
      const writer = ConfigFileWriter.layer.pipe(Layer.provide(EffectFlock.layer.pipe(
        Layer.provide(global), Layer.provide(FSUtil.defaultLayer),
      )))
      const location = Layer.succeed(Location.Service, Location.Service.of({
        directory: AbsolutePath.make(tmp.path), project: { id: Project.ID.global, directory: AbsolutePath.make(tmp.path) },
      }))
      const config = Layer.succeed(Config.Service, Config.Service.of({ entries: (input) => Effect.sync(() => {
        if (input?.refresh) state.refreshes++
        return []
      }) }))
      const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
      const dependencies = Layer.mergeAll(database, events, store, projector, global, writer, location, config, registry, permission)
      const settings = DelegationSettings.layer.pipe(Layer.provide(dependencies))
      const tool = DelegationPreferencesTool.layer.pipe(Layer.provide(settings), Layer.provide(dependencies))
      const call = (input: typeof DelegationPreferencesTool.Input.Type) => ({ sessionID, ...toolIdentity,
        call: { type: "tool-call" as const, id: "preferences-call", name: DelegationPreferencesTool.name, input } })
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] }).run()
        yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global,
          slug: "preferences", directory: tmp.path, title: "Preferences", version: "test" }).run()
        const registry = yield* ToolRegistry.Service
        const store = yield* SessionStore.Service
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([DelegationPreferencesTool.name])
        const initial = yield* settleTool(registry, call({ operation: "get" }))
        expect(initial.output?.structured).toEqual({ scope: "session", revision: 0, value: {} })
        const saved = yield* settleTool(registry, call({ operation: "patch", expectedRevision: 0, patch: { ordinaryQuestions: false } }))
        expect(saved.output?.structured).toEqual({ scope: "session", revision: 1, value: { ordinaryQuestions: false } })
        expect(yield* executeTool(registry, call({ operation: "patch", expectedRevision: 0, patch: { ordinaryQuestions: true } }))).toEqual({
          type: "error", value: "Delegation preferences changed: expected revision 0, current revision 1; read the current scope before saving again",
        })
        state.deny = true
        expect((yield* executeTool(registry, call({ operation: "patch", expectedRevision: 1, patch: { ordinaryQuestions: true } }))).type).toBe("error")
        state.deny = false
        expect((yield* store.get(sessionID))?.metadata?.[DelegationPreferences.METADATA_KEY]).toMatchObject({ revision: 1, session: { ordinaryQuestions: false } })
        expect((yield* executeTool(registry, call({ operation: "get", taskID: sessionID }))).type).toBe("error")
        expect((yield* executeTool(registry, call({ operation: "get", scope: "task", taskID: sessionID }))).type).toBe("error")
        const childID = SessionV2.ID.make("ses_preferences_mirror_child")
        yield* db.insert(SessionTable).values({ id: childID, parent_id: sessionID, project_id: Project.ID.global,
          slug: "mirror", directory: path.join(tmp.path, "private-mirror"), title: "Mirror child", version: "test",
          agent_policy: { source: { type: "task", sessionID, agent: toolIdentity.agent }, tools: { mode: "inherit", entries: {} }, permissionLayers: [] },
        }).run()
        expect((yield* settleTool(registry, call({ operation: "patch", scope: "task", taskID: childID,
          expectedRevision: 1, patch: { ordinaryQuestions: true } }))).output?.structured)
          .toEqual({ scope: "task", taskID: childID, revision: 2, value: { ordinaryQuestions: true } })
        expect((yield* executeTool(registry, { ...call({ operation: "patch", scope: "global",
          expectedVersion: "0".repeat(64), patch: { ordinaryQuestions: true } }), sessionID: childID })).type).toBe("error")
        yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode"), { recursive: true }))
        const file = path.join(tmp.path, ".opencode", "opencode.json")
        yield* Effect.promise(() => fs.writeFile(file, '// retained comment\n{ "future": 42 }\n'))
        const before = yield* ConfigFileWriter.Service.use((writer) => writer.read(file))
        const project = yield* settleTool(registry, call({ operation: "patch", scope: "project", expectedVersion: before.version, patch: { ordinaryQuestions: true } }))
        expect(project.output?.structured).toMatchObject({ scope: "project", value: { ordinaryQuestions: true }, changed: true })
        expect(state.refreshes).toBe(1)
        const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(text).toContain("// retained comment")
        expect(text).toContain('"future": 42')
        expect((yield* executeTool(registry, call({ operation: "patch", scope: "project", expectedVersion: before.version, patch: { ordinaryQuestions: false } }))).type).toBe("error")
        expect(state.refreshes).toBe(1)
        expect(assertions).toContainEqual(expect.objectContaining({ action: DelegationPreferencesTool.name, resources: [`session:${sessionID}`] }))
        const snapshot = yield* ConfigFileWriter.Service.use((writer) => writer.read(file))
        const drift = yield* DelegationSettings.Service.use((settings) => settings.patch(sessionID,
          { scope: "project", expectedVersion: snapshot.version, patch: { ordinaryQuestions: false } },
          () => db.update(SessionTable).set({ directory: path.join(tmp.path, "moved") })
            .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie, Effect.asVoid),
        )).pipe(Effect.exit)
        expect(Exit.isFailure(drift)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(text)
      }).pipe(Effect.provide(Layer.mergeAll(dependencies, settings, tool)))
    }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())),
  )
})
