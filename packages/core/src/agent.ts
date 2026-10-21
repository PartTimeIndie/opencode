export * as AgentV2 from "./agent"

import { Array, Context, Effect, Exit, Layer, Schema, Semaphore, Scope } from "effect"
import { castDraft, enableMapSet, type Draft } from "immer"
import { ModelV2 } from "./model"
import { PermissionSchema } from "./permission/schema"
import { ProviderV2 } from "./provider"
import { PositiveInt } from "./schema"
import { State } from "./state"

export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type
export const defaultID = ID.make("build")

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export const SystemMode = Schema.Literals(["inherit", "append", "replace"])
export const InstructionPolicy = Schema.Struct({
  mode: Schema.Literals(["inherit", "manual"]),
  files: Schema.Array(Schema.String),
})
export const ToolPolicyEntry = Schema.Struct({
  visible: Schema.Boolean,
  delegable: Schema.Boolean.pipe(Schema.optional),
  permission: Schema.Literals(["allow", "ask", "deny"]),
  scope: Schema.Struct({ mode: Schema.Literals(["global", "projects"]), projects: Schema.Array(Schema.String).pipe(Schema.optional) }).pipe(Schema.optional),
  projectPermissions: Schema.Record(Schema.String, Schema.Literals(["allow", "ask", "deny"])).pipe(Schema.optional),
})
export const ToolPolicy = Schema.Struct({
  mode: Schema.Literals(["inherit", "explicit"]),
  entries: Schema.Record(Schema.String, ToolPolicyEntry),
})
export const CompletionPolicy = Schema.Struct({
  mode: Schema.Literals(["inherit", "custom"]),
  prompt: Schema.String.pipe(Schema.optional),
})

export class Info extends Schema.Class<Info>("AgentV2.Info")({
  id: ID,
  model: ModelV2.Ref.pipe(Schema.optional),
  request: ProviderV2.Request,
  system: Schema.String.pipe(Schema.optional),
  systemMode: SystemMode.pipe(Schema.optional),
  instructions: InstructionPolicy.pipe(Schema.optional),
  tools: ToolPolicy.pipe(Schema.optional),
  completion: CompletionPolicy.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  toolBudget: Schema.Struct({
    read: PositiveInt.pipe(Schema.optional),
    grep: PositiveInt.pipe(Schema.optional),
    glob: PositiveInt.pipe(Schema.optional),
  }).pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset,
}) {
  static empty(id: ID) {
    return new Info({
      id,
      request: {
        headers: {},
        body: {},
      },
      mode: "all",
      hidden: false,
      permissions: [],
    })
  }
}

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Info>
  default?: ID
}

export type Editor = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Draft<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface {
  readonly transform: State.Interface<Data, Editor>["transform"]
  readonly update: State.Interface<Data, Editor>["update"]
  readonly invalidate?: () => void
  readonly registerRefresh?: (refresh: () => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Agent") {}

enableMapSet()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Editor>({
      initial: () => ({ agents: new Map() }),
      editor: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? castDraft(Info.empty(id))
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
    })
    const refreshLock = Semaphore.makeUnsafe(1)
    let dirty = false
    let refreshConfig: () => Effect.Effect<void> = () => Effect.void
    const refresh = () =>
      refreshLock.withPermit(
        Effect.gen(function* () {
          if (!dirty) return
          dirty = false
          const exit = yield* Effect.exit(refreshConfig())
          if (Exit.isFailure(exit)) {
            dirty = true
            return yield* Effect.failCause(exit.cause)
          }
        }),
      )
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      update: state.update,
      invalidate: () => {
        dirty = true
      },
      registerRefresh: Effect.fn("AgentV2.registerRefresh")(function* (fn) {
        const scope = yield* Scope.Scope
        refreshConfig = fn
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (refreshConfig === fn) refreshConfig = () => Effect.void
          }),
        )
      }),
      get: Effect.fn("AgentV2.get")(function* (id) {
        yield* refresh()
        return state.get().agents.get(id)
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        yield* refresh()
        return selectedDefault()
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        yield* refresh()
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        yield* refresh()
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        yield* refresh()
        return Array.fromIterable(state.get().agents.values())
      }),
    })
  }),
)

export const locationLayer = layer
