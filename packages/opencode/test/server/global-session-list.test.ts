import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

describe("session.listGlobal", () => {
  it.instance(
    "treats the global directory sentinel as an unfiltered control-plane list",
    () =>
      Effect.gen(function* () {
        const first = yield* withSession({ title: "global-sentinel-first" })
        const secondDirectory = yield* tmpdirScoped({ git: true })
        const second = yield* withSession({ title: "global-sentinel-second" }).pipe(provideInstance(secondDirectory))

        const sessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: "global", limit: 200 }),
        )
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).toContain(second.id)
      }),
    { git: true },
  )

  it.instance(
    "lists sessions across projects with project metadata",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)
        const secondProject = yield* Project.use.get(secondSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)
        const secondItem = sessions.find((session) => session.id === secondSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(secondItem?.project?.id).toBe(secondProject?.id)
        expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
        expect(first.directory).not.toBe(second)
      }),
    { git: true },
  )

  it.instance(
    "excludes archived sessions by default",
    () =>
      Effect.gen(function* () {
        const archived = yield* withSession({ title: "archived-session" })

        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).not.toContain(archived.id)

        const allSessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ limit: 200, archived: true }),
        )
        const allIds = allSessions.map((session) => session.id)

        expect(allIds).toContain(archived.id)
      }),
    { git: true },
  )

  it.instance(
    "excludes hidden sessions from lists by default",
    () =>
      Effect.gen(function* () {
        const hidden = yield* withSession({
          title: "hidden-session",
          metadata: { opencode: { hidden: true } },
        })
        const visible = yield* withSession({ title: "visible-session" })
        const session = yield* SessionNs.Service

        const projectIds = (yield* session.list({ limit: 200 })).map((item) => item.id)
        const globalIds = (yield* session.listGlobal({ limit: 200 })).map((item) => item.id)

        expect(projectIds).toContain(visible.id)
        expect(projectIds).not.toContain(hidden.id)
        expect(globalIds).toContain(visible.id)
        expect(globalIds).not.toContain(hidden.id)
        expect((yield* session.get(hidden.id)).id).toBe(hidden.id)
        expect((yield* session.list({ limit: 200, includeHidden: true })).map((item) => item.id)).toContain(hidden.id)
        expect((yield* session.listGlobal({ limit: 200, includeHidden: true })).map((item) => item.id)).toContain(
          hidden.id,
        )
      }),
    { git: true },
  )

  it.instance(
    "supports cursor pagination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const first = yield* withSession({ title: "page-one" })
        const ready = yield* Deferred.make<void>()
        yield* Deferred.succeed(ready, undefined).pipe(Effect.delay("5 millis"), Effect.forkScoped)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting between session creates")),
          }),
        )
        const second = yield* withSession({ title: "page-two" })

        const page = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 1 }),
        )
        expect(page.length).toBe(1)
        expect(page[0].id).toBe(second.id)

        const next = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 10, cursor: page[0].time.updated }),
        )
        const ids = next.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      }),
    { git: true },
  )
})
