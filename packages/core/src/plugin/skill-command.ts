export * as SkillCommandPlugin from "./skill-command"

import { CommandV2 } from "../command"
import { Clock, Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import { PluginV2 } from "../plugin"
import { SkillV2 } from "../skill"

export const CACHE_TTL_MS = 5_000

type Transform = (update: (editor: CommandV2.Editor) => void) => Effect.Effect<void>
type TransformRegistration = {
  transform: Transform
  scope: Scope.Scope
  active: boolean
  generation: number
  previous?: TransformRegistration
  completeAt?: number
}
type Flight = {
  deferred: Deferred.Deferred<Exit.Exit<void>, never>
  transform: TransformRegistration
  replacement: boolean
  refresh: boolean
  explicit: boolean
  refreshQueued: boolean
}
type Synchronization = {
  lock: Semaphore.Semaphore
  order: Semaphore.Semaphore
  generation: number
  pending?: Flight
  transform?: TransformRegistration
  replacements: TransformRegistration[]
  turn: Deferred.Deferred<void, never>
}

const synchronizations = new WeakMap<CommandV2.Interface, Synchronization>()

export function finishesReplacementFlight(input: {
  replacement: boolean
  transform: unknown
  flightTransform: unknown
}) {
  return !input.replacement || input.flightTransform === input.transform
}

export const sync = Effect.fn("SkillCommandPlugin.sync")(function* (options?: { refresh?: boolean }) {
  const command = yield* CommandV2.Service
  const skill = yield* SkillV2.Service
  const state = synchronization(command)
  for (;;) {
    const transform = yield* state.lock.withPermit(Effect.sync(() => state.transform))
    if (!transform) return yield* Effect.die("Skill command plugin transform is not initialized")
    if (
      !options?.refresh &&
      transform.completeAt !== undefined &&
      (yield* Clock.currentTimeMillis) - transform.completeAt < CACHE_TTL_MS
    )
      return
    if (
      yield* request(
        command,
        state,
        transform,
        skill,
        {
          refresh: options?.refresh === true || transform.completeAt !== undefined,
          explicit: options?.refresh === true,
        },
        false,
      )
    )
      return
  }
})

function synchronization(command: CommandV2.Interface): Synchronization {
  const state = synchronizations.get(command)
  if (state) return state
  const created: Synchronization = {
    lock: Semaphore.makeUnsafe(1),
    order: Semaphore.makeUnsafe(1),
    generation: 0,
    replacements: [],
    turn: Deferred.makeUnsafe<void>(),
  }
  synchronizations.set(command, created)
  return created
}

function request(
  command: CommandV2.Interface,
  state: Synchronization,
  transform: TransformRegistration,
  skill: SkillV2.Interface,
  input: { refresh: boolean; explicit: boolean },
  replacement: boolean,
) {
  return Effect.gen(function* () {
    for (;;) {
      const claimed = yield* handoff(command, state, transform, skill, input, replacement)
      if (claimed.retry) return false
      if (claimed.wait) {
        yield* Deferred.await(claimed.wait)
        continue
      }
      if (yield* awaitFlight(transform, claimed.flight, replacement)) return true
    }
  })
}

function awaitFlight(transform: TransformRegistration, flight: Flight, replacement: boolean) {
  return Effect.gen(function* () {
    const result = yield* Deferred.await(flight.deferred)
    if (result._tag === "Success")
      return finishesReplacementFlight({ replacement, transform, flightTransform: flight.transform })
    if (replacement && flight.transform !== transform && transform.active) return false
    return yield* result
  })
}

function handoff(
  command: CommandV2.Interface,
  state: Synchronization,
  transform: TransformRegistration,
  skill: SkillV2.Interface,
  input: { refresh: boolean; explicit: boolean },
  replacement: boolean,
) {
  return Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      const claimed = yield* claim(state, transform, input, replacement)
      if (!claimed.leader) return claimed
      yield* synchronizeState(command, state, claimed.flight, skill).pipe(
        Effect.forkIn(transform.scope, { startImmediately: true }),
      )
      return claimed
    }),
  )
}

function claim(
  state: Synchronization,
  transform: TransformRegistration,
  input: { refresh: boolean; explicit: boolean },
  replacement: boolean,
) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<Exit.Exit<void>>()
    return yield* state.lock.withPermit(Effect.sync(() => claimLocked(state, transform, input, replacement, deferred)))
  })
}

function claimLocked(
  state: Synchronization,
  transform: TransformRegistration,
  input: { refresh: boolean; explicit: boolean },
  replacement: boolean,
  deferred: Deferred.Deferred<Exit.Exit<void>, never>,
) {
  if (!transform.active) return { retry: true as const, leader: false as const }
  const pending = state.pending
  if (pending) {
    if (input.explicit && !pending.explicit) pending.refreshQueued = true
    return { retry: false as const, leader: false as const, flight: pending }
  }
  if (!replacement && state.transform !== transform) return { retry: true as const, leader: false as const }
  if (replacement) {
    if (state.replacements[0] !== transform) return { retry: false as const, leader: false as const, wait: state.turn }
    state.generation++
    transform.generation = state.generation
    transform.previous = state.transform
  }
  const flight: Flight = { deferred, transform, replacement, ...input, refreshQueued: false }
  state.pending = flight
  return { retry: false as const, leader: true as const, flight }
}

function synchronizeState(
  command: CommandV2.Interface,
  state: Synchronization,
  flight: Flight,
  skill: SkillV2.Interface,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* restore(
        Effect.gen(function* () {
          yield* synchronize(flight.transform.transform, skill, flight.refresh)
          const queued = yield* state.lock.withPermit(
            Effect.sync(() => {
              if (state.pending !== flight || !flight.refreshQueued) return false
              flight.refreshQueued = false
              flight.explicit = true
              return true
            }),
          )
          if (queued) yield* synchronize(flight.transform.transform, skill, true)
        }),
      ).pipe(Effect.exit)
      const now = result._tag === "Success" ? yield* Clock.currentTimeMillis : undefined
      yield* state.lock.withPermit(
        Effect.sync(() => {
          if (state.pending !== flight) return
          state.pending = undefined
          if (flight.replacement) advanceReplacement(state, flight.transform)
          if (
            result._tag === "Success" &&
            flight.transform.active &&
            flight.transform.generation >= (state.transform?.generation ?? -1)
          ) {
            flight.transform.completeAt = now
            state.transform = flight.transform
          }
          if (result._tag === "Failure" && state.transform === flight.transform) flight.transform.completeAt = undefined
          prune(state.transform)
        }),
      )
      yield* Deferred.succeed(flight.deferred, result)
    }),
  )
}

function prune(transform?: TransformRegistration) {
  let current = transform
  while (current?.previous) {
    if (current.previous.active) {
      current = current.previous
      continue
    }
    current.previous = current.previous.previous
  }
}

function advanceReplacement(state: Synchronization, transform: TransformRegistration) {
  if (state.replacements[0] !== transform) return
  state.replacements.shift()
  Deferred.doneUnsafe(state.turn, Effect.void)
  state.turn = Deferred.makeUnsafe<void>()
}

function removeReplacement(state: Synchronization, transform: TransformRegistration) {
  const index = state.replacements.indexOf(transform)
  if (index === -1) return
  state.replacements.splice(index, 1)
  if (index !== 0) return
  Deferred.doneUnsafe(state.turn, Effect.void)
  state.turn = Deferred.makeUnsafe<void>()
}

function activePredecessor(transform?: TransformRegistration) {
  let current = transform
  while (current && !current.active) current = current.previous
  return current
}

function synchronize(transform: Transform, skill: SkillV2.Interface, refresh: boolean) {
  return Effect.gen(function* () {
    const skills = yield* skill.list(refresh ? { refresh: true } : undefined)
    const names = new Set(skills.map((item) => item.name))

    yield* transform((editor) => {
      for (const item of editor.list()) {
        if (item.source !== "skill" || names.has(item.name)) continue
        editor.remove(item.name)
      }
      for (const skill of skills) {
        const current = editor.get(skill.name)
        if (current && current.source !== "skill") continue
        editor.update(skill.name, (command) => {
          // Keep the slash catalog lightweight; resolve full instructions only when the skill is invoked.
          command.template = ""
          command.description = skill.description
          command.agent = skill.agent
          command.model = skill.model ? {
            ...skill.model,
            chain: skill.model.chain ? {
              ...skill.model.chain,
              steps: skill.model.chain.steps.map((step) => ({ ...step })),
            } : undefined,
          } : undefined
          command.requiredTools = skill.requiredTools ? [...skill.requiredTools] : undefined
          command.aliases = skill.aliases ? [...skill.aliases] : undefined
          command.source = "skill"
          command.subtask = undefined
          command.hints = []
        })
        editor.resolve(skill.name, (input) =>
          Effect.succeed(input.arguments.trim() ? `${skill.content}\n\n${input.arguments}` : skill.content),
        )
      }
    })
  })
}

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("skill-command"),
  effect: Effect.gen(function* () {
    const command = yield* CommandV2.Service
    const skill = yield* SkillV2.Service
    const state = synchronization(command)
    const started = yield* state.order.withPermit(
      Effect.gen(function* () {
        const transform: TransformRegistration = {
          transform: yield* command.transform(),
          scope: yield* Scope.Scope,
          active: true,
          generation: 0,
        }
        yield* Effect.addFinalizer(() =>
          state.lock.withPermit(
            Effect.sync(() => {
              transform.active = false
              removeReplacement(state, transform)
              if (state.transform === transform) {
                state.transform = activePredecessor(transform.previous)
                prune(state.transform)
              }
            }),
          ),
        )
        const claimed = yield* Effect.uninterruptibleMask(() =>
          state.lock.withPermit(
            Effect.gen(function* () {
              state.replacements.push(transform)
              const claimed = claimLocked(
                state,
                transform,
                { refresh: true, explicit: true },
                true,
                yield* Deferred.make<Exit.Exit<void>>(),
              )
              if (claimed.retry)
                return yield* Effect.die("Skill command replacement transform became inactive during acquisition")
              if (claimed.leader)
                yield* synchronizeState(command, state, claimed.flight, skill).pipe(
                  Effect.forkIn(transform.scope, { startImmediately: true }),
                )
              return claimed
            }),
          ),
        )
        return { transform, claimed }
      }),
    )
    if (started.claimed.wait) {
      yield* Deferred.await(started.claimed.wait)
      yield* request(command, state, started.transform, skill, { refresh: true, explicit: true }, true)
      return
    }
    if (yield* awaitFlight(started.transform, started.claimed.flight, true)) return
    yield* request(command, state, started.transform, skill, { refresh: true, explicit: true }, true)
  }),
})
