import { managerComposer } from "../src/mail/manager-composer"
import { createMailView } from "../src/mail/manager-view"
import { gmailDestinations, gmailIdentity, gmailSearch } from "../src/mail/manager-gmail"
import { gmxAccount, gmxDestinations, gmxSearch } from "../src/mail/manager-gmx"
import { gmailSourceLabel, managerArguments } from "../src/mail/manager-search"

const options = managerArguments(process.argv.slice(2))
const provider = options.provider as "gmail" | "gmx"
const accountID = provider === "gmx" ? options.account! : "gmail-default"
const since = options.since ? new Date(options.since) : undefined
if (since && Number.isNaN(since.getTime())) throw new Error("Invalid --since date")
const limit = options.limit ? Number(options.limit) : 20
if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Limit must be 1 to 50")
const account = provider === "gmx" ? await gmxAccount(accountID) : undefined
const address = account?.email ?? await gmailIdentity()
const destinations = provider === "gmx" ? await gmxDestinations(accountID) : await gmailDestinations()
const mailbox = provider === "gmail" ? gmailSourceLabel(options.mailbox, destinations) : options.mailbox ?? "INBOX"
const rows = provider === "gmx"
  ? await gmxSearch({ accountID, mailbox, from: options.from, subject: options.subject, since, limit })
  : await gmailSearch({ from: options.from, subject: options.subject, since, limit, labelID: mailbox })
const view = await createMailView({ sessionID: options["session-id"]!, directory: options.directory!, accountID, address, provider,
  mailbox, rows, destinations })
console.log(JSON.stringify({ mode: "interactive", ...managerComposer(view) }))
