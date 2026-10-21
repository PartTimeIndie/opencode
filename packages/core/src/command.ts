export * as CommandV2 from "./command"

import { Context, Effect, Layer, Schema } from "effect"
import { castDraft, type Draft } from "immer"
import { ModelV2 } from "./model"
import { State } from "./state"

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const quoteTrimRegex = /(^["']|["']$)/g
const placeholderRegex = /\$(\d+)/g

export const Action = Schema.Literal("session-goal")
export type Action = typeof Action.Type

export class Info extends Schema.Class<Info>("CommandV2.Info")({
  name: Schema.String,
  template: Schema.String,
  description: Schema.String.pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  model: ModelV2.Ref.pipe(Schema.optional),
  requiredTools: Schema.Array(Schema.String).pipe(Schema.optional),
  aliases: Schema.Array(Schema.String).pipe(Schema.optional),
  source: Schema.Literals(["command", "mcp", "skill"]).pipe(Schema.optional),
  action: Action.pipe(Schema.optional),
  subtask: Schema.Boolean.pipe(Schema.optional),
  hints: Schema.Array(Schema.String).pipe(Schema.optional),
}) {}

export type ResolveInput = {
  name: string
  arguments: string
}

export type Resolver = (input: ResolveInput) => Effect.Effect<string>

export type Data = {
  commands: Map<string, Info>
  resolvers: Map<string, Resolver>
}

export type Editor = {
  list: () => readonly Info[]
  get: (name: string) => Info | undefined
  update: (name: string, update: (command: Draft<Info>) => void) => void
  resolve: (name: string, resolver: Resolver) => void
  remove: (name: string) => void
}

export interface Interface {
  readonly transform: State.Interface<Data, Editor>["transform"]
  readonly update: State.Interface<Data, Editor>["update"]
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly resolve: (input: ResolveInput) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const state = State.create<Data, Editor>({
      initial: () => ({ commands: new Map(), resolvers: new Map() }),
      editor: (draft) => ({
        list: () => Array.from(draft.commands.values()) as Info[],
        get: (name) => draft.commands.get(name),
        update: (name, update) => {
          const current = draft.commands.get(name) ?? castDraft(new Info({ name, template: "" }))
          if (!draft.commands.has(name)) draft.commands.set(name, current)
          update(current)
          current.name = name
        },
        resolve: (name, resolver) => {
          draft.resolvers.set(name, resolver)
        },
        remove: (name) => {
          draft.commands.delete(name)
          draft.resolvers.delete(name)
        },
      }),
    })

    return Service.of({
      update: state.update,
      transform: state.transform,
      get: Effect.fn("CommandV2.get")(function* (name) {
        return state.get().commands.get(name)
      }),
      list: Effect.fn("CommandV2.list")(function* () {
        return Array.from(state.get().commands.values())
      }),
      resolve: Effect.fn("CommandV2.resolve")(function* (input) {
        const resolver = state.get().resolvers.get(input.name)
        if (resolver) return yield* resolver(input)
        const command = state.get().commands.get(input.name)
        if (!command) return undefined
        return commandTemplate({ template: command.template, arguments: input.arguments })
      }),
    })
  }),
)

export const locationLayer = layer

function commandTemplate(input: { template: string; arguments: string }) {
  const args = parseArguments(input.arguments)
  const placeholders = input.template.match(placeholderRegex) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  const withArgs = input.template.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })
  const template = withArgs.replaceAll("$ARGUMENTS", input.arguments)
  if (placeholders.length === 0 && !input.template.includes("$ARGUMENTS") && input.arguments.trim()) {
    return `${template}\n\n${input.arguments}`
  }
  return template
}

export function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

export function hints(template: string) {
  return [
    ...new Set([
      ...(template.match(placeholderRegex) ?? []).sort(),
      ...(template.includes("$ARGUMENTS") ? ["$ARGUMENTS"] : []),
    ]),
  ]
}
