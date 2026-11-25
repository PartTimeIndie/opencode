export * as WorkspaceReconcile from "./reconcile"

import { createHash } from "node:crypto"
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"

export type File = { readonly bytes: Uint8Array; readonly mode: number }
export type Entry = {
  readonly path: string
  readonly basis: File | undefined
  readonly child: File | undefined
  readonly main: File | undefined
}
export type Conflict = { readonly path: string; readonly reason: "content" | "binary" | "delete" | "mode" }
export type Result =
  | { readonly status: "conflicts"; readonly conflicts: readonly Conflict[] }
  | { readonly status: "ready"; readonly files: readonly { readonly path: string; readonly file: File | undefined }[];
      readonly basis: readonly { readonly path: string; readonly file: File | undefined }[] }

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("WorkspaceReconcile.Invalid", {
  reason: Schema.Literals(["path", "mode", "io"]),
}) {
  override get message() { return `Workspace update could not be prepared (${this.reason})` }
}

/** Pure with respect to Main and mirror files: merge only copied snapshots and
 * private temporary inputs. No partial candidate or advanced basis is returned
 * on a conflict. The owner still must fence writers, reread Main, persist the
 * immutable basis, apply through native mutations and obtain human review. */
export const prepare = Effect.fn("WorkspaceReconcile.prepare")(function* (input: readonly Entry[]) {
  const entries = structuredClone(input)
  const names = entries.map((entry) => entry.path)
  if (names.some((name) => !validPath(name)) || new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    return yield* new Invalid({ reason: "path" })
  if (entries.some((entry) => [entry.basis, entry.child, entry.main].some((file) =>
    file !== undefined && (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777))))
    return yield* new Invalid({ reason: "mode" })
  const prepared = yield* Effect.forEach(entries, (entry) => Effect.gen(function* () {
    const { basis, child, main } = entry
    if (equal(child, basis)) return { path: entry.path, file: main }
    if (equal(main, basis) || equal(child, main)) return { path: entry.path, file: child }
    if (!child || !main || !basis) return { path: entry.path, reason: "delete" as const }
    const mode = child.mode === basis.mode ? main.mode : child.mode
    if (main.mode !== basis.mode && child.mode !== basis.mode && main.mode !== child.mode)
      return { path: entry.path, reason: "mode" as const }
    if (sameBytes(child, basis)) return { path: entry.path, file: { bytes: main.bytes, mode } }
    if (sameBytes(main, basis) || sameBytes(child, main)) return { path: entry.path, file: { bytes: child.bytes, mode } }
    if (![basis, child, main].every(isText)) return { path: entry.path, reason: "binary" as const }
    const bytes = yield* mergeText(basis.bytes, child.bytes, main.bytes)
    return bytes === undefined
      ? { path: entry.path, reason: "content" as const }
      : { path: entry.path, file: { bytes, mode } }
  }))
  const conflicts = prepared.flatMap((entry) => entry.reason === undefined ? [] : [{ path: entry.path, reason: entry.reason }])
  if (conflicts.length) return { status: "conflicts", conflicts } satisfies Result
  return { status: "ready", files: prepared.flatMap((entry) => entry.reason === undefined ? [{ path: entry.path, file: copyFile(entry.file) }] : []),
    basis: entries.map((entry) => ({ path: entry.path, file: copyFile(entry.main) })) } satisfies Result
})

function copyFile(file: File | undefined): File | undefined {
  return file === undefined ? undefined : { bytes: new Uint8Array(file.bytes), mode: file.mode }
}

function sameBytes(a: File, b: File) {
  return a.bytes.byteLength === b.bytes.byteLength &&
    createHash("sha256").update(a.bytes).digest("hex") === createHash("sha256").update(b.bytes).digest("hex")
}
function equal(a: File | undefined, b: File | undefined) {
  return a === undefined || b === undefined ? a === b : a.mode === b.mode && sameBytes(a, b)
}
function isText(file: File) {
  if (file.bytes.includes(0)) return false
  return !new TextDecoder().decode(file.bytes).includes("\uFFFD")
}
function validPath(value: string) {
  return !!value && !/[\\:\0]/.test(value) && !value.startsWith("/") && value.split("/").every((part) =>
    !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

const mergeText = Effect.fn("WorkspaceReconcile.mergeText")(function* (basis: Uint8Array, child: Uint8Array, main: Uint8Array) {
  const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: () => new Invalid({ reason: "io" }) })
  return yield* Effect.acquireUseRelease(
    io(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-workspace-merge-"))),
    (directory) => Effect.gen(function* () {
      yield* io(() => Promise.all([fs.writeFile(path.join(directory, "basis"), basis),
        fs.writeFile(path.join(directory, "child"), child), fs.writeFile(path.join(directory, "main"), main)]))
        .pipe(Effect.uninterruptible)
      // No source repository, shell, hooks, filters, global Git configuration or
      // inherited Git execution overrides participate in the textual merge.
      return yield* Effect.callback<Uint8Array | undefined, Invalid>((resume) => {
        const mergeProcess = childProcess.execFile("git",
        ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "merge-file", "-p", "--diff3", "--", "child", "basis", "main"],
        { cwd: directory, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
            GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } },
        (error, stdout) => {
          if (!error) return resume(Effect.succeed(new Uint8Array(stdout)))
          if (typeof error.code === "number" && error.code > 0 && error.code < 128) return resume(Effect.succeed(undefined))
          resume(Effect.fail(new Invalid({ reason: "io" })))
        })
        const closed = new Promise<void>((resolve) => mergeProcess.once("close", () => resolve()))
        // Cancellation owns only this temporary merge process. Wait for its
        // real close before releasing its private input files.
        return Effect.promise(async () => { mergeProcess.kill(); await closed })
      })
    }),
    (directory) => io(() => fs.rm(directory, { recursive: true })).pipe(Effect.orDie),
  )
})
