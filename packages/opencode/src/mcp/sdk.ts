import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Context, Layer } from "effect"

const CLIENT_OPTIONS = {
  capabilities: {
    // https://github.com/anomalyco/opencode/issues/11948
    // sampling: {},
    // https://github.com/anomalyco/opencode/issues/23066
    // elicitation: {},
    // https://github.com/anomalyco/opencode/issues/2308
    roots: {},
    // https://github.com/anomalyco/opencode/issues/28567
    // tasks: {},
  },
} satisfies ClientOptions

export type MCPClient = Client
export type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
export type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport

export interface Interface {
  readonly createClient: (directory: string) => MCPClient
  readonly createStdioTransport: (options: ConstructorParameters<typeof StdioClientTransport>[0]) => Transport
  readonly createStreamableHTTPTransport: (
    url: URL,
    options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ) => TransportWithAuth
  readonly createSSETransport: (
    url: URL,
    options?: ConstructorParameters<typeof SSEClientTransport>[1],
  ) => TransportWithAuth
  readonly isUnauthorized: (error: unknown) => boolean
  readonly stdioPid: (transport: unknown) => number | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpSdk") {}

export const layer = Layer.sync(Service, () =>
  Service.of({
    createClient(directory) {
      const client = new Client({ name: "opencode", version: InstallationVersion }, CLIENT_OPTIONS)
      client.setRequestHandler(ListRootsRequestSchema, () =>
        Promise.resolve({ roots: [{ uri: pathToFileURL(path.resolve(directory)).href }] }),
      )
      return client
    },
    createStdioTransport: (options) => new StdioClientTransport(options),
    createStreamableHTTPTransport: (url, options) => new StreamableHTTPClientTransport(url, options),
    createSSETransport: (url, options) => new SSEClientTransport(url, options),
    isUnauthorized: (error) => error instanceof UnauthorizedError,
    stdioPid: (transport) =>
      transport instanceof StdioClientTransport && typeof transport.pid === "number" ? transport.pid : undefined,
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as McpSdk from "./sdk"
