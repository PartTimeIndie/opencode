import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { backupPluginReleaseDatabase } from "../script/backup-plugin-release-database"

test("release snapshot includes WAL commits and never restores over later work", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-db-snapshot-"))
  const source = path.join(directory, "live.db")
  const target = path.join(directory, "snapshot.db")
  const database = new Database(source)
  try {
    database.run("PRAGMA journal_mode = WAL")
    database.run("CREATE TABLE work (id TEXT PRIMARY KEY)")
    database.run("INSERT INTO work VALUES ('before')")
    const receipt = await backupPluginReleaseDatabase(source, target)
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.restore).toBe("manual-reconciliation-only")
    database.run("INSERT INTO work VALUES ('after')")
    const snapshot = new Database(target, { readonly: true })
    try { expect(snapshot.query("SELECT id FROM work").all()).toEqual([{ id: "before" }]) }
    finally { snapshot.close() }
    expect(database.query("SELECT id FROM work ORDER BY id").all()).toEqual([{ id: "after" }, { id: "before" }])
    await expect(backupPluginReleaseDatabase(source, target)).rejects.toThrow("already exists")
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
