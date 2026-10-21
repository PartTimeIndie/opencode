import { compactEventDatabase, resetEventCompaction } from "../src/event-compaction"

if (import.meta.main) {
  const filename = argument("--db")
  if (!filename) throw new Error("Usage: bun run script/compact-event-db.ts --db <absolute-path-to-opencode.db>")
  if (Bun.argv.includes("--restart")) await resetEventCompaction(filename)
  const result = await compactEventDatabase(filename)
  console.log(JSON.stringify(result, null, 2))
}

function argument(name: string) {
  const index = Bun.argv.indexOf(name)
  return index === -1 ? undefined : Bun.argv[index + 1]
}
