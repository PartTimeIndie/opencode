import { describe, expect, test } from "bun:test"
import { pluginAssetTarget } from "./plugin-asset-url"

describe("plugin asset URL", () => {
  const server = "http://127.0.0.1:4098"

  test("forwards plugin assets with one canonical encoding pass", () => {
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/index.js")).toBe(
      "http://127.0.0.1:4098/app/plugin/example/1.0.0/index.js",
    )
    expect(pluginAssetTarget(server, "oc://plugin/%40scope%2Fname/1.0.0/assets/a%20b%25%2B.js")).toBe(
      "http://127.0.0.1:4098/app/plugin/%40scope%2Fname/1.0.0/assets/a%20b%25%2B.js",
    )
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/%252e%252e.js")).toBe(
      "http://127.0.0.1:4098/app/plugin/example/1.0.0/%252e%252e.js",
    )
  })

  test("accepts the renderer compatibility path and drops query and hash", () => {
    expect(
      pluginAssetTarget(`${server}/base/?old=1#old`, "oc://renderer/app/plugin/example/1.0.0/index.js?x=1#top"),
    ).toBe("http://127.0.0.1:4098/base/app/plugin/example/1.0.0/index.js")
  })

  test("rejects malformed or dangerous segments", () => {
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/%ZZ.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/../secret.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/%2e%2e/secret.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/%5Csecret.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0/a//b.js")).toBeUndefined()
  })

  test("rejects other protocols, hosts, credentials, and paths", () => {
    expect(pluginAssetTarget(server, "https://plugin/example/1.0.0/index.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://other/example/1.0.0/index.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://user@plugin/example/1.0.0/index.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin:80/example/1.0.0/index.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://renderer/wrong/example/1.0.0/index.js")).toBeUndefined()
    expect(pluginAssetTarget(server, "oc://plugin/example/1.0.0")).toBeUndefined()
  })
})
