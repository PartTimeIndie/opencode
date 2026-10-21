import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { appPluginMetadata } from "@/plugin/app/assets"

describe("app plugin capability manifest", () => {
  test("keeps declared skill-content capability in the client manifest", () => {
    // Regression for the silent improvement-skill loss: the server stripped
    // host:skill-content from manifests, so every app plugin skills.resolve
    // failed with "Missing host:skill-content capability".
    const meta = appPluginMetadata({
      opencode: { app: { capabilities: ["host:skills", "host:skill-content", "host:unknown-capability"] } },
    })
    expect(meta.capabilities).toContain("host:skills")
    expect(meta.capabilities).toContain("host:skill-content")
    expect(meta.capabilities).not.toContain("host:unknown-capability")
  })

  test("keeps the speech plugin's real manifest capability list intact", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../.opencode/plugin-sources/speech-to-text-app/package.json", import.meta.url), "utf8"),
    )
    expect(appPluginMetadata(pkg).capabilities).toContain("host:skill-content")
  })

  test("falls back to legacy capabilities without a declaration", () => {
    const meta = appPluginMetadata({ opencode: { app: {} } })
    expect(Array.isArray(meta.capabilities)).toBe(true)
    expect(meta.capabilities.length).toBeGreaterThan(0)
  })
})
