export * as DelegationPreferences from "./delegation-preferences"

import { Effect, Schema } from "effect"
import { ConfigDelegation } from "../config/delegation"
import { ConfigFileWriter } from "../config/file-writer"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import type { SessionV2 } from "../session"
import type { Config } from "../config"
import type { PermissionV2 } from "../permission"
import { SessionSchema } from "./schema"

export const METADATA_KEY = "opencode.delegation_preferences"
export const Scope = Schema.Literals(["global", "project", "session", "task"])
export type Scope = typeof Scope.Type
export const State = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  session: ConfigDelegation.Info,
  tasks: Schema.Record(Schema.String, ConfigDelegation.Info),
})
export type State = typeof State.Type
export const Patch = Schema.Struct({
  ordinaryQuestions: Schema.NullOr(Schema.Boolean).pipe(Schema.optional),
  preferences: Schema.NullOr(Schema.Array(ConfigDelegation.Preference)).pipe(Schema.optional),
  rules: Schema.NullOr(Schema.Array(ConfigDelegation.Rule)).pipe(Schema.optional),
})
export type Patch = typeof Patch.Type

/** Shared language/Settings request shape. An omitted scope is always the
 * current Session, never the scope selected in another UI. */
export const Target = Schema.Struct({
  scope: Scope.pipe(Schema.optional),
  taskID: SessionSchema.ID.pipe(Schema.optional),
})
export type Target = typeof Target.Type
export const ScopedPatch = Schema.Struct({
  ...Target.fields,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  expectedVersion: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.optional),
  patch: Patch,
})
export type ScopedPatch = typeof ScopedPatch.Type

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("DelegationPreferences.Conflict", {
  expectedRevision: Schema.Number,
  actualRevision: Schema.Number,
}) {
  override get message() {
    return `Delegation preferences changed: expected revision ${this.expectedRevision}, current revision ${this.actualRevision}; read the current scope before saving again`
  }
}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("DelegationPreferences.Invalid", {
  reason: Schema.Literals(["state", "task", "owner"]),
}) {
  override get message() { return `Delegation preferences are unavailable or invalid (${this.reason}); no settings or permission fallback was applied` }
}

export const read = Effect.fn("DelegationPreferences.read")(function* (sessions: Pick<SessionV2.Interface, "get">, sessionID: SessionSchema.ID) {
  const session = yield* sessions.get(sessionID)
  const stored = session.metadata?.[METADATA_KEY]
  if (stored === undefined) return { version: 1 as const, revision: 0, session: {}, tasks: {} }
  return yield* Schema.decodeUnknownEffect(State)(stored).pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
})

/** Both language and Settings callers use this owner. Omitted scope is Session;
 * a task target is explicit and must be an actual child of that Session. */
export const patch = Effect.fn("DelegationPreferences.patch")(function* (
  sessions: Pick<SessionV2.Interface, "get" | "compareAndPatchMetadata">,
  request: { readonly sessionID: SessionSchema.ID; readonly taskID?: SessionSchema.ID; readonly expectedRevision: number; readonly patch: Patch },
) {
  const input = structuredClone(request)
  const change = yield* Schema.decodeUnknownEffect(Patch, { onExcessProperty: "error" })(input.patch)
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    return yield* new Invalid({ reason: "state" })
  if (!sessions.compareAndPatchMetadata) return yield* new Invalid({ reason: "owner" })
  const session = yield* sessions.get(input.sessionID)
  const stored = session.metadata?.[METADATA_KEY]
  const state = stored === undefined
    ? { version: 1 as const, revision: 0, session: {}, tasks: {} }
    : yield* Schema.decodeUnknownEffect(State)(stored).pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  if (state.revision !== input.expectedRevision)
    return yield* new Conflict({ expectedRevision: input.expectedRevision, actualRevision: state.revision })
  if (input.taskID !== undefined) {
    const child = yield* sessions.get(input.taskID)
    if (child.parentID !== input.sessionID || child.agentPolicy?.source.type !== "task")
      return yield* new Invalid({ reason: "task" })
  }
  const value = apply(input.taskID === undefined ? state.session : state.tasks[input.taskID] ?? {}, change)
  const next: State = { version: 1, revision: state.revision + 1,
    session: input.taskID === undefined ? value : state.session,
    tasks: input.taskID === undefined ? state.tasks : { ...state.tasks, [input.taskID]: value } }
  const saved = yield* sessions.compareAndPatchMetadata({ sessionID: input.sessionID,
    expectedMetadata: { [METADATA_KEY]: stored }, patch: { set: { [METADATA_KEY]: next } } })
  if (!saved) {
    const current = yield* read(sessions, input.sessionID)
    return yield* new Conflict({ expectedRevision: input.expectedRevision, actualRevision: current.revision })
  }
  return next
})

export function apply(value: ConfigDelegation.Info, patch: Patch): ConfigDelegation.Info {
  return {
    ...(patch.ordinaryQuestions === undefined ? value.ordinaryQuestions === undefined ? {} : { ordinaryQuestions: value.ordinaryQuestions }
      : patch.ordinaryQuestions === null ? {} : { ordinaryQuestions: patch.ordinaryQuestions }),
    ...(patch.preferences === undefined ? value.preferences === undefined ? {} : { preferences: structuredClone(value.preferences) }
      : patch.preferences === null ? {} : { preferences: structuredClone(patch.preferences) }),
    ...(patch.rules === undefined ? value.rules === undefined ? {} : { rules: structuredClone(value.rules) }
      : patch.rules === null ? {} : { rules: structuredClone(patch.rules) }),
  }
}

/** `file` is resolved by the host's existing global/project config path owner,
 * never a caller-selected path from a model. Permissions remain at that boundary. */
export type DocumentTarget = { readonly scope: "global" | "project"; readonly file: string }

export const readDocument = Effect.fn("DelegationPreferences.readDocument")(function* (
  writer: ConfigFileWriter.Interface, target: DocumentTarget,
) {
  const input = { ...target }
  if (input.scope !== "global" && input.scope !== "project") return yield* new Invalid({ reason: "owner" })
  const snapshot = yield* writer.read(input.file)
  const value = yield* documentValue(snapshot.text)
  return { scope: input.scope, value, version: snapshot.version }
})

export const patchDocument = Effect.fn("DelegationPreferences.patchDocument")(function* (
  writer: ConfigFileWriter.Interface,
  request: DocumentTarget & { readonly expectedVersion: string; readonly patch: Patch },
) {
  const input = structuredClone(request)
  if ((input.scope !== "global" && input.scope !== "project") || typeof input.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedVersion))
    return yield* new Invalid({ reason: "owner" })
  const change = yield* Schema.decodeUnknownEffect(Patch, { onExcessProperty: "error" })(input.patch)
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  const saved = yield* writer.update({ file: input.file, expectedVersion: input.expectedVersion }, (snapshot) => Effect.gen(function* () {
    const current = yield* documentValue(snapshot.text)
    const value = apply(current, change)
    const text = Object.entries(change).reduce((text, [key, entry]) => entry === undefined ? text
      : applyEdits(text, modify(text, ["delegation", key], entry === null ? undefined : entry,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } })), snapshot.text ?? "{}\n")
    return { text, value }
  }))
  return { scope: input.scope, value: saved.value, version: saved.snapshot.version, changed: saved.changed }
})

export type ScopedDependencies = {
  readonly sessions: Pick<SessionV2.Interface, "get" | "compareAndPatchMetadata">
  readonly writer: ConfigFileWriter.Interface
  /** Existing host config-path owner; no model-selected destination. */
  readonly documentTarget: (scope: "global" | "project") => Effect.Effect<DocumentTarget, Invalid>
  readonly authorize: (input: { readonly scope: Scope; readonly operation: "get" | "patch"; readonly taskID?: SessionSchema.ID }) => Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError>
}

export const getScoped = Effect.fn("DelegationPreferences.getScoped")(function* (
  dependencies: ScopedDependencies, sessionID: SessionSchema.ID, request: Target,
) {
  const input = yield* Schema.decodeUnknownEffect(Target, { onExcessProperty: "error" })(structuredClone(request))
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  const scope = input.scope ?? "session"
  if ((scope === "task") !== (input.taskID !== undefined)) return yield* new Invalid({ reason: "task" })
  yield* dependencies.authorize({ scope, operation: "get", taskID: input.taskID })
  if (scope === "global" || scope === "project") {
    const target = yield* dependencies.documentTarget(scope)
    if (target.scope !== scope) return yield* new Invalid({ reason: "owner" })
    return yield* readDocument(dependencies.writer, target)
  }
  if (input.taskID !== undefined) {
    const child = yield* dependencies.sessions.get(input.taskID)
    if (child.parentID !== sessionID || child.agentPolicy?.source.type !== "task")
      return yield* new Invalid({ reason: "task" })
  }
  const state = yield* read(dependencies.sessions, sessionID)
  return { scope, value: input.taskID === undefined ? state.session : state.tasks[input.taskID] ?? {},
    revision: state.revision, ...(input.taskID === undefined ? {} : { taskID: input.taskID }) }
})

export const patchScoped = Effect.fn("DelegationPreferences.patchScoped")(function* (
  dependencies: ScopedDependencies, sessionID: SessionSchema.ID, request: ScopedPatch,
) {
  const input = yield* Schema.decodeUnknownEffect(ScopedPatch, { onExcessProperty: "error" })(structuredClone(request))
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  const scope = input.scope ?? "session"
  if ((scope === "task") !== (input.taskID !== undefined)) return yield* new Invalid({ reason: "task" })
  const document = scope === "global" || scope === "project"
  if (document ? input.expectedVersion === undefined || input.expectedRevision !== undefined
    : input.expectedRevision === undefined || input.expectedVersion !== undefined)
    return yield* new Invalid({ reason: "state" })
  yield* dependencies.authorize({ scope, operation: "patch", taskID: input.taskID })
  if (scope === "global" || scope === "project") {
    const target = yield* dependencies.documentTarget(scope)
    if (target.scope !== scope || input.expectedVersion === undefined) return yield* new Invalid({ reason: "owner" })
    return yield* patchDocument(dependencies.writer, { ...target, expectedVersion: input.expectedVersion, patch: input.patch })
  }
  if (input.expectedRevision === undefined) return yield* new Invalid({ reason: "state" })
  const state = yield* patch(dependencies.sessions, { sessionID, expectedRevision: input.expectedRevision,
    taskID: input.taskID, patch: input.patch })
  return { scope, value: input.taskID === undefined ? state.session : state.tasks[input.taskID] ?? {},
    revision: state.revision, ...(input.taskID === undefined ? {} : { taskID: input.taskID }) }
})

const documentValue = Effect.fn("DelegationPreferences.documentValue")(function* (text: string | undefined) {
  if (text === undefined) return {}
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return yield* new Invalid({ reason: "state" })
  const object = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(parsed)
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
  return object.delegation === undefined ? {} : yield* Schema.decodeUnknownEffect(ConfigDelegation.Info)(object.delegation)
    .pipe(Effect.mapError(() => new Invalid({ reason: "state" })))
})

export type Candidate = { readonly agent: string; readonly model: string; readonly variant?: string; readonly chain?: string }

/** Candidates must already satisfy native permission/model policy. This resolver
 * only narrows them. Hard rules from outer scopes are never replaced by advice. */
export function resolve(input: {
  readonly global?: ConfigDelegation.Info
  readonly project?: ConfigDelegation.Info
  readonly session?: ConfigDelegation.Info
  readonly task?: ConfigDelegation.Info
  readonly topics: readonly string[]
  readonly candidates: readonly Candidate[]
}) {
  return resolveLayers({ ...input, layers: (["task", "session", "project", "global"] as const)
    .flatMap((scope) => input[scope] ? [{ scope, value: input[scope] }] : []) })
}

export type Layer = { readonly scope: Scope; readonly source?: string; readonly value: ConfigDelegation.Info }

/** Preserve every document's hard rules; a merged Config.latest value would
 * silently discard lower-priority constraints. Returned order is highest first. */
export function documentLayers(entries: readonly Config.Entry[]): readonly Layer[] {
  const boundary = entries.findIndex((entry) => entry.type === "directory")
  return entries.flatMap((entry, index) => entry.type === "document" && entry.info.delegation
    ? [{ scope: boundary === -1 || index < boundary ? "global" as const : "project" as const,
      source: entry.path, value: structuredClone(entry.info.delegation) }] : []).toReversed()
}

export function resolveLayers(input: {
  readonly layers: readonly Layer[]
  readonly topics: readonly string[]
  readonly candidates: readonly Candidate[]
}) {
  const layers = input.layers
  const rules = layers.flatMap((layer) => (layer.value.rules ?? []).filter((rule) => rule.topic === undefined || input.topics.includes(rule.topic))
    .map((rule) => ({ scope: layer.scope, source: layer.source, rule: structuredClone(rule) })))
  const candidates = input.candidates.filter((candidate) => rules.every(({ rule }) => rule.allowed.some((selection) => matches(candidate, selection))))
    .map((candidate) => ({ ...candidate }))
  const preferences = layers.flatMap((layer) => (layer.value.preferences ?? []).filter((preference) => input.topics.includes(preference.topic))
    .map((preference) => ({ scope: layer.scope, source: layer.source, ...structuredClone(preference) })))
  return {
    ordinaryQuestions: layers.find((layer) => layer.value.ordinaryQuestions !== undefined)?.value.ordinaryQuestions ?? true,
    preferences, rules, candidates,
    impossible: candidates.length === 0,
  }
}

function matches(candidate: Candidate, selection: ConfigDelegation.Selection) {
  return (selection.agent === undefined || candidate.agent === selection.agent) &&
    (selection.model === undefined || candidate.model === selection.model) &&
    (selection.variant === undefined || candidate.variant === selection.variant) &&
    (selection.chain === undefined || candidate.chain === selection.chain)
}
