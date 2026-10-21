import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Effect, Option, Schema } from "effect"

export function locateSessionAttachment(input: {
  readonly attachmentID: string
  readonly sessionID: string
  readonly content: ContentStore.Interface
  readonly archive: SessionArchive.Interface
}) {
  return Effect.gen(function* () {
    const active = yield* input.content.locate({
      uri: ContentStore.URI_PREFIX + input.attachmentID,
      sessionID: input.sessionID,
    })
    if (active) return active

    const sessionID = Option.getOrUndefined(Schema.decodeUnknownOption(SessionSchema.ID)(input.sessionID))
    if (!sessionID) return
    const attachment = yield* input.archive.readAttachment(sessionID, input.attachmentID).pipe(
      Effect.catchTag("SessionArchive.NotFoundError", () => Effect.succeed(undefined)),
    )
    if (!attachment) return
    const blob = yield* input.content.locateBlob(attachment.blobSha256)
    if (!blob)
      return yield* new ContentStore.StorageError({
        operation: "integrity",
        resource: input.attachmentID,
        cause: new Error("Archived attachment blob metadata is missing"),
      })
    return {
      id: attachment.attachmentID,
      sessionID,
      sha256: blob.sha256,
      mime: typeof attachment.metadata.mime === "string" ? attachment.metadata.mime : blob.mime,
      ...(typeof attachment.metadata.filename === "string" ? { name: attachment.metadata.filename } : {}),
      path: blob.path,
      sizeBytes: blob.sizeBytes,
    } satisfies ContentStore.Located
  })
}
