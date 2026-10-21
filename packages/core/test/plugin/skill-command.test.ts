import path from "path"
import { describe, expect } from "bun:test"
import { CommandV2 } from "@opencode-ai/core/command"
import { CACHE_TTL_MS, finishesReplacementFlight, SkillCommandPlugin } from "@opencode-ai/core/plugin/skill-command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"

const initialSkills = Array.from(
  { length: 240 },
  (_, index) =>
    new SkillV2.Info({
      name: `skill-${index}`,
      description: `Skill ${index}`,
      location: AbsolutePath.make(path.resolve(`/skills/skill-${index}/SKILL.md`)),
      content: `Instructions ${index}`,
    }),
)
let skills = initialSkills
let refreshed = false
let listCalls = 0
let refreshes: boolean[] = []
let pendingList: Deferred.Deferred<SkillV2.Info[], never> | undefined
let listFailure = false
let listInterrupted = false
let listSequence: SkillV2.Info[][] = []
let failureGate: Deferred.Deferred<void, never> | undefined
const layer = CommandV2.locationLayer.pipe(
  Layer.provideMerge(
    Layer.mock(SkillV2.Service, {
      list: (options) => {
        refreshed = options?.refresh === true
        listCalls++
        refreshes.push(refreshed)
        if (listFailure) return Effect.die("Skill list failed")
        if (listInterrupted) return Effect.interrupt
        if (failureGate) return Deferred.await(failureGate).pipe(Effect.andThen(Effect.die("Skill list failed")))
        const next = listSequence.shift()
        if (next) return Effect.succeed(next)
        if (pendingList) return Deferred.await(pendingList)
        return Effect.succeed(skills)
      },
    }),
  ),
)
const it = testEffect(layer)

describe("SkillCommandPlugin.Plugin", () => {
  it.effect("does not re-claim an older replacement after a newer transform publishes", () =>
    Effect.sync(() => {
      const older = {}
      const newer = {}

      expect(finishesReplacementFlight({ replacement: true, transform: older, flightTransform: older })).toBe(true)
      expect(finishesReplacementFlight({ replacement: true, transform: older, flightTransform: newer })).toBe(false)
    }),
  )

  it.effect("publishes the complete skill catalog without duplicating named commands", () =>
    Effect.gen(function* () {
      skills = initialSkills
      refreshed = false
      listCalls = 0
      refreshes = []
      pendingList = undefined
      const command = yield* CommandV2.Service
      const transform = yield* command.transform()
      yield* transform((editor) =>
        editor.update("skill-0", (item) => {
          item.template = "Configured command wins"
          item.source = "command"
        }),
      )

      yield* SkillCommandPlugin.Plugin.effect

      const catalog = yield* command.list()
      expect(catalog).toHaveLength(240)
      expect(new Set(catalog.map((item) => item.name))).toHaveLength(240)
      expect(catalog.find((item) => item.name === "skill-0")).toMatchObject({
        template: "Configured command wins",
        source: "command",
      })
      expect(catalog.find((item) => item.name === "skill-239")).toMatchObject({
        template: "",
        source: "skill",
      })
      expect(yield* command.resolve({ name: "skill-239", arguments: "Check this flow" })).toBe(
        "Instructions 239\n\nCheck this flow",
      )
    }),
  )

  it.effect("reconciles changed skills without replacing configured commands", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      const transform = yield* command.transform()
      yield* transform((editor) =>
        editor.update("configured", (item) => {
          item.template = "Configured command"
          item.source = "command"
        }),
      )
      skills = [
        new SkillV2.Info({
          name: "changing",
          description: "Before",
          location: AbsolutePath.make(path.resolve("/skills/changing/SKILL.md")),
          content: "Before instructions",
        }),
        new SkillV2.Info({
          name: "configured",
          description: "Must not win",
          location: AbsolutePath.make(path.resolve("/skills/configured/SKILL.md")),
          content: "Skill instructions",
        }),
      ]
      yield* SkillCommandPlugin.Plugin.effect

      skills = [
        new SkillV2.Info({
          name: "added",
          description: "Added",
          location: AbsolutePath.make(path.resolve("/skills/added/SKILL.md")),
          content: "Added instructions",
        }),
      ]
      yield* SkillCommandPlugin.sync({ refresh: true })

      expect(refreshed).toBe(true)
      expect((yield* command.list()).map((item) => [item.name, item.source])).toEqual([
        ["configured", "command"],
        ["added", "skill"],
      ])
      expect(yield* command.resolve({ name: "changing", arguments: "" })).toBeUndefined()
      expect(yield* command.resolve({ name: "added", arguments: "Now" })).toBe("Added instructions\n\nNow")
      expect(yield* command.resolve({ name: "configured", arguments: "Now" })).toBe("Configured command\n\nNow")
    }),
  )

  it.effect("propagates required tools into skill commands", () =>
    Effect.gen(function* () {
      skills = [
        new SkillV2.Info({
          name: "on-demand-ui",
          description: "Build native OpenCode UIs",
          disableModelInvocation: true,
          requiredTools: ["surface"],
          aliases: ["native ui", "question popup"],
          location: AbsolutePath.make(path.resolve("/skills/on-demand-ui/SKILL.md")),
          content: "Use surface",
        }),
      ]
      const command = yield* CommandV2.Service
      yield* SkillCommandPlugin.Plugin.effect

      expect(yield* command.get("on-demand-ui")).toMatchObject({
        source: "skill",
        requiredTools: ["surface"],
        aliases: ["native ui", "question popup"],
      })
      expect(yield* command.resolve({ name: "on-demand-ui", arguments: "Now" })).toBe("Use surface\n\nNow")
    }),
  )

  it.effect("keeps a cached catalog until refresh adds and removes skills", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!, initialSkills[1]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      const command = yield* CommandV2.Service

      yield* SkillCommandPlugin.Plugin.effect
      skills = [initialSkills[1]!, initialSkills[2]!]
      yield* SkillCommandPlugin.sync()

      expect(listCalls).toBe(1)
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-0", "skill-1"])

      yield* SkillCommandPlugin.sync({ refresh: true })

      expect(listCalls).toBe(2)
      expect(refreshed).toBe(true)
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1", "skill-2"])
      expect(yield* command.resolve({ name: "skill-0", arguments: "" })).toBeUndefined()
    }),
  )

  it.effect("rediscovers skills after the bounded cache lifetime", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      const command = yield* CommandV2.Service

      yield* SkillCommandPlugin.Plugin.effect
      skills = [initialSkills[1]!]
      yield* TestClock.adjust(CACHE_TTL_MS)
      yield* SkillCommandPlugin.sync()

      expect(listCalls).toBe(2)
      expect(refreshes).toEqual([true, true])
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
    }),
  )

  it.effect("runs a queued refresh after a normal pending synchronization", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      yield* SkillCommandPlugin.Plugin.effect
      listCalls = 0
      refreshes = []
      pendingList = yield* Deferred.make<SkillV2.Info[], never>()

      yield* TestClock.adjust(CACHE_TTL_MS)
      const first = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const second = yield* SkillCommandPlugin.sync({ refresh: true }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(listCalls).toBe(1)
      yield* Deferred.succeed(pendingList, skills)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(refreshes).toEqual([true, true])
      pendingList = undefined
    }),
  )

  it.effect("keeps a refreshed catalog after the request scope closes", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      const command = yield* CommandV2.Service

      yield* SkillCommandPlugin.Plugin.effect
      skills = [initialSkills[1]!]
      yield* Effect.scoped(SkillCommandPlugin.sync({ refresh: true }))

      yield* Effect.scoped(
        Effect.gen(function* () {
          expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
          expect(yield* command.resolve({ name: "skill-1", arguments: "After scope" })).toBe(
            "Instructions 1\n\nAfter scope",
          )
        }),
      )
    }),
  )

  it.effect("replaces a closing plugin transform with a filled successor", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      const command = yield* CommandV2.Service
      const oldScope = yield* Scope.make()
      const newScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(newScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(oldScope, Exit.void))

      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(oldScope))
      skills = [initialSkills[1]!]
      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(newScope))
      yield* Scope.close(oldScope, Exit.void)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* command.resolve({ name: "skill-1", arguments: "After replacement" })).toBe(
        "Instructions 1\n\nAfter replacement",
      )

      skills = [initialSkills[2]!]
      yield* SkillCommandPlugin.sync({ refresh: true })

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-2"])
      expect(yield* command.resolve({ name: "skill-2", arguments: "Later refresh" })).toBe(
        "Instructions 2\n\nLater refresh",
      )
    }),
  )

  it.effect("cleans up a failed or interrupted plugin load before retrying", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = true
      const failedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(failedScope, Exit.void))

      expect(yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(failedScope), Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      yield* Scope.close(failedScope, Exit.void)

      listFailure = false
      yield* SkillCommandPlugin.Plugin.effect
      const command = yield* CommandV2.Service
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-0"])

      const interruptedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(interruptedScope, Exit.void))
      listInterrupted = true
      expect(yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(interruptedScope), Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      yield* Scope.close(interruptedScope, Exit.interrupt())

      listInterrupted = false
      yield* SkillCommandPlugin.Plugin.effect
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-0"])
    }),
  )

  it.effect("preserves the previous catalog when a replacement fails", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      const command = yield* CommandV2.Service
      const oldScope = yield* Scope.make()
      const failedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(failedScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(oldScope, Exit.void))

      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(oldScope))
      skills = [initialSkills[1]!]
      listFailure = true
      expect(yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(failedScope), Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      yield* Scope.close(failedScope, Exit.void)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-0"])
      expect(yield* command.resolve({ name: "skill-0", arguments: "Still available" })).toBe(
        "Instructions 0\n\nStill available",
      )
      listFailure = false
    }),
  )

  it.effect("lets a replacement win over an interleaved refresh", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      const command = yield* CommandV2.Service
      const oldScope = yield* Scope.make()
      const newScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(newScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(oldScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(oldScope))

      skills = [initialSkills[1]!]
      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      yield* TestClock.adjust(CACHE_TTL_MS)
      const running = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const replacement = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(newScope), Effect.forkScoped)
      const refresh = yield* SkillCommandPlugin.sync({ refresh: true }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      yield* Deferred.succeed(pendingList, skills)
      yield* Fiber.join(running)
      yield* Fiber.join(refresh)
      yield* Fiber.join(replacement)
      yield* Scope.close(oldScope, Exit.void)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* command.resolve({ name: "skill-1", arguments: "Replacement wins" })).toBe(
        "Instructions 1\n\nReplacement wins",
      )
      pendingList = undefined
    }),
  )

  it.effect("keeps a follower alive when the request that started a sync is cancelled", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      const command = yield* CommandV2.Service
      yield* SkillCommandPlugin.Plugin.effect

      skills = [initialSkills[1]!]
      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      yield* TestClock.adjust(CACHE_TTL_MS)
      const owner = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const follower = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(owner)
      yield* Deferred.succeed(pendingList, skills)
      yield* Fiber.join(follower)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* command.resolve({ name: "skill-1", arguments: "Follower survived" })).toBe(
        "Instructions 1\n\nFollower survived",
      )
      pendingList = undefined
    }),
  )

  it.effect("hands a claimed flight to the transform scope before cancelling its leader", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      const command = yield* CommandV2.Service
      yield* SkillCommandPlugin.Plugin.effect

      skills = [initialSkills[1]!]
      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      yield* TestClock.adjust(CACHE_TTL_MS)
      const requestScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(requestScope, Exit.void))
      yield* SkillCommandPlugin.sync().pipe(Effect.forkIn(requestScope, { startImmediately: true }))
      yield* Scope.close(requestScope, Exit.interrupt())

      expect(listCalls).toBe(2)
      const follower = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Deferred.succeed(pendingList, skills)
      yield* Fiber.join(follower)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* command.resolve({ name: "skill-1", arguments: "Handoff survived" })).toBe(
        "Instructions 1\n\nHandoff survived",
      )
      pendingList = undefined
      skills = [initialSkills[2]!]
      yield* SkillCommandPlugin.sync({ refresh: true })
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-2"])
    }),
  )

  it.effect("links concurrent replacements to the newest claimed predecessor", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      const command = yield* CommandV2.Service
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      const cScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(cScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(aScope))

      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(bScope), Effect.forkScoped)
      yield* Effect.yieldNow
      const c = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(cScope), Effect.forkScoped)
      listSequence = [[initialSkills[2]!]]
      yield* Deferred.succeed(pendingList, [initialSkills[1]!])
      yield* Fiber.join(b)
      yield* Fiber.join(c)
      pendingList = undefined

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-2"])
      yield* Scope.close(cScope, Exit.void)
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])

      skills = [initialSkills[3]!]
      yield* SkillCommandPlugin.sync({ refresh: true })
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-3"])
    }),
  )

  it.effect("serializes transform acquisition with replacement publication order", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      const actual = yield* CommandV2.Service
      const gate = yield* Deferred.make<void>()
      let transforms = 0
      const command = CommandV2.Service.of({
        ...actual,
        transform: () =>
          Effect.gen(function* () {
            const transform = yield* actual.transform()
            if (transforms++ === 1) yield* Deferred.await(gate)
            return transform
          }),
      })
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      const cScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(cScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(aScope),
        Effect.provideService(CommandV2.Service, command),
      )

      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(bScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      const c = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(cScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      expect(listCalls).toBe(1)
      listSequence = [[initialSkills[1]!], [initialSkills[2]!]]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(b)
      yield* Fiber.join(c)

      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-2"])
      yield* Scope.close(cScope, Exit.void)
      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-1"])

      skills = [initialSkills[3]!]
      yield* SkillCommandPlugin.sync({ refresh: true }).pipe(Effect.provideService(CommandV2.Service, command))
      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-3"])
    }),
  )

  it.effect("closes an acquisition-blocked scope without deadlocking the coordinator", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      const actual = yield* CommandV2.Service
      const gate = yield* Deferred.make<void>()
      let transforms = 0
      const command = CommandV2.Service.of({
        ...actual,
        transform: () =>
          Effect.gen(function* () {
            const transform = yield* actual.transform()
            if (transforms++ === 1) yield* Deferred.await(gate)
            return transform
          }),
      })
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      const retryScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(retryScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(aScope),
        Effect.provideService(CommandV2.Service, command),
      )

      const blocked = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(bScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      const closing = yield* Scope.close(bScope, Exit.interrupt()).pipe(Effect.forkScoped)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(closing)
      expect((yield* Fiber.await(blocked))._tag).toBe("Failure")

      skills = [initialSkills[1]!]
      yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(retryScope),
        Effect.provideService(CommandV2.Service, command),
      )
      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-1"])
    }),
  )

  it.effect("retains the coordinator while an active scope closes during a later acquisition", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      const actual = yield* CommandV2.Service
      const gate = yield* Deferred.make<void>()
      let transforms = 0
      const command = CommandV2.Service.of({
        ...actual,
        transform: () =>
          Effect.gen(function* () {
            const transform = yield* actual.transform()
            if (transforms++ === 1) yield* Deferred.await(gate)
            return transform
          }),
      })
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(aScope),
        Effect.provideService(CommandV2.Service, command),
      )

      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(bScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* Scope.close(aScope, Exit.void)
      listSequence = [[initialSkills[1]!]]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(b)

      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* actual.resolve({ name: "skill-1", arguments: "After orphan" })).toBe(
        "Instructions 1\n\nAfter orphan",
      )
      skills = [initialSkills[2]!]
      yield* SkillCommandPlugin.sync({ refresh: true }).pipe(Effect.provideService(CommandV2.Service, command))
      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-2"])
    }),
  )

  it.effect("keeps the coordinator while an initial failure leaves a replacement waiting", () =>
    Effect.gen(function* () {
      skills = [initialSkills[1]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      failureGate = yield* Deferred.make<void>()
      const actual = yield* CommandV2.Service
      const bAcquired = yield* Deferred.make<void>()
      const bGate = yield* Deferred.make<void>()
      let transforms = 0
      const command = CommandV2.Service.of({
        ...actual,
        transform: () =>
          Effect.gen(function* () {
            const transform = yield* actual.transform()
            if (transforms++ === 1) {
              yield* Deferred.succeed(bAcquired, undefined)
              yield* Deferred.await(bGate)
            }
            return transform
          }),
      })
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      const a = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(aScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(
        Scope.provide(bScope),
        Effect.provideService(CommandV2.Service, command),
        Effect.forkScoped,
      )
      yield* Deferred.await(bAcquired)
      yield* Deferred.succeed(bGate, undefined)
      yield* Effect.yieldNow
      expect(listCalls).toBe(1)
      const gate = failureGate!
      failureGate = undefined
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.await(a))._tag).toBe("Failure")
      yield* Fiber.join(b)

      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* actual.resolve({ name: "skill-1", arguments: "Recovered" })).toBe("Instructions 1\n\nRecovered")
      skills = [initialSkills[2]!]
      yield* SkillCommandPlugin.sync({ refresh: true }).pipe(Effect.provideService(CommandV2.Service, command))
      expect((yield* actual.list()).map((item) => item.name)).toEqual(["skill-2"])
    }),
  )

  it.effect("lets a waiting replacement recover after the initial scope closes", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      listFailure = false
      listInterrupted = false
      listSequence = []
      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      const command = yield* CommandV2.Service
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      const a = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(aScope), Effect.forkScoped)
      yield* Effect.yieldNow
      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(bScope), Effect.forkScoped)
      listSequence = [[initialSkills[1]!]]
      yield* Scope.close(aScope, Exit.interrupt())
      expect((yield* Fiber.await(a))._tag).toBe("Failure")
      yield* Fiber.join(b)
      pendingList = undefined

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
      expect(yield* command.resolve({ name: "skill-1", arguments: "After close" })).toBe(
        "Instructions 1\n\nAfter close",
      )
      skills = [initialSkills[2]!]
      yield* SkillCommandPlugin.sync({ refresh: true })
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-2"])
    }),
  )

  it.effect("preserves transform replay order after concurrent replacements follow a foreign flight", () =>
    Effect.gen(function* () {
      skills = [initialSkills[0]!]
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      listSequence = []
      const command = yield* CommandV2.Service
      const aScope = yield* Scope.make()
      const bScope = yield* Scope.make()
      const cScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(cScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(bScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(aScope, Exit.void))
      yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(aScope))

      pendingList = yield* Deferred.make<SkillV2.Info[], never>()
      yield* TestClock.adjust(CACHE_TTL_MS)
      const foreign = yield* SkillCommandPlugin.sync().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const b = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(bScope), Effect.forkScoped)
      const c = yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(cScope), Effect.forkScoped)
      listSequence = [[initialSkills[1]!], [initialSkills[2]!]]
      yield* Deferred.succeed(pendingList, [initialSkills[0]!])
      yield* Fiber.join(foreign)
      yield* Fiber.join(b)
      yield* Fiber.join(c)
      pendingList = undefined

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-2"])
      yield* Scope.close(cScope, Exit.void)
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-1"])
    }),
  )

  it.effect("prunes inactive predecessors across out-of-order plugin scope closes", () =>
    Effect.gen(function* () {
      listCalls = 0
      refreshes = []
      pendingList = undefined
      listFailure = false
      listInterrupted = false
      const command = yield* CommandV2.Service
      const scopes = [] as Scope.Closeable[]
      for (const index of Array.from({ length: 12 }, (_, index) => index)) {
        const scope = yield* Scope.make()
        scopes.push(scope)
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        skills = [initialSkills[index]!]
        yield* SkillCommandPlugin.Plugin.effect.pipe(Scope.provide(scope))
      }

      for (const index of [4, 0, 8, 2, 10, 1, 7, 3, 9, 5, 6]) yield* Scope.close(scopes[index]!, Exit.void)

      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-11"])
      skills = [initialSkills[12]!]
      yield* SkillCommandPlugin.sync({ refresh: true })
      expect((yield* command.list()).map((item) => item.name)).toEqual(["skill-12"])
    }),
  )
})
