import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Cause, Context, Duration, Effect, Exit, Layer, Record, Result, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Credential } from "@opencode-ai/core/credential"
import { IntegrationSchema } from "@opencode-ai/core/integration/schema"
import { Flock } from "@opencode-ai/core/util/flock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layerFromPath = (authFile: string, lockOptions: Pick<Flock.Options, "timeoutMs"> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const credentials = yield* Credential.Service
      const authFileLockKey = `auth-json:${path.resolve(authFile)}`
      const withLock = <A, E>(key: string, message: string, effect: Effect.Effect<A, E>) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: (signal) => Flock.acquire(key, { ...lockOptions, signal }),
            catch: fail(message),
          }),
          () => effect,
          (lock) => Effect.promise(() => lock.release()).pipe(Effect.ignore),
        )
      const withFileLock = <A, E>(effect: Effect.Effect<A, E>) =>
        withLock(authFileLockKey, "Failed to lock auth data", effect)
      const decode = Schema.decodeUnknownOption(Info)
      // readFailure is undefined except when the read itself failed (transient
      // IO or parse error); unknown-format entries that the decoder skipped are
      // not a failure.
      type Loaded = { data: Record<string, Info>; raw: unknown; authoritative: boolean; readFailure: unknown }
      const decoded = (data: unknown): { data: Record<string, Info>; complete: boolean } => {
        if (!data || typeof data !== "object" || Array.isArray(data)) return { data: {}, complete: false }
        const values = data as Record<string, unknown>
        const result = Record.filterMap(values, (value) => Result.fromOption(decode(value), () => undefined))
        return { data: result, complete: Object.keys(result).length === Object.keys(values).length }
      }
      const canonical = (key: string) => key.replace(/\/+$/, "")
      const normalized = (data: Record<string, Info>) =>
        Object.fromEntries([
          ...Object.entries(data)
            .filter(([key]) => key !== canonical(key))
            .map(([key, info]) => [canonical(key), info] as const),
          ...Object.entries(data).filter(([key]) => key === canonical(key)),
        ])
      const withMutationLock = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
        withLock(`${authFileLockKey}:mutation:${canonical(key)}`, "Failed to lock auth mutation", effect)

      const read = Effect.fn("Auth.read")(function* () {
        return yield* fsys.readJson(authFile).pipe(
          Effect.map((data) => {
            const result = decoded(data)
            return { data: result.data, raw: data, authoritative: result.complete, readFailure: undefined }
          }),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed({ data: {} as Record<string, Info>, raw: {}, authoritative: true, readFailure: undefined }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("failed to read auth data", {
              file: authFile,
              error: error instanceof Error ? error.message : String(error),
            }).pipe(
              Effect.as({ data: {} as Record<string, Info>, raw: {}, authoritative: false, readFailure: error }),
            ),
          ),
        )
      })

      // Revalidation under the per-key mutation locks must never act on a
      // degraded read: a transient failure is indistinguishable from a parallel
      // write, so the only safe move is to abort the whole bootstrap pass. A
      // successfully read file with unknown-format entries is not a failure and
      // keeps its known keys mirrorable.
      const revalidate = Effect.fn("Auth.revalidate")(function* () {
        const loaded = yield* withFileLock(read())
        if (loaded.readFailure !== undefined)
          return yield* Effect.fail(
            new AuthError({ message: "auth data revalidation read failed", cause: loaded.readFailure }),
          )
        return loaded
      })

      // Share concurrent reads without retaining an interrupted owner as the
      // result for later provider requests. A cancelled startup request must not
      // poison the process-wide auth view.
      const [sharedLoad, invalidateLoad] = yield* Effect.cachedInvalidateWithTTL(withFileLock(read()), Duration.zero)
      const load = Effect.fn("Auth.load")(function* () {
        const result = yield* Effect.exit(sharedLoad)
        if (Exit.isSuccess(result)) return result.value
        if (!Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause)
        yield* invalidateLoad
        return yield* sharedLoad
      })

      const stored = Effect.fn("Auth.stored")(function* () {
        return normalized((yield* load()).data)
      })

      const all = Effect.fn("Auth.all")(function* () {
        if (!process.env.OPENCODE_AUTH_CONTENT) return yield* stored()
        try {
          return normalized(decoded(JSON.parse(process.env.OPENCODE_AUTH_CONTENT)).data)
        } catch (error) {
          yield* Effect.logWarning("invalid OPENCODE_AUTH_CONTENT", {
            error: error instanceof Error ? error.message : String(error),
          })
          return yield* stored()
        }
      })

      const write = Effect.fn("Auth.write")(function* (data: Record<string, unknown>) {
        yield* fsys.writeJsonSafe(authFile, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      })

      const updateFile = (update: (loaded: Loaded) => Record<string, unknown>) =>
        withFileLock(
          Effect.gen(function* () {
            const loaded = yield* read()
            // A transient read failure must never publish a partial rewrite:
            // update callbacks rebuild from raw, so writing would silently
            // drop every key the failed read could not see.
            if (loaded.readFailure !== undefined)
              return yield* Effect.fail(
                new AuthError({ message: "auth data read failed before update", cause: loaded.readFailure }),
              )
            yield* write(update(loaded))
          }),
        )

      const mirror = Effect.fn("Auth.mirror")(function* (
        mode: "bootstrap" | "set" | "remove",
        key: string,
        info?: Info,
      ) {
        const integrationID = IntegrationSchema.ID.make(canonical(key))
        if (mode === "remove") return yield* credentials.syncLegacy({ mode, integrationID })
        const value = credential(integrationID, info)
        if (!value) {
          if (mode === "bootstrap") return false
          return yield* credentials.syncLegacy({ mode: "remove", integrationID })
        }
        return yield* credentials.syncLegacy({ mode, integrationID, value })
      })

      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        return (yield* all())[canonical(providerID)]
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        const norm = canonical(key)
        yield* withMutationLock(
          norm,
          Effect.gen(function* () {
            yield* updateFile((loaded) => {
              const data = Object.fromEntries(
                Object.entries(rawRecord(loaded.raw)).filter(([candidate]) => canonical(candidate) !== norm),
              )
              return { ...data, [norm]: info }
            })
            // Keep the same-key operation ordered without retaining the global
            // auth.json lock while the credential database is being updated.
            yield* mirror("set", norm, info)
          }),
        )
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        const norm = canonical(key)
        yield* withMutationLock(
          norm,
          Effect.gen(function* () {
            yield* updateFile((loaded) =>
              Object.fromEntries(
                Object.entries(rawRecord(loaded.raw)).filter(([candidate]) => canonical(candidate) !== norm),
              ),
            )
            yield* mirror("remove", norm)
          }),
        )
      })

      const bootstrap = Effect.gen(function* () {
        yield* Effect.forEach(
          Object.entries(normalized((yield* load()).data)),
          ([key]) =>
            withMutationLock(
              key,
              Effect.gen(function* () {
                // The load above only snapshots auth.json. A parallel set or
                // remove from another layer or process can change or delete
                // this key while we wait on the per-key mutation lock, so
                // reconcile only the file state that is current under the lock.
                // A transient re-read failure aborts the whole pass: skipping
                // the key would silently drop it and mirroring the stale
                // snapshot would risk resurrecting or downgrading it again.
                // Only an authoritative missing key is a real deletion and may
                // be skipped.
                const current = normalized((yield* revalidate()).data)[key]
                if (!current) return
                const integrationID = IntegrationSchema.ID.make(key)
                const incoming = credential(integrationID, current)
                if (incoming?.type !== "oauth") return yield* mirror("bootstrap", key, current)

                const newer = (yield* credentials.list(integrationID))
                  .filter(
                    (item): item is Credential.Stored & { readonly value: Credential.OAuth } =>
                      (item.connectorID !== Credential.LegacySource || item.label === Credential.LegacyLabel) &&
                      item.value.type === "oauth" &&
                      item.value.methodID === incoming.methodID &&
                      item.value.expires > incoming.expires,
                  )
                  .reduce<Credential.Stored | undefined>(
                    (latest, item) =>
                      !latest || latest.value.type !== "oauth" || item.value.expires > latest.value.expires
                        ? item
                        : latest,
                    undefined,
                  )
                if (newer?.value.type === "oauth") {
                  const latest = authInfo(integrationID, newer.value)
                  if (latest) {
                    yield* updateFile((loaded) => {
                      const raw = rawRecord(loaded.raw)
                      const existing = normalized(loaded.data)[key]
                      if (existing && (existing.type !== "oauth" || existing.expires >= latest.expires)) return raw
                      return { ...raw, [key]: mergeAuthInfo(raw[key], latest) }
                    })
                  }
                  return
                }
                yield* mirror("bootstrap", key, current)
              }),
            ),
          { discard: true },
        )

        const saved = yield* withFileLock(read())
        if (saved.authoritative) {
          const mirrored = new Set(
            Object.entries(normalized(saved.data)).flatMap(([key, info]) => (credential(key, info) ? [key] : [])),
          )
          yield* Effect.forEach(
            (yield* credentials.legacy()).filter((item) => !mirrored.has(item.integrationID)),
            (item) =>
              withMutationLock(
                item.integrationID,
                Effect.gen(function* () {
                  const revalidated = yield* revalidate()
                  if (normalized(revalidated.data)[item.integrationID]) return
                  yield* credentials.syncLegacy({ mode: "remove", integrationID: item.integrationID })
                }),
              ),
            { discard: true },
          )
        }
      })

      yield* bootstrap.pipe(
        Effect.catchTag("AuthError", (error) =>
          Effect.logWarning("auth bootstrap skipped", { file: authFile, error: error.message }),
        ),
      )

      yield* credentials.onChange((change) =>
        Effect.gen(function* () {
          const after = change.after
          if (
            !after ||
            after.value.type !== "oauth" ||
            (after.connectorID === Credential.LegacySource && after.label !== Credential.LegacyLabel)
          )
            return
          const info = authInfo(after.integrationID, after.value)
          if (!info) return
          yield* withMutationLock(
            after.integrationID,
            updateFile((loaded) => {
              // The guard and merge source must resolve through trailing-slash
              // aliases: an alias-only entry is invisible to a raw key lookup,
              // so a native update would duplicate the key and normalized reads
              // would then hand back the older canonical copy as a downgrade.
              const norm = canonical(after.integrationID)
              const current = rawRecord(loaded.raw)
              const existing = normalized(loaded.data)[norm]
              if (existing?.type === "oauth" && existing.expires >= info.expires) return current
              const entries = Object.entries(current)
              const source =
                entries.find(([candidate]) => candidate === norm)?.[0] ??
                entries.find(([candidate]) => canonical(candidate) === norm)?.[0]
              return {
                ...Object.fromEntries(entries.filter(([candidate]) => canonical(candidate) !== norm)),
                [norm]: mergeAuthInfo(source === undefined ? undefined : current[source], info),
              }
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to mirror credential update", {
                integrationID: after.integrationID,
                error: String(error),
              }),
            ),
          )
        }),
      )

      return Service.of({ get, all, set, remove })
    }),
  )

export const layer = layerFromPath(file)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Credential.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node, Credential.node])

function credential(integrationID: string, info: Info | undefined) {
  if (info?.type === "api") {
    const instanceUrl = integrationID === "gitlab" ? (info.metadata?.instanceUrl ?? info.enterpriseUrl) : undefined
    return new Credential.Key({
      type: "key",
      key: info.key,
      metadata: instanceUrl ? { ...info.metadata, instanceUrl } : info.metadata,
    })
  }
  if (info?.type !== "oauth") return
  if (integrationID === "gitlab") {
    return new Credential.OAuth({
      type: "oauth",
      methodID: IntegrationSchema.MethodID.make("gitlab-oauth"),
      refresh: info.refresh,
      access: info.access,
      expires: info.expires,
      metadata: info.enterpriseUrl ? { instanceUrl: info.enterpriseUrl } : undefined,
    })
  }
  if (integrationID === "cursor") {
    return new Credential.OAuth({
      type: "oauth",
      methodID: IntegrationSchema.MethodID.make("cursor-oauth"),
      refresh: info.refresh,
      access: info.access,
      expires: info.expires,
    })
  }
  if (integrationID !== "openai") return
  return new Credential.OAuth({
    type: "oauth",
    methodID: IntegrationSchema.MethodID.make("chatgpt-browser"),
    refresh: info.refresh,
    access: info.access,
    expires: info.expires,
    metadata: {
      ...(info.accountId ? { accountID: info.accountId } : {}),
      ...(info.enterpriseUrl ? { enterpriseUrl: info.enterpriseUrl } : {}),
    },
  })
}

function authInfo(integrationID: string, value: Credential.OAuth): Oauth | undefined {
  if (integrationID === "openai" && value.methodID === "chatgpt-browser")
    return new Oauth({
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      accountId: value.metadata?.accountID,
      enterpriseUrl: value.metadata?.enterpriseUrl,
    })
  if (integrationID === "cursor" && value.methodID === "cursor-oauth")
    return new Oauth({ type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires })
  if (integrationID === "gitlab" && value.methodID === "gitlab-oauth")
    return new Oauth({
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      enterpriseUrl: value.metadata?.instanceUrl,
    })
  return undefined
}

function mergeAuthInfo(existing: unknown, latest: Oauth) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return latest
  return { ...existing, ...latest }
}

function rawRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return data as Record<string, unknown>
}

export * as Auth from "."
