import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { tmpdir } from "./fixture/tmpdir"

const project = async () => {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "package.json"), "{}\n")
  await Bun.write(
    path.join(tmp.path, "user.npmrc"),
    "registry=https://user.invalid/\n@acme:registry=https://user-acme.invalid/\nignore-scripts=false\nomit[]=peer\n",
  )
  await Bun.write(
    path.join(tmp.path, "global.npmrc"),
    "registry=https://global.invalid/\n@acme:registry=https://global-acme.invalid/\n",
  )
  return tmp
}

const isolatedEnv = (directory: string) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_"))),
  HOME: directory,
  USERPROFILE: directory,
  NPM_CONFIG_USERCONFIG: path.join(directory, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(directory, "global.npmrc"),
})

describe("NpmConfig.load", () => {
  test("reads registry from project .npmrc", async () => {
    await using tmp = await project()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path, isolatedEnv(tmp.path)))

    expect(config.registry).toBe("https://registry.example.test/")
  })

  test("reads scoped registries from project .npmrc", async () => {
    await using tmp = await project()
    await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path, isolatedEnv(tmp.path)))

    expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
  })

  test("flattens boolean and list options", async () => {
    await using tmp = await project()
    await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path, isolatedEnv(tmp.path)))

    expect(config.ignoreScripts).toBe(true)
    expect(config.omit).toEqual(["dev", "optional"])
  })
})

describe("NpmConfig.registry", () => {
  test("normalizes configured registry without trailing slash", async () => {
    await using tmp = await project()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path, isolatedEnv(tmp.path)))).resolves.toBe(
      "https://registry.example.test",
    )
  })

  test("leaves configured registry without trailing slash unchanged", async () => {
    await using tmp = await project()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path, isolatedEnv(tmp.path)))).resolves.toBe(
      "https://registry.example.test",
    )
  })
})
