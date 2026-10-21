export * as PluginV2 from "./plugin"

import { createDraft, finishDraft, type Draft } from "immer"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderRequestProfile } from "@opencode-ai/plugin/provider"
import type { NativeModelIntegration } from "@opencode-ai/plugin/native"
import type {
  GenerationOptionsFields,
  Message,
  Model,
  ProviderOptions,
  ToolDefinition,
  ToolOutput,
  ToolResultValue,
} from "@opencode-ai/llm"
import { Cause, Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import type { ModelV2 } from "./model"
import type { Catalog } from "./catalog"
import { EventV2 } from "./event"
import { KeyedMutex } from "./effect/keyed-mutex"
import type { SessionSchema } from "./session/schema"

export const ID = Schema.String.pipe(Schema.brand("Plugin.ID"))
export type ID = typeof ID.Type

export const Event = {
  Added: EventV2.define({
    type: "plugin.added",
    schema: {
      id: ID,
    },
  }),
}

type HookSpec = {
  "catalog.transform": {
    input: Catalog.Editor
    output: {}
  }
  "aisdk.language": {
    input: {
      model: ModelV2.Info
      sdk: any
      options: Record<string, any>
    }
    output: {
      language?: LanguageModelV3
    }
  }
  "aisdk.sdk": {
    input: {
      model: ModelV2.Info
      package: string
      options: Record<string, any>
    }
    output: {
      sdk?: any
    }
  }
  "experimental.chat.system.transform": {
    input: {
      sessionID?: SessionSchema.ID
      model: Model
    }
    output: {
      system: string[]
    }
  }
  "experimental.chat.messages.transform": {
    input: {
      sessionID: SessionSchema.ID
      agent: string
      model: Model
      provider: { id: string }
      message?: unknown
    }
    output: {
      messages: Message[]
    }
  }
  "chat.params": {
    input: {
      sessionID: SessionSchema.ID
      agent: string
      model: Model
      provider: { id: string }
      message?: unknown
    }
    output: GenerationOptionsFields & {
      maxOutputTokens?: number
      options: Record<string, unknown> | ProviderOptions
    }
  }
  "chat.headers": {
    input: {
      sessionID: SessionSchema.ID
      agent: string
      model: Model
      provider: { id: string }
      message?: unknown
    }
    output: {
      headers: Record<string, string>
    }
  }
  "tool.definition": {
    input: {
      toolID: string
    }
    output: {
      description: string
      parameters: ToolDefinition["inputSchema"]
      inputSchema?: ToolDefinition["inputSchema"]
      outputSchema?: ToolDefinition["outputSchema"]
      cache?: ToolDefinition["cache"]
      metadata?: ToolDefinition["metadata"]
      native?: ToolDefinition["native"]
    }
  }
  "tool.execute.before": {
    input: {
      tool: string
      sessionID: SessionSchema.ID
      callID: string
    }
    output: {
      args: unknown
    }
  }
  "tool.execute.after": {
    input: {
      tool: string
      sessionID: SessionSchema.ID
      callID: string
      args: unknown
    }
    output: {
      result: ToolResultValue
      output?: ToolOutput
      outputPaths?: ReadonlyArray<string>
    }
  }
}

const optionalOutputFields = {
  "aisdk.language": ["language"],
  "aisdk.sdk": ["sdk"],
} satisfies Partial<{
  [Name in keyof HookSpec]: Array<Extract<keyof HookSpec[Name]["output"], string>>
}>

const propagatedHookFailures = new Set<keyof HookSpec>(["aisdk.language", "aisdk.sdk"])

export type Hooks = {
  [Name in keyof HookSpec]: Readonly<HookSpec[Name]["input"]> & {
    -readonly [Field in keyof HookSpec[Name]["output"]]: MutableOutput<HookSpec[Name]["output"][Field]>
  }
}

type MutableOutput<Value> = Value extends ReadonlyArray<infer Item>
  ? Item[]
  : Value extends object
    ? Draft<Value>
    : Value

export type HookFunctions = {
  [key in keyof Hooks]?: (input: Hooks[key]) => Effect.Effect<void>
}

export type HookInput<Name extends keyof Hooks> = HookSpec[Name]["input"]
export type HookOutput<Name extends keyof Hooks> = HookSpec[Name]["output"]

export type Effect<R = never> = Effect.Effect<HookFunctions | void, never, R | Scope.Scope>

export function define<R>(input: { id: ID; requestProfiles?: Readonly<Record<string, ProviderRequestProfile>>; nativeModels?: Readonly<Record<string, NativeModelIntegration>>; effect: Effect.Effect<HookFunctions | void, never, R> }) {
  return input
}

export interface Interface {
  readonly add: (input: {
    id: ID
    requestProfiles?: Readonly<Record<string, ProviderRequestProfile>>
    nativeModels?: Readonly<Record<string, NativeModelIntegration>>
    effect: Effect.Effect<void | HookFunctions, never, Scope.Scope>
  }) => Effect.Effect<void, never, never>
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly generation: () => Effect.Effect<number>
  readonly requestProfiles: () => Readonly<Record<string, ProviderRequestProfile>>
  readonly nativeModels: () => Readonly<Record<string, NativeModelIntegration>>
  readonly triggerFor: <Name extends keyof Hooks>(
    id: ID,
    name: Name,
    input: HookInput<Name>,
    output: HookOutput<Name>,
  ) => Effect.Effect<HookInput<Name> & HookOutput<Name>>
  readonly trigger: <Name extends keyof Hooks>(
    name: Name,
    input: HookInput<Name>,
    output: HookOutput<Name>,
  ) => Effect.Effect<HookInput<Name> & HookOutput<Name>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Plugin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let hooks: {
      id: ID
      hooks: HookFunctions
      scope: Scope.Closeable
      requestProfiles: Readonly<Record<string, ProviderRequestProfile>>
      nativeModels: Readonly<Record<string, NativeModelIntegration>>
    }[] = []
    let generation = 0
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const locks = KeyedMutex.makeUnsafe<ID>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { hooks = [] }))

    const svc = Service.of({
      requestProfiles: () => Object.freeze(Object.fromEntries(hooks.flatMap((entry) => Object.entries(entry.requestProfiles)))),
      nativeModels: () => Object.freeze(Object.fromEntries(hooks.flatMap((entry) => Object.entries(entry.nativeModels)))),
      add: Effect.fn("Plugin.add")(function* (input) {
        yield* locks.withLock(input.id)(
          Effect.gen(function* () {
            const existing = hooks.find((item) => item.id === input.id)
            const requestProfiles = Object.freeze(Object.fromEntries(Object.entries(input.requestProfiles ?? {}).map(([packageID, profile]) => {
              if (!packageID.trim() || !profile || typeof profile.namespace !== "string" || !profile.namespace.trim() ||
                !profile.semantics || typeof profile.semantics !== "object" || Array.isArray(profile.semantics) ||
                Object.entries(profile.semantics).some(([key, value]) => !key.trim() || typeof value !== "string" || !value.trim()))
                throw new Error(`Plugin ${input.id} has an invalid request profile for ${packageID}`)
              return [packageID, Object.freeze({ namespace: profile.namespace, semantics: Object.freeze({ ...profile.semantics }) })]
            })))
            const nativeModels = Object.freeze(Object.fromEntries(Object.entries(input.nativeModels ?? {}).map(([packageID, integration]) => {
              if (!packageID.trim() || !integration || typeof integration.resolve !== "function" ||
                (integration.smallModels !== undefined && typeof integration.smallModels !== "function"))
                throw new Error(`Plugin ${input.id} has an invalid native integration for ${packageID}`)
              return [packageID, Object.freeze({ resolve: integration.resolve, smallModels: integration.smallModels })]
            })))
            const findConflict = () => hooks.find((entry) => entry.id !== input.id && (
              Object.keys(requestProfiles).some((key) => Object.hasOwn(entry.requestProfiles, key)) ||
              Object.keys(nativeModels).some((key) => Object.hasOwn(entry.nativeModels, key))
            ))
            const preflight = findConflict()
            if (preflight) return yield* Effect.die(new Error(`Plugin ${input.id} request profile conflicts with ${preflight.id}`))
            const childScope = yield* Scope.fork(scope)
            const result = yield* input.effect.pipe(
              Scope.provide(childScope),
              Effect.withSpan("Plugin.load", {
                attributes: {
                  "plugin.id": input.id,
                },
              }),
              Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(childScope, exit) : Effect.void)),
            )
            const conflict = findConflict()
            if (conflict) {
              yield* Scope.close(childScope, Exit.void)
              return yield* Effect.die(new Error(`Plugin ${input.id} request profile conflicts with ${conflict.id}`))
            }
            hooks = [
              ...hooks.filter((item) => item.id !== input.id),
              {
                id: input.id,
                hooks: result ?? {},
                scope: childScope,
                requestProfiles,
                nativeModels,
              },
            ]
            if (existing) yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore)
            generation++
            yield* events.publish(Event.Added, { id: input.id })
          }),
        )
      }),
      generation: Effect.fn("Plugin.generation")(function* () {
        return generation
      }),
      trigger: Effect.fn("Plugin.trigger")(function* (name, input, output) {
        return yield* svc.triggerFor(ID.make("*"), name, input, output)
      }),
      triggerFor: Effect.fn("Plugin.triggerFor")(function* (id, name, input, output) {
        const explicitOutputFields = Object.keys(output)
        const outputFields = Array.from(
          new Set<string>([...explicitOutputFields, ...((optionalOutputFields as Record<string, string[]>)[name] ?? [])]),
        )
        const event = {
          ...input,
          ...output,
        } as Record<string, unknown>

        for (const item of hooks) {
          if (id !== ID.make("*") && item.id !== id) continue
          const match = item.hooks[name]
          if (!match) continue
          const draftEntries = new Map<string, ReturnType<typeof createDraft>>()
          const next = { ...event }
          for (const field of explicitOutputFields) {
            const value = event[field]
            if (value && typeof value === "object") {
              const draft = createDraft(value)
              draftEntries.set(field, draft)
              next[field] = draft
            }
          }
          const exit = yield* match(next as any).pipe(
            Effect.withSpan(`Plugin.hook.${name}`, {
              attributes: {
                plugin: item.id,
                hook: name,
              },
            }),
            Effect.exit,
          )
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
            if (propagatedHookFailures.has(name)) return yield* Effect.failCause(exit.cause)
            yield* Effect.logError("plugin hook failed", {
              plugin: item.id,
              hook: name,
              error: Cause.squash(exit.cause),
            })
            continue
          }
          for (const field of outputFields) {
            const draft = draftEntries.get(field)
            event[field] = draft && next[field] === draft ? finishDraft(draft) : next[field]
          }
        }

        return event as any
      }),
      remove: Effect.fn("Plugin.remove")(function* (id) {
        yield* locks.withLock(id)(
          Effect.gen(function* () {
            const existing = hooks.find((item) => item.id === id)
            hooks = hooks.filter((item) => item.id !== id)
            if (!existing) return
            generation++
            yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore)
          }),
        )
      }),
    })
    return svc
  }),
)

export const locationLayer = layer

// opencode
// sdcok
