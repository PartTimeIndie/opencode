export * as SessionPlanDocument from "./plan-document"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { NonNegativeInt } from "../schema"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export const MAX_MARKDOWN_BYTES = 256 * 1024
export const MetadataKey = "opencode.plan_document"

export class Info extends Schema.Class<Info>("SessionPlanDocument.Info")({
  markdown: Schema.String,
  revision: NonNegativeInt,
  updatedAt: Schema.Finite,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionPlanDocument.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "SessionPlanDocument.RevisionConflictError",
  { expected: NonNegativeInt, actual: NonNegativeInt },
) {}

export class SizeLimitError extends Schema.TaggedErrorClass<SizeLimitError>()("SessionPlanDocument.SizeLimitError", {
  bytes: NonNegativeInt,
  maximum: NonNegativeInt,
}) {}

export class PatchTargetError extends Schema.TaggedErrorClass<PatchTargetError>()("SessionPlanDocument.PatchTargetError", {
  occurrences: NonNegativeInt,
}) {}

export interface Interface {
  readonly read: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined, NotFoundError>
  readonly replace: (input: {
    sessionID: SessionSchema.ID
    markdown: string
    expectedRevision?: number
  }) => Effect.Effect<Info, NotFoundError | RevisionConflictError | SizeLimitError | PatchTargetError>
  readonly patch: (input: {
    sessionID: SessionSchema.ID
    expected: string
    replacement: string
    expectedRevision?: number
  }) => Effect.Effect<Info, NotFoundError | RevisionConflictError | SizeLimitError | PatchTargetError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionPlanDocument") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const read = Effect.fn("SessionPlanDocument.read")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ sessionID })
      return decode(row.metadata?.[MetadataKey])
    })

    const mutate = Effect.fn("SessionPlanDocument.mutate")(function* (input: {
      sessionID: SessionSchema.ID
      expectedRevision?: number
      update: (current: Info | undefined) => Effect.Effect<string, PatchTargetError>
    }) {
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select({ metadata: SessionTable.metadata })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })
            const current = decode(row.metadata?.[MetadataKey])
            const revision = current?.revision ?? 0
            if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
              return yield* new RevisionConflictError({ expected: input.expectedRevision, actual: revision })
            const markdown = yield* input.update(current)
            const bytes = Buffer.byteLength(markdown, "utf8")
            if (bytes > MAX_MARKDOWN_BYTES) return yield* new SizeLimitError({ bytes, maximum: MAX_MARKDOWN_BYTES })
            const next = new Info({ markdown, revision: revision + 1, updatedAt: Date.now() })
            yield* tx
              .update(SessionTable)
              .set({ metadata: { ...(row.metadata ?? {}), [MetadataKey]: next } })
              .where(eq(SessionTable.id, input.sessionID))
              .run()
              .pipe(Effect.orDie)
            return next
          }),
        { behavior: "immediate" },
      ).pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({
      read,
      replace: (input) => mutate({ ...input, update: () => Effect.succeed(input.markdown) }),
      patch: (input) =>
        mutate({
          ...input,
          update: (current) => {
            const markdown = current?.markdown ?? ""
            const occurrences = input.expected.length === 0 ? 0 : markdown.split(input.expected).length - 1
            if (occurrences !== 1) return Effect.fail(new PatchTargetError({ occurrences }))
            return Effect.succeed(markdown.replace(input.expected, input.replacement))
          },
        }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

function decode(input: unknown): Info | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Info)(input))
}
