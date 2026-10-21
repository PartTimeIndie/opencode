import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "../global"
import { Flock } from "../util/flock"

export type Account = {
  id: string
  name: string
  email: string
  secretID: string
  enabled: boolean
  drafts?: string
  sent?: string
  trash?: string
  archive?: string
}

export type Accounts = { version: 1; revision: number; accounts: Account[] }

export async function load(config = Global.Path.config): Promise<Accounts> {
  const text = await readFile(join(config, "mail-accounts.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return { version: 1, revision: 0, accounts: [] }
  const data: unknown = JSON.parse(text)
  if (!isAccounts(data)) throw new Error("Invalid mail account configuration")
  return data
}

export async function save(next: Account[], revision: number, config = Global.Path.config) {
  return Flock.withLock(`mail-accounts:${config}`, async () => {
    const current = await load(config)
    if (current.revision !== revision) throw new Error("Mail accounts changed; reload before saving")
    const value = { version: 1 as const, revision: revision + 1, accounts: next }
    if (!isAccounts(value)) throw new Error("Invalid mail account configuration")
    await mkdir(config, { recursive: true })
    const file = join(config, "mail-accounts.json")
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true })
    }
    return value
  })
}

function isAccounts(value: unknown): value is Accounts {
  if (!value || typeof value !== "object") return false
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !["version", "revision", "accounts"].includes(key))) return false
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.accounts)) return false
  if (data.accounts.length > 50) return false
  const ids = new Set<string>()
  const addresses = new Set<string>()
  return data.accounts.every((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false
    const account = entry as Record<string, unknown>
    if (Object.keys(account).some((key) => !["id", "name", "email", "secretID", "enabled", "drafts", "sent", "trash", "archive"].includes(key))) return false
    if (typeof account.id !== "string" || !/^gmx-[a-z0-9-]{1,50}$/.test(account.id) || ids.has(account.id)) return false
    if (typeof account.email !== "string" || !/^[^\s<>@]+@(?:gmx\.de|gmx\.net|gmx\.com)$/i.test(account.email)) return false
    if (addresses.has(account.email.toLowerCase())) return false
    if (typeof account.name !== "string" || !account.name.trim() || account.name.length > 100) return false
    if (typeof account.secretID !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(account.secretID)) return false
    if (typeof account.enabled !== "boolean") return false
    if ([account.drafts, account.sent, account.trash, account.archive].some((folder) => folder !== undefined && (typeof folder !== "string" || !folder || /[\r\n]/.test(folder)))) return false
    ids.add(account.id)
    addresses.add(account.email.toLowerCase())
    return true
  })
}
