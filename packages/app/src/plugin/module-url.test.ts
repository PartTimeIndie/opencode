import { describe, expect, test } from "bun:test"
import { pluginModuleUrl } from "./module-url"

const plugin = {
  id: "prompt-improve-app",
  version: "1.0.0-abc",
  module: "/app/plugin/prompt-improve-app/1.0.0-abc/index.js",
  hash: "entry-hash",
}

describe("plugin module URL", () => {
  test("resolves versioned modules against the authenticated web origin", () => {
    expect(
      pluginModuleUrl(plugin, "https://phone.example.test", {
        protocol: "https:",
        origin: "https://phone.example.test",
      }),
    ).toBe("https://phone.example.test/app/plugin/prompt-improve-app/1.0.0-abc/index.js?hash=entry-hash")
  })

  test("keeps the desktop renderer mapping", () => {
    expect(
      pluginModuleUrl(plugin, "http://127.0.0.1:4096", {
        protocol: "oc:",
        origin: "null",
      }),
    ).toBe("oc://renderer/app/plugin/prompt-improve-app/1.0.0-abc/index.js?hash=entry-hash")
  })

  test("allows the Vite development renderer to use its configured server", () => {
    expect(
      pluginModuleUrl(plugin, "http://127.0.0.1:4096", {
        protocol: "http:",
        origin: "http://127.0.0.1:3000",
        allowCrossOrigin: true,
      }),
    ).toBe("http://127.0.0.1:4096/app/plugin/prompt-improve-app/1.0.0-abc/index.js?hash=entry-hash")
  })

  test("rejects absolute, foreign, credentialed, and mismatched module locations", () => {
    expect(() =>
      pluginModuleUrl({ ...plugin, module: "https://evil.example/app.js" }, "https://phone.example.test"),
    ).toThrow("relative server path")
    expect(() => pluginModuleUrl(plugin, "https://user:secret@phone.example.test")).toThrow("without URL credentials")
    expect(() =>
      pluginModuleUrl(plugin, "http://127.0.0.1:4096", { protocol: "https:", origin: "https://phone.example.test" }),
    ).toThrow("current web app origin")
    expect(() =>
      pluginModuleUrl({ ...plugin, module: "/app/plugin/other/1.0.0-abc/index.js" }, "https://phone.example.test"),
    ).toThrow("manifest identity")
  })

  test("rejects query injection and path traversal", () => {
    expect(() =>
      pluginModuleUrl(
        { ...plugin, module: `${plugin.module}?next=https://evil.example` },
        "https://phone.example.test",
      ),
    ).toThrow("query parameters")
    expect(() =>
      pluginModuleUrl(
        { ...plugin, module: "/app/plugin/prompt-improve-app/1.0.0-abc/../package.json" },
        "https://phone.example.test",
      ),
    ).toThrow("manifest identity")
  })
})
