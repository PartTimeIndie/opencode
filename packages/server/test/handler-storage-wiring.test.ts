import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Layer } from "effect"
import { handlerLayer } from "../src/handlers"

type HandlerRequirements = Layer.Services<typeof handlerLayer>
type UsesApplicationDatabase = Database.Service extends HandlerRequirements ? true : false

// The Event service and every projector must receive the same application-owned
// database. Closing this requirement with another default layer creates a second
// SQLite writer and makes prompt admission deadlock against its own projector.
const usesApplicationDatabase: UsesApplicationDatabase = true

test("inherits the application database for event projection", () => {
  expect(usesApplicationDatabase).toBe(true)
})
