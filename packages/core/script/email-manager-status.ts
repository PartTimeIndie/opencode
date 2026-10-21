import { readOwnedMailView } from "../src/mail/manager-view"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Missing --${name}`)
  return args[index + 1]!
}
if (args.length !== 6 || new Set(args.filter((_, index) => index % 2 === 0)).size !== 3)
  throw new Error("Use --view-id <id> --session-id <current-id> --directory <absolute-directory>")
const view = await readOwnedMailView(option("view-id"), { sessionID: option("session-id"), directory: option("directory"), revision: 1 })
console.log(JSON.stringify({ id: view.id, state: view.state, result: view.result ?? [] }))
