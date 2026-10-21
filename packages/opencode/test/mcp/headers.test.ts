import { describe, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import type { MCPClient } from "../../src/mcp/sdk"
import { MCP } from "../../src/mcp/index"
import { McpSdk } from "../../src/mcp/sdk"
import { testEffect } from "../lib/effect"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

class MockTransport {
  constructor(
    readonly type: "streamable" | "sse",
    readonly url: URL,
    readonly options?: { authProvider?: unknown; requestInit?: RequestInit },
  ) {
    transportCalls.push({ type, url: url.toString(), options: options ?? {} })
  }

  async start() {
    throw new Error("Mock transport cannot connect")
  }

  async close() {}
}

class MockClient {
  async connect(transport: MockTransport) {
    await transport.start()
  }

  async close() {}
}

beforeEach(() => {
  transportCalls.length = 0
})

const sdkLayer = Layer.succeed(
  McpSdk.Service,
  McpSdk.Service.of({
    createClient: () => new MockClient() as unknown as MCPClient,
    createStdioTransport: () => new MockTransport("streamable", new URL("stdio://test")) as never,
    createStreamableHTTPTransport: (url, options) => new MockTransport("streamable", url, options) as never,
    createSSETransport: (url, options) => new MockTransport("sse", url, options) as never,
    isUnauthorized: () => false,
    stdioPid: () => undefined,
  }),
)
const it = testEffect(MCP.baseLayer.pipe(Layer.provide(sdkLayer)))

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default)", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer test-token",
            "X-Custom-Header": "custom-value",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      // Both transports should have been created with headers
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        })
        // OAuth should be enabled by default, so authProvider should exist
        expect(call.options.authProvider).toBeDefined()
      }
    }),
    { git: true, config: { mcp: {} } },
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-oauth", {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: false,
          headers: {
            Authorization: "Bearer test-token",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
    { git: true, config: { mcp: {} } },
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-headers", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    }),
    { git: true, config: { mcp: {} } },
  )
})
