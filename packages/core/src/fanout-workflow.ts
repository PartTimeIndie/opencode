export * as FanoutWorkflow from "./fanout-workflow"

import { Context, Effect, Layer, Option, Schema, SchemaRepresentation } from "effect"
import { Location } from "./location"

export type Definition = {
  id: string
  configKey: string
  agentID: string
  agentAliases?: string[]
  commands: string[]
  tools: string[]
  resultSchema: Record<string, unknown>
}
export type Registration = Definition & { decode(text: string): unknown }
type Entry = {
  definition: Definition
  registration: Registration
  owners: Map<string, number>
}

export function resolve<T extends { id: string; commands: ReadonlyArray<string> }>(
  entries: Iterable<T>,
  reference: string,
) {
  const values = [...entries]
  return (
    values.find((entry) => entry.id === reference) ??
    values.find((entry) => entry.commands.includes(reference)) ??
    (reference.startsWith("/") ? undefined : values.find((entry) => entry.commands.includes(`/${reference}`)))
  )
}

export class Service extends Context.Service<Service, {
  register(owner: string, definition: Definition): Effect.Effect<void, Error, import("effect").Scope.Scope>
  get(id: string): Registration | undefined
  command(command?: string): Registration | undefined
  resolve(reference: string): Registration | undefined
  agent(alias: string): string
}>()("@opencode/FanoutWorkflow") {}

const registriesKey = Symbol.for("@opencode/FanoutWorkflow/registries")
const registries = (() => {
  const existing = Reflect.get(globalThis, registriesKey)
  if (existing instanceof Map) return existing as Map<string | symbol, Map<string, Entry>>
  const value = new Map<string | symbol, Map<string, Entry>>()
  Reflect.set(globalThis, registriesKey, value)
  return value
})()

const makeLayer = (key: string | symbol) => Layer.effect(Service, Effect.sync(() => {
  const workflows = registries.get(key) ?? new Map<string, Entry>()
  registries.set(key, workflows)
  return Service.of({
    get: (id) => workflows.get(id)?.registration,
    command: (command) => command ? [...workflows.values()].map((item) => item.registration).find((item) => item.commands.includes(command)) : undefined,
    resolve: (reference) => resolve([...workflows.values()].map((item) => item.registration), reference),
    agent: (alias) => [...workflows.values()].map((item) => item.registration).find((item) => item.agentAliases?.includes(alias))?.agentID ?? alias,
    register: (owner, input) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9][\w.-]{0,127}$/.test(input.id) || !/^[a-zA-Z0-9][\w-]{0,127}$/.test(input.configKey) || ["max_threads", "max_depth"].includes(input.configKey)) return yield* Effect.fail(new Error("Invalid fanout workflow identity"))
      if (input.commands.some((command) => !command.trim())) return yield* Effect.fail(new Error("Invalid fanout workflow command"))
      const definition = yield* Effect.try({ try: () => structuredClone(input), catch: (error) => new Error(`Invalid workflow definition: ${error}`) })
      const existing = workflows.get(input.id)
      if (existing) {
        if (!existing.owners.has(owner) || JSON.stringify(existing.definition) !== JSON.stringify(definition)) return yield* Effect.fail(new Error("Fanout workflow is already registered"))
        yield* retain(workflows, owner, existing)
        return
      }
      if ([...workflows.values()].map((item) => item.registration).some((item) => item.commands.some((command) => input.commands.includes(command)) ||
        (item.agentID !== input.agentID && (input.agentAliases?.includes(item.agentID) || item.agentAliases?.includes(input.agentID) || item.agentAliases?.some((alias) => input.agentAliases?.includes(alias)))))) return yield* Effect.fail(new Error("Fanout workflow is already registered"))
      const schema = yield* Effect.try({try: () => resultDecoder(definition.resultSchema), catch: (error) => new Error(`Invalid workflow result schema: ${error}`)})
      const entry = { definition, registration: {...definition,decode:schema}, owners: new Map<string, number>() }
      workflows.set(input.id, entry)
      yield* retain(workflows, owner, entry)
    }),
  })
}))

function retain(workflows: Map<string, Entry>, owner: string, entry: Entry) {
  return Effect.acquireRelease(
    Effect.sync(() => entry.owners.set(owner, (entry.owners.get(owner) ?? 0) + 1)),
    () => Effect.sync(() => {
      const count = entry.owners.get(owner) ?? 0
      if (count > 1) entry.owners.set(owner, count - 1)
      else entry.owners.delete(owner)
      if (entry.owners.size === 0 && workflows.get(entry.registration.id) === entry) workflows.delete(entry.registration.id)
    }),
  )
}

export const layer = makeLayer(Symbol())
export const locationLayer = Layer.unwrap(Effect.map(Location.Service, (location) =>
  makeLayer(Location.identity({ directory: location.directory })),
))

export function resultDecoder(schema: Record<string, unknown>) {
  const { $defs, definitions, ...rest } = schema
  const compiled = SchemaRepresentation.toSchema(SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12", schema: rest,
    definitions: {
      ...(definitions && typeof definitions === "object" && !Array.isArray(definitions) ? definitions : {}),
      ...($defs && typeof $defs === "object" && !Array.isArray($defs) ? $defs : {}),
    } as Parameters<typeof SchemaRepresentation.fromJsonSchemaDocument>[0]["definitions"],
  }))
  // JSON Schema cannot declare Effect services; the representation API uses Top for custom revivers.
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(compiled as Schema.Codec<unknown>), { onExcessProperty: "error" })
  return (text: string) => Option.getOrUndefined(decode(text))
}
