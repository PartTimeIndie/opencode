import { describe, expect, test } from "bun:test"
import { legacyServerPlugins, parsePluginSpecifier } from "../../src/plugin/shared"

describe("parsePluginSpecifier", () => {
  test("parses standard npm package without version", () => {
    expect(parsePluginSpecifier("acme")).toEqual({
      pkg: "acme",
      version: "latest",
    })
  })

  test("parses standard npm package with version", () => {
    expect(parsePluginSpecifier("acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "1.0.0",
    })
  })

  test("parses scoped npm package without version", () => {
    expect(parsePluginSpecifier("@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })

  test("parses scoped npm package with version", () => {
    expect(parsePluginSpecifier("@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses package with git+https url", () => {
    expect(parsePluginSpecifier("acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+https url", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses unaliased git+ssh url", () => {
    expect(parsePluginSpecifier("git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "git+ssh://git@github.com/opencode/acme.git",
      version: "",
    })
  })

  test("parses npm alias using the alias name", () => {
    expect(parsePluginSpecifier("acme@npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "npm:@opencode/acme@1.0.0",
    })
  })

  test("parses bare npm protocol specifier using the target package", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses unversioned npm protocol specifier", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })
})

describe("legacyServerPlugins", () => {
  test("keeps named plugin exports and skips SDK factories", () => {
    const plugin = async () => ({})
    const factory = () => ({ sdk: true })
    const plugins = legacyServerPlugins({
      createCursor: factory,
      CursorPlugin: plugin,
      default: plugin,
    })
    expect(plugins).toEqual([plugin])
  })

  test("falls back to the default export when it is the plugin", () => {
    const plugin = async () => ({})
    expect(legacyServerPlugins({ default: plugin, createCursor: () => ({}) })).toEqual([plugin])
  })

  test("prefers a callable default export over named helper functions", async () => {
    const plugin = async () => ({})
    let helperCalled = false
    const parseCommandFile = (filePath: string) => {
      helperCalled = true
      if (typeof filePath !== "string") throw new TypeError("path must be a string")
      return filePath
    }

    const plugins = legacyServerPlugins({ default: plugin, parseCommandFile })
    expect(await Promise.all(plugins.map((entry) => entry({})))).toEqual([{}])
    expect(helperCalled).toBe(false)
    expect(plugins).toEqual([plugin])
  })

  test("skips non-plugin named exports instead of throwing", () => {
    const plugin = async () => ({})
    expect(legacyServerPlugins({ CursorPlugin: plugin, VERSION: "1.0.0" })).toEqual([plugin])
  })
})
