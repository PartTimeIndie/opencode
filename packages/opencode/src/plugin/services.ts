import path from "node:path"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import type {
  ServerServiceCall,
  ServerServiceContext,
  ServerServiceDefinition,
  ServerServiceSchema,
  ServerServices,
} from "@opencode-ai/plugin/server"

export type PluginServiceOwner = { pluginID: string; directory: string; projectID: string }

/** Construct only after resolving the authenticated caller and optional session in the host. */
export type PluginServiceCaller = PluginServiceOwner & {
  sessionID?: string
  signal: AbortSignal
  /** Exact service grants resolved by the host from the authenticated plugin. */
  readonly capabilities?: readonly string[]
}

export class PluginServiceError extends Error {
  constructor(
    readonly code: "invalid" | "duplicate" | "unavailable" | "version" | "forbidden" | "input" | "output",
    message: string,
  ) {
    super(message)
    this.name = "PluginServiceError"
  }
}

/** A host-owned registry. The loader must dispose each binding with its instance scope. */
export function createPluginServiceRegistry(options: {
  authorize(input: {
    caller: PluginServiceCaller
    target: PluginServiceOwner & { serviceID: string; version: number }
  }): boolean | Promise<boolean>
}) {
  const bindings = new Set<string>()
  const entries = new Map<
    string,
    {
      owner: PluginServiceOwner
      serviceID: string
      version: number
      signal: AbortSignal
      execute(input: unknown, context: ServerServiceContext): Promise<unknown>
    }
  >()

  return {
    bind(owner: PluginServiceOwner) {
      requireID(owner.pluginID, true)
      const identity = Object.freeze({ ...owner, directory: normalizeDirectory(owner.directory) })
      const scope = scopeKey(identity)
      if (bindings.has(scope)) throw new PluginServiceError("duplicate", `Plugin already bound: ${identity.pluginID}`)
      bindings.add(scope)
      const lifecycle = new AbortController()
      const disposers = new Set<() => Promise<void>>()
      const services: ServerServices = {
        register<Input, Output>(definition: ServerServiceDefinition<Input, Output>) {
          if (lifecycle.signal.aborted) throw new PluginServiceError("unavailable", "Plugin has been unloaded")
          requireID(definition.id)
          requireVersion(definition.version)
          requireSchema(definition.input)
          requireSchema(definition.output)
          const key = JSON.stringify([scope, definition.id])
          if (entries.has(key))
            throw new PluginServiceError("duplicate", `Service already registered: ${definition.id}`)
          const controller = new AbortController()
          const entry = {
            owner: identity,
            serviceID: definition.id,
            version: definition.version,
            signal: controller.signal,
            async execute(input: unknown, context: ServerServiceContext) {
              const parsed = await validate(definition.input, input, "input")
              context.signal.throwIfAborted()
              const output = await CrashActivity.trackPromise(
                { kind: "plugin", pluginID: identity.pluginID, sessionID: context.sessionID, name: `service.${definition.id}` },
                async () => definition.execute(parsed, context),
              )
              context.signal.throwIfAborted()
              return validate(definition.output, output, "output")
            },
          }
          entries.set(key, entry)
          const disposal: { promise?: Promise<void> } = {}
          const dispose = () => {
            if (disposal.promise) return disposal.promise
            disposal.promise = Promise.resolve()
              .then(() => definition.dispose && CrashActivity.trackPromise(
                { kind: "plugin", pluginID: identity.pluginID, name: `service.dispose.${definition.id}` },
                async () => definition.dispose!(),
              ))
              .finally(() => {
                disposers.delete(dispose)
              })
            entries.delete(key)
            controller.abort(new DOMException("Plugin service unloaded", "AbortError"))
            return disposal.promise
          }
          disposers.add(dispose)
          return dispose
        },
      }
      const disposal: { promise?: Promise<void> } = {}
      return {
        services,
        dispose() {
          if (disposal.promise) return disposal.promise
          lifecycle.abort()
          const pending = [...disposers].map((dispose) => dispose())
          disposal.promise = Promise.allSettled(pending).then((results) => {
            bindings.delete(scope)
            const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
            if (errors.length) throw new AggregateError(errors, "Plugin service cleanup failed")
          })
          return disposal.promise
        },
      }
    },

    async invoke(request: ServerServiceCall, principal: PluginServiceCaller) {
      requireID(request.pluginID, true)
      requireID(request.serviceID)
      requireVersion(request.version)
      const caller = Object.freeze({
        ...principal,
        directory: normalizeDirectory(principal.directory),
        capabilities: principal.capabilities && Object.freeze([...principal.capabilities]),
      })
      caller.signal.throwIfAborted()
      const entry = entries.get(
        JSON.stringify([scopeKey({ ...caller, pluginID: request.pluginID }), request.serviceID]),
      )
      if (!entry)
        throw new PluginServiceError(
          "unavailable",
          `Plugin service unavailable: ${request.pluginID}/${request.serviceID}`,
        )
      const signal = AbortSignal.any([caller.signal, entry.signal])
      return abortable(signal, async () => {
        const allowed = await options.authorize({
          caller,
          target: { ...entry.owner, serviceID: entry.serviceID, version: entry.version },
        })
        signal.throwIfAborted()
        if (!allowed) throw new PluginServiceError("forbidden", "Plugin service capability denied")
        if (request.version !== entry.version) {
          throw new PluginServiceError(
            "version",
            `Service requires version ${entry.version}; requested ${request.version}`,
          )
        }
        return entry.execute(request.input, {
          pluginID: entry.owner.pluginID,
          callerPluginID: caller.pluginID,
          directory: entry.owner.directory,
          projectID: entry.owner.projectID,
          sessionID: caller.sessionID,
          signal,
        })
      })
    },
  }
}

function requireID(value: string, scoped = false) {
  const pattern = scoped
    ? /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/
    : /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PluginServiceError(
      "invalid",
      "Plugin and service IDs must use letters, numbers, dots, underscores or hyphens",
    )
  }
}

function requireVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new PluginServiceError("invalid", "Service version must be a positive integer")
}

function requireSchema(schema: ServerServiceSchema<unknown>) {
  if (schema?.["~standard"]?.version !== 1 || typeof schema["~standard"].validate !== "function") {
    throw new PluginServiceError("invalid", "Service schemas must implement Standard Schema v1")
  }
}

function normalizeDirectory(directory: string) {
  if (!directory || !path.isAbsolute(directory))
    throw new PluginServiceError("invalid", "Host directory must be absolute")
  const resolved = path.resolve(directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function scopeKey(owner: PluginServiceOwner) {
  return JSON.stringify([owner.projectID, owner.directory, owner.pluginID])
}

async function validate<Output>(schema: ServerServiceSchema<Output>, input: unknown, phase: "input" | "output") {
  const result = await schema["~standard"].validate(input)
  if (result.issues)
    throw new PluginServiceError(
      phase,
      `Invalid service ${phase}: ${result.issues.map((issue) => issue.message).join("; ")}`,
    )
  return result.value
}

async function abortable<Output>(signal: AbortSignal, execute: () => Promise<Output>) {
  signal.throwIfAborted()
  const listener: { abort?: () => void } = {}
  const cancelled = new Promise<never>((_, reject) => {
    listener.abort = () => reject(signal.reason)
    signal.addEventListener("abort", listener.abort, { once: true })
  })
  return Promise.race([cancelled, execute()]).finally(() => signal.removeEventListener("abort", listener.abort!))
}
