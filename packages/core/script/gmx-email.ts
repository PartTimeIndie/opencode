import { readFile } from "node:fs/promises"
import { load, save } from "../src/mail/accounts"
import type { Account } from "../src/mail/accounts"
import { deliver, preview, status } from "../src/mail/delivery"
import { checkConnection, folders, read, search } from "../src/mail/gmx"
import type { Outgoing } from "../src/mail/message"

const [command, ...args] = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(`--${name}`) + 1]
const requireOption = (name: string) => {
  if (!args.includes(`--${name}`) || !option(name) || option(name).startsWith("--")) throw new Error(`Missing --${name}`)
  return option(name)
}
const config = args.includes("--config") ? requireOption("config") : undefined

async function account(): Promise<Account> {
  const found = (await load(config)).accounts.find((item) => item.id === requireOption("account"))
  if (!found || !found.enabled) throw new Error("GMX account not configured or disabled")
  return found
}

async function message(): Promise<Outgoing> {
  const file = await readFile(requireOption("input"), "utf8")
  if (file.length > 150_000) throw new Error("Mail input too large")
  const value: unknown = JSON.parse(file)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mail input")
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some((key) => !["from", "to", "cc", "bcc", "subject", "text", "html", "attachments", "inReplyTo", "references"].includes(key)))
    throw new Error("Unsupported mail input field")
  if (typeof fields.from !== "string" || typeof fields.subject !== "string" || typeof fields.text !== "string" ||
    !Array.isArray(fields.to) || !fields.to.every((item) => typeof item === "string") ||
    ["cc", "bcc", "attachments", "references"].some((name) => fields[name] !== undefined && (!Array.isArray(fields[name]) || !(fields[name] as unknown[]).every((item) => typeof item === "string"))) ||
    ["html", "inReplyTo"].some((name) => fields[name] !== undefined && typeof fields[name] !== "string"))
    throw new Error("Invalid mail input")
  return value as Outgoing
}

async function main() {
  if (command === "accounts") return (await load(config)).accounts.map((item) => ({ id: item.id, name: item.name, email: item.email, enabled: item.enabled }))
  if (command === "register") {
    const current = await load(config)
    const entry = { id: requireOption("account"), name: requireOption("name"), email: requireOption("email"), secretID: requireOption("secret-id"), enabled: true,
      ...(args.includes("--drafts") ? { drafts: requireOption("drafts") } : {}),
      ...(args.includes("--sent") ? { sent: requireOption("sent") } : {}) }
    const next = [...current.accounts.filter((item) => item.id !== entry.id), entry]
    await save(next, current.revision, config)
    return { account: entry.id, email: entry.email, configured: true }
  }
  if (command === "check") return { connected: await checkConnection(await account()) }
  if (command === "folders") return folders(await account())
  if (command === "search") return search(await account(), { from: args.includes("--from") ? requireOption("from") : undefined,
    subject: args.includes("--subject") ? requireOption("subject") : undefined })
  if (command === "read") return read(await account(), Number(requireOption("uid")), requireOption("uid-validity"))
  if (command === "preview") return preview(await account(), await message())
  if (command === "status") return status(requireOption("request-id"))
  if (command === "send" || command === "draft") {
    if (!args.includes("--approved")) throw new Error("Explicit final-message approval required")
    return deliver({ account: await account(), message: await message(), intent: command,
      requestID: requireOption("request-id"), expectedHash: requireOption("approval-hash") })
  }
  throw new Error("Use accounts, register, check, folders, search, read, preview, status, send or draft")
}

try {
  console.log(JSON.stringify(await main()))
} catch (error) {
  // Provider/parse errors can contain sensitive mail data or credentials; do not log them.
  const safe = error instanceof Error && /^(Missing --|Invalid |GMX account not configured|Sender does not match|The message or attachment has changed|Request has already started|Request ID is already bound|Explicit final-message approval required|Use accounts)/.test(error.message)
  console.error(safe && error instanceof Error ? error.message : "GMX operation failed; inspect the request status before retrying")
  process.exitCode = 1
}
