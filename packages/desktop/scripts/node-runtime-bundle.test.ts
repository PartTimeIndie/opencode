import { describe, expect, test } from "bun:test"
import { findForbiddenNodeRuntimeAPIs } from "./node-runtime-bundle"

describe("Node runtime bundle guard", () => {
  test("finds Bun imports and every forbidden runtime API", () => {
    expect(
      findForbiddenNodeRuntimeAPIs(`
        import { Database } from "bun:sqlite"
        import "bun:jsc"
        import("bun:test")
        require("bun:ffi")
        Bun.CryptoHasher
        Bun.spawn([])
        Bun.file("fixture")
        Bun.hash("fixture")
        Bun.listen({})
        Bun.serve({})
        Bun.sleep(25)
        Bun.write("fixture", "value")
      `),
    ).toEqual([
      'from "bun:sqlite',
      'import "bun:jsc',
      'import("bun:test',
      'require("bun:ffi',
      "Bun.CryptoHasher",
      "Bun.spawn",
      "Bun.file",
      "Bun.hash",
      "Bun.listen",
      "Bun.serve",
      "Bun.sleep",
      "Bun.write",
    ])
  })

  test("allows guarded optional Bun integrations", () => {
    expect(findForbiddenNodeRuntimeAPIs('typeof Bun === "undefined" ? undefined : Bun.$')).toEqual([])
  })

  test("keeps shared Electron server sources free of Bun runtime APIs", async () => {
    const sources = await Promise.all(
      [
        new URL("../../core/src/util/flock.ts", import.meta.url),
        new URL("../../opencode/src/project/vcs.ts", import.meta.url),
        new URL("../../opencode/src/storage-migration-runtime.ts", import.meta.url),
      ].map((file) => Bun.file(file).text()),
    )
    expect(sources.flatMap(findForbiddenNodeRuntimeAPIs)).toEqual([])
  })
})
