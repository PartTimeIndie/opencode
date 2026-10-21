import { expect, test } from "bun:test"
import { requirePluginAPIs } from "../src/api.js"

test("API requirements reject incompatible entrypoints before plugin activation", () => {
  expect(() => requirePluginAPIs("neutral", { app: 2, server: 2 })).not.toThrow()
  expect(() => requirePluginAPIs("future", { app: 3 })).toThrow("requires app API 3; this host provides 2")
  expect(() => requirePluginAPIs("old", { server: 1 })).toThrow("requires server API 1")
  expect(() => requirePluginAPIs("invalid", { core: 2 })).toThrow("invalid core")
  expect(() => requirePluginAPIs("invalid", { app: "2" })).toThrow("invalid app")
  expect(() => requirePluginAPIs("invalid", [])).toThrow("invalid API requirements")
  expect(() => requirePluginAPIs("existing-public-hooks", undefined)).not.toThrow()
})
