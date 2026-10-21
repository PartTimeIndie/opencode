import { describe, expect, test } from "bun:test"
import { requireOfflineStorageMigration } from "../../src/cli/cmd/storage"

describe("storage migration CLI", () => {
  test("allows live dry-runs but requires explicit offline confirmation before mutation", () => {
    expect(requireOfflineStorageMigration({ mode: "dry-run" })).toBeUndefined()
    expect(requireOfflineStorageMigration({ mode: "prepare", offline: true })).toBeUndefined()
    expect(requireOfflineStorageMigration({ mode: "activate", offline: true })).toBeUndefined()
    expect(requireOfflineStorageMigration({ mode: "rollback", offline: true })).toBeUndefined()
    expect(() => requireOfflineStorageMigration({ mode: "prepare" })).toThrow("prepare requires --offline")
    expect(() => requireOfflineStorageMigration({ mode: "activate" })).toThrow("activate requires --offline")
    expect(() => requireOfflineStorageMigration({ mode: "rollback" })).toThrow("rollback requires --offline")
  })
})
