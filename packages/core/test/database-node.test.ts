import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"

test("the app graph reuses the default database layer", () => {
  expect(Database.node.implementation).toBe(Database.defaultLayer)
})
