export * as FileLockRecovery from "./file-lock-recovery"

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { Hash } from "./util/hash"

/** Administrator-only recovery, never called by acquire/retry or a model tool. */
export async function inspect(input: { lockRoot: string; target: string }) {
  if (!path.isAbsolute(input.target) || !path.isAbsolute(input.lockRoot))
    throw new Error("Use absolute canonical target and lock-root paths")
  const directory = path.join(input.lockRoot, `${Hash.fast(`file-mutation:${input.target}`)}.lock`)
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Lock is not an ordinary directory; manual inspection required")
  const entries = await fs.readdir(directory)
  if (entries.length !== 1 || !/^owner-[0-9a-f-]+\.json$/.test(entries[0]!))
    throw new Error("Unknown/missing/extra lock evidence; preserve it for manual inspection")
  const ownerPath = path.join(directory, entries[0]!)
  if (!(await fs.lstat(ownerPath)).isFile() || (await fs.lstat(ownerPath)).isSymbolicLink())
    throw new Error("Owner evidence is not an ordinary file")
  const bytes = await fs.readFile(ownerPath)
  const owner: unknown = JSON.parse(bytes.toString("utf8"))
  if (
    !owner ||
    typeof owner !== "object" ||
    !("token" in owner) ||
    !("pid" in owner) ||
    !("hostname" in owner) ||
    typeof owner.token !== "string" ||
    entries[0] !== `owner-${owner.token}.json` ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string"
  )
    throw new Error("Malformed owner evidence; preserve it for manual inspection")
  return {
    directory,
    ownerPath,
    token: owner.token,
    pid: owner.pid,
    hostname: owner.hostname,
    ownerSha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

export async function recover(input: { lockRoot: string; target: string; ownerToken: string; ownerSha256: string }) {
  const observed = await inspect(input)
  if (observed.token !== input.ownerToken || observed.ownerSha256 !== input.ownerSha256)
    throw new Error("Owner evidence changed; inspect again, do not retry the old approval")
  if (observed.hostname !== os.hostname()) throw new Error("Foreign host; cannot establish that the owner exited")
  const state = (() => {
    try {
      process.kill(observed.pid, 0)
      return "live"
    } catch (error) {
      return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "exited" : "unknown"
    }
  })()
  if (state !== "exited") throw new Error("Owner process is live or cannot be checked; no lock was removed")
  // Revalidate after the process check. Remove only this random generation's
  // exact owner file, then the empty directory. Never recursive removal.
  const current = await inspect(input)
  if (current.token !== observed.token || current.ownerSha256 !== observed.ownerSha256)
    throw new Error("Owner evidence changed; no lock was removed")
  await fs.unlink(current.ownerPath)
  await fs.rmdir(current.directory)
  return { target: input.target, releasedToken: current.token }
}
