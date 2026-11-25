import { describe, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { ConfigFileTarget } from "@opencode-ai/core/config/file-target"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

describe("shared Settings document target", () => {
  it.live("uses the existing global precedence and the project Settings destination", () =>
    Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(async () => {
      expect(ConfigFileTarget.global(tmp.path)).toBe(path.join(tmp.path, "opencode.jsonc"))
      await fs.writeFile(path.join(tmp.path, "config.json"), "{}")
      expect(ConfigFileTarget.global(tmp.path)).toBe(path.join(tmp.path, "config.json"))
      await fs.writeFile(path.join(tmp.path, "opencode.json"), "{}")
      expect(ConfigFileTarget.global(tmp.path)).toBe(path.join(tmp.path, "opencode.json"))
      await fs.writeFile(path.join(tmp.path, "opencode.jsonc"), "{}")
      expect(ConfigFileTarget.global(tmp.path)).toBe(path.join(tmp.path, "opencode.jsonc"))
      expect(ConfigFileTarget.project(tmp.path)).toBe(path.join(tmp.path, ".opencode", "opencode.json"))
    }), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())),
  )
})
