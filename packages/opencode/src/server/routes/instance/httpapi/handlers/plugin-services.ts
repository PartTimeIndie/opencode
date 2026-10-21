import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionPluginContext } from "@opencode-ai/core/session/plugin-context"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { HttpServerResponse } from "effect/unstable/http"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Plugin } from "@/plugin"
import { AppPluginAssets } from "@/plugin/app/assets"
import { PluginServiceError } from "@/plugin/services"
import { InstanceHttpApi } from "../api"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors"

export const pluginServicesHandlers = HttpApiBuilder.group(InstanceHttpApi, "pluginServices", (handlers) =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const locations = yield* LocationServiceMap
    return handlers.handle("sessionContext", (ctx) => Effect.gen(function* () {
      const caller = ctx.payload.caller
      const policy = yield* Effect.promise(() => AppPluginAssets.hostPolicy(caller.id, caller.version, caller.hash))
      if (!policy?.capabilities.includes("host:session-context"))
        return yield* Effect.fail(new ForbiddenError({ message: "Missing plugin capability: host:session-context" }))
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.fail(new ServiceUnavailableError({ message: "No project is active", service: "session-context" }))
      const sessions = yield* Session.Service
      const session = yield* sessions.get(SessionID.make(ctx.payload.sessionID)).pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "Session was not found", kind: "not_found" })),
      )
      const normalize = (directory: string) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
      const workspaceID = yield* InstanceState.workspaceID
      if (normalize(session.directory) !== normalize(instance.directory) || (session.workspaceID ?? undefined) !== workspaceID)
        return yield* Effect.fail(new ForbiddenError({ message: "Session belongs to another project or workspace" }))
      const legacy = yield* (yield* Permission.Service).list()
      const current = yield* PermissionV2.Service.use((permissions) => permissions.list()).pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))),
      )
      const permissions = [
        ...current.map((item) => ({ id: String(item.id), sessionID: String(item.sessionID), action: item.action, resources: item.resources })),
        ...legacy.map((item) => ({ id: String(item.id), sessionID: String(item.sessionID), action: item.permission, resources: item.patterns })),
      ]
      const context = yield* SessionPluginContext.read({
        db: (yield* Database.Service).db, sessionID: SessionSchema.ID.make(ctx.payload.sessionID),
        limit: ctx.payload.limit, maxTextChars: ctx.payload.maxTextChars, permissions,
      }).pipe(Effect.mapError(() => new InvalidRequestError({ message: "Session was not found", kind: "not_found" })))
      return HttpServerResponse.jsonUnsafe({ ok: true, context }, { headers: { "cache-control": "no-store" } })
    })).handle("sessionPolicy", (ctx) => Effect.gen(function* () {
      const caller = ctx.payload.caller
      const policy = yield* Effect.promise(() => AppPluginAssets.hostPolicy(caller.id, caller.version, caller.hash))
      if (!policy?.capabilities.includes("host:session-policy"))
        return yield* Effect.fail(new ForbiddenError({ message: "Missing plugin capability: host:session-policy" }))
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.fail(new ServiceUnavailableError({ message: "No project is active", service: "session-policy" }))
      if (ctx.payload.action === "write" && (!ctx.payload.sessionID || !ctx.payload.mode))
        return yield* Effect.fail(new InvalidRequestError({ message: "Writing a session policy requires sessionID and mode" }))
      const sessions = yield* Session.Service
      const session = ctx.payload.sessionID
        ? yield* sessions.get(SessionID.make(ctx.payload.sessionID)).pipe(Effect.mapError(() => new InvalidRequestError({ message: "Session was not found" })))
        : undefined
      const normalize = (directory: string) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
      if (session && normalize(session.directory) !== normalize(instance.directory))
        return yield* Effect.fail(new ForbiddenError({ message: "Session belongs to another project directory" }))
      if (ctx.payload.action === "write" && session && ctx.payload.mode) {
        const previous = session.metadata?.access_control
        const fields = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}
        yield* sessions.setMetadata({ sessionID: session.id, metadata: { ...session.metadata, access_control: { ...fields, mode: ctx.payload.mode } } })
        return { ok: true as const, mode: ctx.payload.mode }
      }
      const config = yield* (yield* Config.Service).get()
      const selected = ConfigAccessControl.fromUnknown(session?.metadata?.access_control)
        ?? ConfigAccessControl.fromUnknown(config.access_control)
        ?? ConfigAccessControl.DEFAULT_INFO
      return { ok: true as const, mode: selected.mode }
    })).handle("call", (ctx) => Effect.gen(function* () {
      const caller = ctx.payload.caller
      const policy = yield* Effect.promise(() => AppPluginAssets.hostPolicy(caller.id, caller.version, caller.hash))
      const capability = `services:${ctx.params.pluginID}:${ctx.params.serviceID}`
      if (!policy?.capabilities.includes(capability))
        return yield* Effect.fail(new ForbiddenError({ message: `Missing plugin capability: ${capability}` }))
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const data = yield* plugins.call({ ...ctx.params, version: ctx.payload.version, input: ctx.payload.input }, {
        pluginID: caller.id,
        capabilities: policy.capabilities,
        signal: controller.signal,
      }).pipe(Effect.mapError((error) => {
        if (error instanceof PluginServiceError && error.code === "forbidden") return new ForbiddenError({ message: error.message })
        if (error instanceof PluginServiceError && ["input", "invalid", "version"].includes(error.code))
          return new InvalidRequestError({ message: error.message })
        return new ServiceUnavailableError({ message: error.message, service: ctx.params.serviceID })
      }))
      // Plugin schemas may produce optional undefined fields. Apply standard JSON
      // serialization before the HTTP encoder requires an already JSON-safe value.
      const serialized = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(JSON.stringify(data) ?? "null"),
        catch: () => new ServiceUnavailableError({ message: "Plugin service output is not JSON serializable", service: ctx.params.serviceID }),
      })
      return { ok: true as const, data: serialized }
    }))
  }),
).pipe(Layer.provide(LocationServiceMap.layer))
