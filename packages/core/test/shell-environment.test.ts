import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { ShellEnvironment } from "@opencode-ai/core/shell-environment"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

it.live("owns exact project registrations and releases only its own callback", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.gen(function* () {
      const environment = yield* ShellEnvironment.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const request = { directory: tmp.path, cwd: path.join(tmp.path, "sub"), sessionID: SessionSchema.ID.make("ses_first"), callID: "first" }
      yield* environment.register(tmp.path, (input) => Effect.succeed({ BINDING: input.sessionID })).pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* environment.get(request)).toEqual({ BINDING: "ses_first" })
      expect(yield* environment.get({ ...request, directory: path.join(tmp.path, "foreign") })).toEqual({})
      expect(Exit.isFailure(yield* environment.register(tmp.path, () => Effect.succeed({})).pipe(Effect.exit))).toBe(true)
      yield* Scope.close(scope, Exit.void)
      expect(yield* environment.get(request)).toEqual({})
      const replacementScope = yield* Scope.fork(yield* Scope.Scope)
      yield* environment.register(tmp.path, () => Effect.succeed({ BINDING: "replacement" })).pipe(Effect.provideService(Scope.Scope, replacementScope))
      yield* Scope.close(scope, Exit.void)
      expect(yield* environment.get(request)).toEqual({ BINDING: "replacement" })
      yield* Scope.close(replacementScope, Exit.void)
      expect(yield* environment.get(request)).toEqual({})
    }).pipe(Effect.provide(ShellEnvironment.layer)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("resolves registrations and lookups to the same physical directory identity", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("node:fs/promises"))
      const linkPath = path.join(tmp.path, "linked-project")
      yield* Effect.promise(() => fs.symlink(tmp.path, linkPath, "junction"))
      const environment = yield* ShellEnvironment.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      // The plugin host registers the realpath-canonicalized directory.
      yield* environment.register(linkPath, (input) => Effect.succeed({ BINDING: input.callID })).pipe(Effect.provideService(Scope.Scope, scope))
      // A native Location keeps the link path; BashTool hands exactly this to get.
      const linkedRequest = { directory: linkPath, cwd: linkPath, sessionID: SessionSchema.ID.make("ses_link"), callID: "link-call" }
      expect(yield* environment.get(linkedRequest)).toEqual({ BINDING: "link-call" })
      // The physical project behind the link resolves to the same registration.
      expect(yield* environment.get({ ...linkedRequest, directory: tmp.path, cwd: tmp.path })).toEqual({ BINDING: "link-call" })
      // Another physical project never receives this environment.
      const other = path.join(tmp.path, "other-project")
      yield* Effect.promise(() => fs.mkdir(other))
      expect(yield* environment.get({ directory: other, cwd: other, sessionID: SessionSchema.ID.make("ses_other"), callID: "other-call" })).toEqual({})
      // Released registrations stop serving the environment through either path.
      yield* Scope.close(scope, Exit.void)
      expect(yield* environment.get(linkedRequest)).toEqual({})
      expect(yield* environment.get({ ...linkedRequest, directory: tmp.path, cwd: tmp.path })).toEqual({})
    }).pipe(Effect.provide(ShellEnvironment.layer)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("refuses a retired in-flight hook without adopting a replacement registration", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.gen(function* () {
      const environment = yield* ShellEnvironment.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const request = { directory: tmp.path, cwd: tmp.path, sessionID: SessionSchema.ID.make("ses_inflight"), callID: "inflight" }
      yield* environment.register(tmp.path, () => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)), Effect.as({ BINDING: "retired" }),
      )).pipe(Effect.provideService(Scope.Scope, scope))
      const call = yield* environment.get(request).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      yield* environment.register(tmp.path, () => Effect.succeed({ BINDING: "replacement" }))
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(call))).toBe(true)
      expect(yield* environment.get(request)).toEqual({ BINDING: "replacement" })
    }).pipe(Effect.provide(ShellEnvironment.layer)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
