import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createMediaRegistry } from "../../src/plugin/media"
import { absolutePluginDirectory, hostRouteDirectory, sameDirectory } from "../../src/plugin/directory"

describe("plugin directory matching", () => {
  test("normalizes a relative project scope before it reaches server plugins", () => {
    expect(absolutePluginDirectory(".")).toBe(path.resolve("."))
    expect(path.isAbsolute(absolutePluginDirectory(""))).toBeTrue()
  })

  test("keeps an already absolute host path host-owned", () => {
    const scope = absolutePluginDirectory("C:/GitRepros/opencode")
    expect(path.win32.isAbsolute(scope)).toBeTrue()
    expect(scope).toBe(path.win32.resolve("C:/GitRepros/opencode"))
  })

  test("resolves POSIX root paths with POSIX semantics off-Windows", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })
    try {
      expect(absolutePluginDirectory("/tmp/project")).toBe("/tmp/project")
      expect(absolutePluginDirectory("C:\\repo")).toBe("C:\\repo")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform })
    }
  })

  test("registers adapters under the normalized scope and resolves lookups from the raw sentinel", () => {
    const registry = createMediaRegistry()
    const scope = absolutePluginDirectory("global")
    const release = registry.register(scope, {
      providerID: "openrouter",
      transcription: {
        supports: (modelID) => modelID === "mistralai/voxtral-small-24b-2507",
        transcribe: async (input) => ({ text: "", providerID: "openrouter", modelID: input.modelID }),
      },
    })
    try {
      expect(registry.list("global").map((adapter) => adapter.providerID)).toEqual(["openrouter"])
    } finally {
      release()
    }
  })

  test("matches Windows directories across slash and case differences", () => {
    expect(sameDirectory("C:/GitRepros/opencode", "c:\\gitrepros\\opencode")).toBeTrue()
  })

  test("matches equivalent directories with dot segments", () => {
    expect(sameDirectory("C:/GitRepros/opencode/packages/..", "C:\\GitRepros\\opencode")).toBeTrue()
  })

  test("rejects different Windows directories", () => {
    expect(sameDirectory("C:/GitRepros/opencode", "C:\\GitRepros\\opencode-goal-plugin")).toBeFalse()
  })
})

describe("hostRouteDirectory", () => {
  const options = { globalDirectory: "C:\\host-data\\desktop-global" }

  test("maps the global sentinel to the host-owned directory", () => {
    expect(hostRouteDirectory("global", options)).toBe(options.globalDirectory)
  })

  test("uses the resolved global scope for media admission and keeps other scopes isolated", () => {
    const registry = createMediaRegistry()
    const scope = hostRouteDirectory("global", options)!
    const release = registry.register(scope, {
      providerID: "openrouter",
      transcription: {
        supports: (modelID) => modelID === "openai/gpt-4o-mini-transcribe",
        transcribe: async (input) => ({ text: "", providerID: "openrouter", modelID: input.modelID }),
      },
    })
    try {
      expect(registry.list(scope)[0].transcription?.supports("openai/gpt-4o-mini-transcribe")).toBeTrue()
      expect(registry.list("global")).toEqual([])
      expect(registry.list("C:\\projects\\unrelated")).toEqual([])
    } finally {
      release()
    }
  })

  test("rejects relative directories so they cannot resolve against the server cwd", () => {
    expect(hostRouteDirectory("global/projects/demo", options)).toBeUndefined()
    expect(hostRouteDirectory("foo", options)).toBeUndefined()
    expect(hostRouteDirectory("global/", options)).toBeUndefined()
    expect(hostRouteDirectory("", options)).toBeUndefined()
  })

  test("passes absolute directories through unchanged", () => {
    const absolute = process.platform === "win32" ? "C:\\projects\\demo" : "/srv/project/demo"
    expect(hostRouteDirectory(absolute, options)).toBe(absolute)
  })
})
