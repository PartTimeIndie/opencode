export * as AppState from "./app-state"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, normalize, resolve } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

type Scope = {
  data: string
  database: string
}

export function directory(input: Scope = { data: Global.Path.data, database: Database.path() }) {
  const root = join(input.data, "app-state")
  if (databaseIdentity(input.database) === databaseIdentity(join(input.data, "opencode.db"))) return root
  return join(root, "databases", Hash.fast(databaseIdentity(input.database)).slice(0, 16))
}

export function file(key: string, input?: Scope) {
  return join(directory(input), `${key}.json`)
}

export async function read(key: string, input?: Scope) {
  const text = await readFile(file(key, input), "utf8").catch(() => undefined)
  if (!text) return {}
  const data = JSON.parse(text) as unknown
  return isRecord(data) ? data : {}
}

export async function write(key: string, data: Record<string, unknown>, input?: Scope) {
  const target = file(key, input)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`)
}

function databaseIdentity(value: string) {
  if (value === ":memory:") return value
  const path = normalize(resolve(value))
  return process.platform === "win32" ? path.toLowerCase() : path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
