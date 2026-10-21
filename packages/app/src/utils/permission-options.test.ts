import { expect, test } from "bun:test"
import { permissionAllowsAlways } from "./permission-options"

test("single-use and unsaveable permissions never offer persistent approval", () => {
  expect(permissionAllowsAlways({ always: ["*"], metadata: { "$opencode.permission.single_use": true } })).toBe(false)
  expect(permissionAllowsAlways({ always: [], metadata: {} })).toBe(false)
  expect(permissionAllowsAlways({ always: ["notes.md"], metadata: {} })).toBe(true)
  expect(permissionAllowsAlways({ always: ["notes.md"], metadata: { "$opencode.permission.single_use": false } })).toBe(true)
})
