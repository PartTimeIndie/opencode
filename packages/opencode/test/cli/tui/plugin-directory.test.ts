import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../../fixture/fixture"
import { internalTuiPlugins } from "../../../src/plugin/tui/internal"
import { createBuiltinPlugins } from "@opencode-ai/tui/builtins"
import { providerPackageDirectory } from "@opencode-ai/core/plugin/provider-loader"

test("preinstalled packages select explicit directory, installed marker, then source", async () => {
  await using tmp = await tmpdir()
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!
  const tuiDirectory = process.env.OPENCODE_TUI_PLUGIN_DIR
  const providerDirectory = process.env.OPENCODE_PROVIDER_PLUGIN_DIR
  try {
    Object.defineProperty(process, "execPath", { ...executable, value: path.join(tmp.path, "opencode.exe") })
    delete process.env.OPENCODE_TUI_PLUGIN_DIR
    delete process.env.OPENCODE_PROVIDER_PLUGIN_DIR
    expect(internalTuiPlugins().map((item) => item.spec)).toEqual(createBuiltinPlugins())
    expect(path.resolve(providerPackageDirectory())).toBe(path.resolve(import.meta.dir, "../../../../provider-plugins"))
    const installedTui = path.join(tmp.path, "plugin-packages/tui")
    const installedProvider = path.join(tmp.path, "plugin-packages/provider")
    await Bun.write(path.join(installedTui, "release-manifest.json"), "{}")
    await Bun.write(path.join(installedProvider, "release-manifest.json"), "{}")
    expect(internalTuiPlugins().map((item) => item.spec)).toEqual(createBuiltinPlugins(pathToFileURL(installedTui + path.sep)))
    expect(providerPackageDirectory()).toBe(installedProvider)
    process.env.OPENCODE_TUI_PLUGIN_DIR = path.join(tmp.path, "explicit-tui")
    process.env.OPENCODE_PROVIDER_PLUGIN_DIR = path.join(tmp.path, "explicit-provider")
    expect(internalTuiPlugins().map((item) => item.spec)).toEqual(createBuiltinPlugins(pathToFileURL(process.env.OPENCODE_TUI_PLUGIN_DIR + path.sep)))
    expect(providerPackageDirectory()).toBe(process.env.OPENCODE_PROVIDER_PLUGIN_DIR)
  } finally {
    Object.defineProperty(process, "execPath", executable)
    if (tuiDirectory === undefined) delete process.env.OPENCODE_TUI_PLUGIN_DIR
    else process.env.OPENCODE_TUI_PLUGIN_DIR = tuiDirectory
    if (providerDirectory === undefined) delete process.env.OPENCODE_PROVIDER_PLUGIN_DIR
    else process.env.OPENCODE_PROVIDER_PLUGIN_DIR = providerDirectory
  }
})
