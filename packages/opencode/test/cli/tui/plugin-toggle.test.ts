import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"
import { createBuiltinPlugins } from "@opencode-ai/tui/builtins"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("concurrent transitions initialize and dispose once and permit retry after failure", async () => {
  await using tmp = await tmpdir({ init: async (dir) => {
    const file = path.join(dir, "transition-plugin.ts")
    await Bun.write(file, `export const state = { starts: 0, stops: 0, fail: false, gate: Promise.resolve(), entered: () => {} };
export default { id: "demo.transition", async tui(api) {
  state.starts++;
  api.lifecycle.onDispose(() => { state.stops++ });
  state.entered();
  await state.gate;
  if (state.fail) throw new Error("Fixture initialization failure");
} }`)
    return { spec: pathToFileURL(file).href }
  } })
  const fixture = await import(tmp.extra.spec) as { state: { starts: number; stops: number; fail: boolean; gate: Promise<void>; entered: () => void } }
  const config = createTuiResolvedConfig({ plugin: [tmp.extra.spec], plugin_enabled: { "demo.transition": false },
    plugin_origins: [{ spec: tmp.extra.spec, scope: "local", source: path.join(tmp.path, "tui.json") }] })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    fixture.state.gate = gate.promise
    fixture.state.entered = entered.resolve
    const first = TuiPluginRuntime.activatePlugin("demo.transition")
    const second = TuiPluginRuntime.activatePlugin("demo.transition")
    await entered.promise
    expect(fixture.state.starts).toBe(1)
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(fixture.state.starts).toBe(1)
    await Promise.all([TuiPluginRuntime.deactivatePlugin("demo.transition"), TuiPluginRuntime.deactivatePlugin("demo.transition")])
    expect(fixture.state.stops).toBe(1)
    fixture.state.fail = true
    expect(await TuiPluginRuntime.activatePlugin("demo.transition")).toBe(false)
    expect(TuiPluginRuntime.list().find((item) => item.id === "demo.transition")).toMatchObject({
      enabled: true, active: false, error: "Fixture initialization failure",
    })
    expect(fixture.state.stops).toBe(2)
    fixture.state.fail = false
    expect(await TuiPluginRuntime.activatePlugin("demo.transition")).toBe(true)
    expect(TuiPluginRuntime.list().find((item) => item.id === "demo.transition")?.error).toBeUndefined()
    await TuiPluginRuntime.deactivatePlugin("demo.transition")
    expect(fixture.state.starts).toBe(3)
    expect(fixture.state.stops).toBe(3)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})

test("toggles plugin runtime state by exported id", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "toggle-plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "toggle.txt")

      await Bun.write(
        file,
        `export default {
  id: "demo.toggle",
  tui: async (api, options) => {
    const text = await Bun.file(options.marker).text().catch(() => "")
    await Bun.write(options.marker, text + "start\\n")
    api.lifecycle.onDispose(async () => {
      const next = await Bun.file(options.marker).text().catch(() => "")
      await Bun.write(options.marker, next + "stop\\n")
    })
  },
}
`,
      )

      return {
        spec,
        marker,
      }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const config = createTuiResolvedConfig({
    plugin: [[tmp.extra.spec, { marker: tmp.extra.marker }]],
    plugin_enabled: {
      "demo.toggle": false,
    },
    plugin_origins: [
      {
        spec: [tmp.extra.spec, { marker: tmp.extra.marker }],
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
    ],
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi()

  try {
    await TuiPluginRuntime.init({ api, config })

    await expect(fs.readFile(tmp.extra.marker, "utf8")).rejects.toThrow()
    expect(TuiPluginRuntime.list().find((item) => item.id === "demo.toggle")).toEqual({
      id: "demo.toggle",
      source: "file",
      spec: tmp.extra.spec,
      target: tmp.extra.spec,
      enabled: false,
      active: false,
    })

    await expect(TuiPluginRuntime.activatePlugin("demo.toggle")).resolves.toBe(true)
    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("start\n")
    expect(api.kv.get("plugin_enabled", {})).toEqual({
      "demo.toggle": true,
    })

    await expect(TuiPluginRuntime.deactivatePlugin("demo.toggle")).resolves.toBe(true)
    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("start\nstop\n")
    expect(api.kv.get("plugin_enabled", {})).toEqual({
      "demo.toggle": false,
    })

    await expect(TuiPluginRuntime.activatePlugin("missing.id")).resolves.toBe(false)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})

test("deactivating plugin pops pushed mode", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "mode-plugin.ts")
      const spec = pathToFileURL(file).href

      await Bun.write(
        file,
        `export default {
  id: "demo.mode",
  tui: async (api) => {
    api.mode.push("demo.mode")
  },
}
`,
      )

      return { spec }
    },
  })

  const stack: { id: symbol; mode: string }[] = []
  let popCount = 0
  const api = createTuiPluginApi({
    mode: {
      current: () => stack.at(-1)?.mode ?? "base",
      push(mode) {
        const id = Symbol(mode)
        let active = true
        stack.push({ id, mode })
        return () => {
          if (!active) return
          active = false
          popCount += 1
          const index = stack.findIndex((item) => item.id === id)
          if (index !== -1) stack.splice(index, 1)
        }
      },
    },
  })
  const config = createTuiResolvedConfig({
    plugin: [tmp.extra.spec],
    plugin_origins: [{ spec: tmp.extra.spec, scope: "local", source: path.join(tmp.path, "tui.json") }],
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)

  try {
    await TuiPluginRuntime.init({ api, config })

    expect(api.mode.current()).toBe("demo.mode")
    expect(popCount).toBe(0)

    await expect(TuiPluginRuntime.deactivatePlugin("demo.mode")).resolves.toBe(true)

    expect(api.mode.current()).toBe("base")
    expect(popCount).toBe(1)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
  }
})

test("kv plugin_enabled overrides tui config on startup", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "startup-plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "startup.txt")

      await Bun.write(
        file,
        `export default {
  id: "demo.startup",
  tui: async (_api, options) => {
    await Bun.write(options.marker, "on")
  },
}
`,
      )

      return {
        spec,
        marker,
      }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const config = createTuiResolvedConfig({
    plugin: [[tmp.extra.spec, { marker: tmp.extra.marker }]],
    plugin_enabled: {
      "demo.startup": false,
    },
    plugin_origins: [
      {
        spec: [tmp.extra.spec, { marker: tmp.extra.marker }],
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
    ],
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi()
  api.kv.set("plugin_enabled", {
    "demo.startup": true,
  })

  try {
    await TuiPluginRuntime.init({ api, config })

    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("on")
    expect(TuiPluginRuntime.list().find((item) => item.id === "demo.startup")).toEqual({
      id: "demo.startup",
      source: "file",
      spec: tmp.extra.spec,
      target: tmp.extra.spec,
      enabled: true,
      active: true,
    })
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})

test("loads independently packaged preinstalled plugins and preserves activation defaults", async () => {
  await using tmp = await tmpdir()
  const config = createTuiResolvedConfig()
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi()

  try {
    await TuiPluginRuntime.init({ api, config })

    const packages = createBuiltinPlugins()
    expect(TuiPluginRuntime.list()).toHaveLength(packages.length)
    for (const spec of packages) {
      const manifest = await Bun.file(new URL("package.json", spec)).json()
      expect(manifest.opencode.api.tui).toBe(2)
      expect(TuiPluginRuntime.list().find((item) => item.spec === spec)).toMatchObject({ source: "file", target: spec })
    }
    const whichKey = packages.find((spec) => spec.endsWith("/which-key/"))!
    expect(TuiPluginRuntime.list().find((item) => item.id === "internal:plugin-manager")).toMatchObject({
      enabled: true,
      active: true,
    })
    expect(TuiPluginRuntime.list().find((item) => item.id === "which-key")).toEqual({
      id: "which-key",
      source: "file",
      spec: whichKey,
      target: whichKey,
      enabled: false,
      active: false,
    })

    await expect(TuiPluginRuntime.activatePlugin("which-key")).resolves.toBe(true)
    expect(TuiPluginRuntime.list().find((item) => item.id === "which-key")).toEqual({
      id: "which-key",
      source: "file",
      spec: whichKey,
      target: whichKey,
      enabled: true,
      active: true,
    })
    expect(api.kv.get("plugin_enabled", {})).toEqual({
      "which-key": true,
    })
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
  }
})
