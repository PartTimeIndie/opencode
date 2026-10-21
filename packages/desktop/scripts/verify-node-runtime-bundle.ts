import { findForbiddenNodeRuntimeAPIs } from "./node-runtime-bundle"

const files = await Array.fromAsync(new Bun.Glob("**/*.js").scan({ cwd: "out/main", absolute: true }))
const forbidden = (
  await Promise.all(
    files.map(async (file) => ({
      file,
      matches: findForbiddenNodeRuntimeAPIs(await Bun.file(file).text()),
    })),
  )
).filter((result) => result.matches.length > 0)

if (forbidden.length > 0) {
  throw new Error(
    `Desktop main bundle contains Bun-only runtime APIs:\n${forbidden
      .map((result) => `${result.file}: ${result.matches.join(", ")}`)
      .join("\n")}`,
  )
}

console.log(`verified Node runtime compatibility in ${files.length} deployable main bundle files`)
