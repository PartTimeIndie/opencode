export * as SnapshotActivity from "./snapshot-activity"

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const FILE_NAME = "opencode-snapshot-activity.json"

export type Metadata = {
  readonly version: 1
  readonly lastUsedAt: number
}

export async function record(repository: string, now = Date.now()) {
  await mkdir(repository, { recursive: true })
  const target = path.join(repository, FILE_NAME)
  const temporary = path.join(repository, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, lastUsedAt: now } satisfies Metadata)}\n`, {
      encoding: "utf8",
      flag: "wx",
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function read(repository: string): Promise<Metadata | undefined> {
  const text = await readFile(path.join(repository, FILE_NAME), "utf8").catch(() => undefined)
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.lastUsedAt !== "number" ||
      !Number.isSafeInteger(value.lastUsedAt) ||
      value.lastUsedAt < 0
    )
      return undefined
    return { version: 1, lastUsedAt: value.lastUsedAt }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
