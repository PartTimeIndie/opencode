export * as WorkspaceBasis from "./basis"

import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ContentStore } from "../../content-store"
import type { SessionSchema } from "../schema"
import type { AgentMirror } from "./agent-mirror"

const File = Schema.Struct({
  path: Schema.String,
  mode: Schema.Int,
  bytes: Schema.Int,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  uri: Schema.String,
})
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  workspaceID: Schema.String,
  sourceSessionID: Schema.String,
  sourceDirectory: Schema.String,
  commit: Schema.String,
  files: Schema.Array(File),
  deletedPaths: Schema.Array(Schema.String),
})
export type Manifest = typeof Manifest.Type
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("WorkspaceBasis.Invalid", {
  reason: Schema.Literals(["path", "changed", "manifest", "content"]),
}) {}

export function digest(manifest: Manifest) {
  // Event/schema round trips can reorder object keys. Bind semantic manifest
  // fields in one canonical order rather than the caller's insertion order.
  return hash(new TextEncoder().encode(JSON.stringify({
    version: manifest.version, workspaceID: manifest.workspaceID, sourceSessionID: manifest.sourceSessionID,
    sourceDirectory: manifest.sourceDirectory, commit: manifest.commit,
    files: manifest.files.map((file) => ({ path: file.path, mode: file.mode, bytes: file.bytes,
      sha256: file.sha256, uri: file.uri })), deletedPaths: manifest.deletedPaths,
  })))
}

/** Retain the exact dirty/untracked basis bytes under native ContentStore
 * ownership before a child can edit its private files. The owning workspace
 * event must persist the returned manifest and digest; neither is consent or
 * permission to integrate. A failed preparation retains its artifacts. */
export const capture = Effect.fn("WorkspaceBasis.capture")(function* (
  content: ContentStore.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly mirror: AgentMirror.Mirror },
) {
  const mirror = structuredClone(input.mirror)
  const sessionID = input.sessionID
  if (mirror.basis.sourceSessionID !== sessionID) return yield* new Invalid({ reason: "manifest" })
  const names = [...mirror.basis.files.map((file) => file.path), ...mirror.basis.deletedPaths]
  if (names.some((name) => !validPath(name)) || new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    return yield* new Invalid({ reason: "path" })
  const root = yield* Effect.tryPromise({ try: () => fs.realpath(mirror.directory), catch: () => new Invalid({ reason: "path" }) })
  yield* Effect.forEach(mirror.basis.deletedPaths, (name) => Effect.tryPromise({
    try: async () => {
      await assertAncestors(root, name)
      const existing = await fs.lstat(path.join(root, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (existing) throw new Error("Deleted basis file reappeared")
    },
    catch: () => new Invalid({ reason: "changed" }),
  }))
  const files = yield* Effect.forEach([...mirror.basis.files].sort((a, b) => a.path.localeCompare(b.path)), (file) => Effect.gen(function* () {
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
      return yield* new Invalid({ reason: "manifest" })
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const target = path.join(root, file.path)
        await assertAncestors(root, file.path)
        const resolved = await fs.realpath(target)
        const relative = path.relative(root, resolved)
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("External basis path")
        const stat = await fs.lstat(target)
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== file.mode) throw new Error("Changed basis mode")
        return new Uint8Array(await fs.readFile(target))
      },
      catch: () => new Invalid({ reason: "path" }),
    })
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256) return yield* new Invalid({ reason: "changed" })
    const artifact = yield* content.storeAttachment({ sessionID,
      key: `workspace-basis:${mirror.basis.id}:${file.path}`, name: file.path, bytes, mime: "application/octet-stream" })
    return { ...file, uri: artifact.uri }
  }))
  const manifest: Manifest = { version: 1, workspaceID: mirror.basis.id, sourceSessionID: sessionID,
    sourceDirectory: mirror.basis.directory, commit: mirror.basis.commit, files,
    deletedPaths: [...mirror.basis.deletedPaths].sort() }
  return { manifest, digest: digest(manifest) }
})

/** Load only a host-pinned manifest and rehash immutable basis bytes. File size
 * alone is not sufficient: a same-length corruption must fail closed. */
export const read = Effect.fn("WorkspaceBasis.read")(function* (
  content: ContentStore.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly manifest: Manifest; readonly digest: string; readonly path: string },
) {
  const manifest = structuredClone(input.manifest)
  if (manifest.sourceSessionID !== input.sessionID || digest(manifest) !== input.digest)
    return yield* new Invalid({ reason: "manifest" })
  if (!validPath(input.path)) return yield* new Invalid({ reason: "path" })
  const file = manifest.files.find((file) => file.path === input.path)
  if (!file) {
    if (manifest.deletedPaths.includes(input.path)) return undefined
    return yield* new Invalid({ reason: "path" })
  }
  const resolved = yield* content.resolve({ sessionID: input.sessionID, uri: file.uri })
  if (!resolved || resolved.bytes.byteLength !== file.bytes || hash(resolved.bytes) !== file.sha256)
    return yield* new Invalid({ reason: "content" })
  return { bytes: new Uint8Array(resolved.bytes), mode: file.mode }
})

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function validPath(value: string) {
  return !!value && !/[\\:\0]/.test(value) && !value.startsWith("/") && value.split("/").every((part) =>
    !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

// Checking only the leaf permits a child to replace a directory with a
// junction to different matching bytes. Reject links in every existing parent,
// including parents of deleted files. This is not an OS sandbox against hostile
// concurrent filesystem writers; workspace ownership must fence child execution.
async function assertAncestors(root: string, name: string) {
  for (const part of name.split("/").slice(0, -1)) {
    root = path.join(root, part)
    const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked basis ancestor")
  }
}
