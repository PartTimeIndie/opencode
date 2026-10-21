#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import { readFile } from "node:fs/promises"
import path from "path"
import { preserveNullableModelChains } from "./preserve-nullable-model-chains"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)
await $`bun ./script/generate-v2.ts`

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesSource = await readFile(sseTypesPath, "utf8")
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// Empty JSON and form responses still need to be consumed. Leaving their
// response bodies unread makes Chromium report a successful 204 request as
// net::ERR_ABORTED after the caller has already accepted the response.
const clientPath = "./src/v2/gen/client/client.gen.ts"
const clientSource = await readFile(clientPath, "utf8")
const clientPatched = clientSource
  .replace(
    "          case 'formData':\n            emptyData = new FormData();",
    "          case 'formData':\n            await response.arrayBuffer();\n            emptyData = new FormData();",
  )
  .replace(
    "          case 'json':\n          default:\n            emptyData = {};",
    "          case 'json':\n          default:\n            await response.arrayBuffer();\n            emptyData = {};",
  )
  .replace(
    "          case 'stream':\n            emptyData = response.body;",
    "          case 'stream':\n            await response.arrayBuffer();\n            emptyData = null;",
  )
if (clientPatched === clientSource) {
  throw new Error(`Empty response consumption patch did not apply; @hey-api/openapi-ts output may have changed (${clientPath})`)
}
await Bun.write(clientPath, clientPatched)

// Treat caller-driven SSE aborts as normal stream completion. The generated
// client reports the expected AbortError through onSseError and leaves a
// rejected reader.cancel() promise unhandled, which makes a successful CLI
// attach print an AbortError stack after its terminal response.
const sseClientPath = "./src/v2/gen/core/serverSentEvents.gen.ts"
const sseClientSource = await readFile(sseClientPath, "utf8")
const sseCancelPatched = sseClientSource.replace(
  /        const abortHandler = \(\) => \{\r?\n          try \{\r?\n            reader\.cancel\(\);\r?\n          \} catch \{\r?\n            \/\/ noop\r?\n          \}\r?\n        \};/,
    `        const abortHandler = () => {
          void reader.cancel().catch(() => undefined);
        };`,
  )
if (sseCancelPatched === sseClientSource) {
  throw new Error(`SSE cancel patch did not apply; @hey-api/openapi-ts output may have changed (${sseClientPath})`)
}
const sseClientPatched = sseCancelPatched.replace(
  /      \} catch \(error\) \{\r?\n        \/\/ connection failed or aborted; retry after delay/,
    `      } catch (error) {
        if (signal.aborted) break;
        // connection failed or aborted; retry after delay`,
  )
if (sseClientPatched === sseCancelPatched) {
  throw new Error(`SSE error patch did not apply; @hey-api/openapi-ts output may have changed (${sseClientPath})`)
}
await Bun.write(sseClientPath, sseClientPatched)

// Patch a @hey-api/openapi-ts flat-params codegen bug: required request-body
// fields are emitted as optional method parameters even when the generated
// operation data type has `body: { requiredField: ... }`.
const generatedTypesPath = "./src/v2/gen/types.gen.ts"
const sdkPath = "./src/v2/gen/sdk.gen.ts"
const generatedTypesSource = await readFile(generatedTypesPath, "utf8")
const generatedTypesPatched = preserveNullableModelChains(generatedTypesSource)
await Bun.write(generatedTypesPath, generatedTypesPatched)
const sdkSource = await readFile(sdkPath, "utf8")
const sdkPatched = patchRequiredBodyParameters(sdkSource, generatedTypesPatched)
await Bun.write(sdkPath, sdkPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
// dist was removed, so cached composite-build state must not skip unchanged exports.
await $`bun tsc --build --force`
const manifest = await Bun.file(path.join(dir, "package.json")).json()
for (const source of Object.values(manifest.exports) as string[]) {
  const output = path.join(dir, source.replace("./src/", "./dist/").replace(/\.ts$/, ""))
  for (const extension of [".js", ".d.ts"])
    if (!(await Bun.file(`${output}${extension}`).exists())) throw new Error(`Missing public SDK artifact: ${output}${extension}`)
}
await $`rm openapi.json`

function patchRequiredBodyParameters(sdkSource: string, typesSource: string) {
  const missing: string[] = []
  let output = sdkSource

  for (const [responseType, fields] of requiredBodyFields(typesSource)) {
    let search = 0
    while (true) {
      const responseIndex = output.indexOf(`<${responseType},`, search)
      if (responseIndex < 0) break

      const parametersIndex = output.lastIndexOf("parameters: {", responseIndex)
      if (parametersIndex < 0) {
        missing.push(`${responseType}: parameters block not found`)
        break
      }

      const start = output.indexOf("{", parametersIndex)
      const end = findMatchingBrace(output, start)
      let block = output.slice(start, end + 1)

      for (const field of fields) {
        block = block.replace(new RegExp(`(\\n\\s+)${escapeRegExp(field)}\\?:`, "g"), `$1${field}:`)
        if (new RegExp(`\\n\\s+${escapeRegExp(field)}\\?:`).test(block)) {
          missing.push(`${responseType}.${field}`)
        }
      }

      output = output.slice(0, start) + block + output.slice(end + 1)
      search = responseIndex + 1
    }
  }

  if (missing.length) {
    throw new Error(`Required body parameter patch did not apply: ${missing.join(", ")}`)
  }

  return output
}

function requiredBodyFields(typesSource: string) {
  const result = new Map<string, string[]>()
  const lines = typesSource.split("\n")

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(/^export type (\w+)Data = \{$/)
    if (!match) continue

    const fields: string[] = []
    let depth = 1
    let bodyDepth: number | undefined

    for (index++; index < lines.length; index++) {
      const line = lines[index] ?? ""
      if (bodyDepth === undefined && /^\s+body: \{$/.test(line)) bodyDepth = depth + 1
      if (bodyDepth !== undefined && depth === bodyDepth) {
        const field = line.match(/^\s+([A-Za-z_$][\w$]*):/)
        if (field) fields.push(field[1])
      }

      depth += braceDelta(line)
      if (bodyDepth !== undefined && depth < bodyDepth) bodyDepth = undefined
      if (depth === 0) break
    }

    if (fields.length) result.set(`${match[1]}Responses`, fields)
  }

  return result
}

function braceDelta(line: string) {
  return Array.from(line).reduce((sum, char) => sum + (char === "{" ? 1 : char === "}" ? -1 : 0), 0)
}

function findMatchingBrace(source: string, start: number) {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (char === "{") depth++
    if (char === "}") depth--
    if (depth === 0) return index
  }
  throw new Error(`Unmatched brace in generated SDK near offset ${start}`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
