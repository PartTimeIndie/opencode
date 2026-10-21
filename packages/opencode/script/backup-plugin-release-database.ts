import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

/** A consistent SQLite snapshot includes committed WAL data without changing the live database. */
export async function backupPluginReleaseDatabase(source: string, target: string) {
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error("Database paths must be absolute")
  if (fs.existsSync(target)) throw new Error("Database backup already exists")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const database = new Database(source, { readonly: true })
  try {
    database.run("PRAGMA busy_timeout = 10000")
    database.run("VACUUM INTO ?", [target])
  } finally { database.close() }
  const snapshot = new Database(target, { readonly: true })
  try {
    if (snapshot.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Database backup failed integrity check")
  } finally { snapshot.close() }
  const hash = createHash("sha256")
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk)
  const receipt = { source, target, createdAt: new Date().toISOString(), sha256: hash.digest("hex"), restore: "manual-reconciliation-only" }
  fs.writeFileSync(`${target}.json`, JSON.stringify(receipt, null, 2))
  return receipt
}

if (import.meta.main) console.log(await backupPluginReleaseDatabase(process.argv[2], process.argv[3]))
