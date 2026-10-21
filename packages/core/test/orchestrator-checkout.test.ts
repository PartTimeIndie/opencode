import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { OrchestratorCheckout } from "@opencode-ai/core/session/orchestrator/checkout"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

describe("orchestrator physical checkout identity", () => {
  it.live("shares a root/subdirectory key but keeps independent checkout directories separate", () =>
    Effect.promise(async () => {
      await using tmp = await tmpdir()
      const first = path.join(tmp.path, "first")
      const second = path.join(tmp.path, "second")
      await fs.mkdir(path.join(first, ".git"), { recursive: true })
      await fs.mkdir(path.join(first, "src"))
      await fs.mkdir(second)
      await fs.writeFile(path.join(second, ".git"), "gitdir: ignored-for-identity")
      const resolve = (directory: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* OrchestratorCheckout.Service).resolve(directory)
          }).pipe(Effect.provide(OrchestratorCheckout.layer)),
        )
      const root = await resolve(first)
      expect(await resolve(path.join(first, "src"))).toBe(root)
      expect(await resolve(second)).not.toBe(root)
      if (process.platform === "win32") expect(await resolve(first.toUpperCase())).toBe(root)
      const metadata = path.join(tmp.path, "git-metadata")
      await fs.rename(path.join(first, ".git"), metadata)
      await fs.symlink(metadata, path.join(first, ".git"), process.platform === "win32" ? "junction" : "dir")
      expect(await resolve(first)).toBe(root)
      expect(await resolve(path.join(first, "src"))).toBe(root)
    }),
  )
})
