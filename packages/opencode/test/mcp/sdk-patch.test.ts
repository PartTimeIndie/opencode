import { expect, test } from "bun:test"
import path from "node:path"

test("MCP SDK patch preserves tool metadata across paginated tool pages", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
        import { Client } from "@modelcontextprotocol/sdk/client/index.js"

        const client = new Client({ name: "metadata-cache-test", version: "1.0.0" })
        client.cacheToolMetadata([{
          name: "first-page-tool",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        }])
        client.cacheToolMetadata([{
          name: "second-page-tool",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: { value: { type: "string" } } },
        }], false)

        if (!client._cachedToolOutputValidators.has("first-page-tool")) process.exit(1)
        if (!client._cachedToolOutputValidators.has("second-page-tool")) process.exit(1)
      `,
    ],
    { cwd: path.resolve(import.meta.dir, "../.."), stderr: "pipe" },
  )

  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  expect(result.exitCode).toBe(0)
})
