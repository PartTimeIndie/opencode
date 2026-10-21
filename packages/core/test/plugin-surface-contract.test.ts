import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { SurfaceSchema } from "@opencode-ai/core/surface/schema"

const pluginRoot = path.resolve(import.meta.dir, "../../../.opencode/plugin-sources")

function walk(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const next = path.join(dir, entry)
    if (statSync(next).isDirectory()) files.push(...walk(next))
    else if (entry.endsWith(".js") || entry.endsWith(".ts")) files.push(next)
  }
  return files
}

describe("plugin surface contract", () => {
  test("SurfaceSchema still rejects raw html kinds", () => {
    expect(() => Schema.decodeUnknownSync(SurfaceSchema.Kind)("html")).toThrow()
  })

  test("plugin-sources innerHTML usages are tracked for hard cutover", () => {
    const files = walk(pluginRoot)
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8")
      return text.includes("innerHTML") ? [path.relative(pluginRoot, file).replaceAll("\\", "/")] : []
    })
    // Hard cutover migrates these off innerHTML onto SurfaceSchema host widgets.
    expect(hits.sort()).toEqual([])
  })
})
