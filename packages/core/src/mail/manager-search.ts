import type { MailDestination } from "./manager"

export function gmailSourceLabel(value: string | undefined, destinations: readonly MailDestination[]) {
  if (!value || value === "INBOX") return "INBOX"
  if (!destinations.some((item) => item.kind === "label" && item.id === value))
    throw new Error("Unknown Gmail label ID; use an ID from the available labels")
  return value
}

export function managerArguments(args: readonly string[]) {
  const allowed = new Set(["provider", "account", "directory", "session-id", "since", "limit", "from", "subject", "mailbox"])
  const entries = args.reduce<Record<string, string>>((result, item, index) => {
    if (index % 2) return result
    const key = item.startsWith("--") ? item.slice(2) : ""
    if (!allowed.has(key) || result[key] !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--"))
      throw new Error("Invalid or duplicate email-manager option")
    result[key] = args[index + 1]!
    return result
  }, {})
  if (args.length % 2) throw new Error("Invalid email-manager option")
  if (entries.provider !== "gmail" && entries.provider !== "gmx") throw new Error("Use --provider gmail|gmx")
  if (entries.provider === "gmx" && !entries.account?.startsWith("gmx-")) throw new Error("GMX account required")
  if (entries.provider === "gmail" && entries.account) throw new Error("Gmail does not use a GMX account ID")
  if (!/^ses[a-zA-Z0-9_-]+$/.test(entries["session-id"] ?? "") || !entries.directory ||
    !/^(?:[A-Za-z]:[\\/]|\/)/.test(entries.directory)) throw new Error("Current Session ID and absolute directory required")
  return entries
}
