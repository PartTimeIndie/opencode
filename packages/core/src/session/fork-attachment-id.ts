export * as SessionForkAttachmentID from "./fork-attachment-id"

import { createHash } from "node:crypto"

/** Leaf module on purpose: fork import, fork events and content-store
 * resolution share this derivation without pulling the session event graph into
 * the content layer. */
export const AttachmentPrefix = "att_fork_"

/** Deterministic per-child attachment identity. The same source URI and blob
 * hash always maps to the same fork-owned row inside one child session. Forked
 * history keeps the parent's serialized attachment references so the provider
 * sees a byte-identical cacheable prefix; resolution proves ownership through
 * this derived row instead of rewriting the visible reference. */
export function derive(input: {
  readonly sessionID: string
  readonly uri: string
  readonly blobSha256: string
}) {
  return (
    AttachmentPrefix +
    createHash("sha256")
      .update(`${input.sessionID}\0${input.uri}\0${input.blobSha256}`)
      .digest("hex")
      .slice(0, 32)
  )
}
