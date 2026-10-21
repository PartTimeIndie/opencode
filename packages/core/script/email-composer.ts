import { readFile } from "node:fs/promises"
import { load } from "../src/mail/accounts"
import { composer } from "../src/mail/composer"
import type { Outgoing } from "../src/mail/message"

const args = process.argv.slice(2)
const option = (key: string) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : undefined
const provider = option("provider")
if (provider !== "gmail" && provider !== "gmx") throw new Error("Use --provider gmail|gmx")
const account = option("account")
const sender = provider === "gmx" ? (await load()).accounts.find((item) => item.id === account && item.enabled)?.email : undefined
if (provider === "gmx" && !sender) throw new Error("GMX account not configured or disabled")
const path = option("input")
const message: Partial<Outgoing> | undefined = path ? JSON.parse(await readFile(path, "utf8")) : undefined
console.log(JSON.stringify({ mode: "interactive", ...composer({ provider, account, sender, message }) }))
