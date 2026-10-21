import { describe, expect, test } from "bun:test"
import type { IntegrationInfo, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import {
  authorizationMode,
  connectMethods,
  integrationAttemptID,
  isIntegrationKey,
  isIntegrationOAuth,
  withConnectTimeout,
} from "./provider-connect"

const fallback: ProviderAuthMethod[] = [{ type: "api", label: "API key" }]

describe("provider connect compatibility", () => {
  test("prefers V2 OAuth and key methods while ignoring environment-only methods", () => {
    const integration = {
      id: "openai",
      name: "OpenAI",
      connections: [],
      methods: [
        { type: "oauth", id: "browser", label: "ChatGPT browser" },
        { type: "env", names: ["OPENAI_API_KEY"] },
        { type: "key", label: "API key" },
      ],
    } satisfies IntegrationInfo

    const methods = connectMethods(integration, [{ type: "api", label: "Legacy" }], fallback)
    expect(methods.map((method) => method.type)).toEqual(["oauth", "key"])
    expect(isIntegrationOAuth(methods[0])).toBe(true)
    expect(isIntegrationKey(methods[1])).toBe(true)
  })

  test("falls back to legacy methods when V2 only reports environment auth", () => {
    const legacy: ProviderAuthMethod[] = [{ type: "oauth", label: "Legacy OAuth" }]
    expect(
      connectMethods(
        { id: "test", name: "Test", connections: [], methods: [{ type: "env", names: ["TEST_KEY"] }] },
        legacy,
        fallback,
      ),
    ).toBe(legacy)
    expect(connectMethods(undefined, undefined, fallback)).toBe(fallback)
  })

  test("normalizes legacy authorizations and V2 attempts", () => {
    expect(authorizationMode({ url: "https://example.com", method: "code", instructions: "" })).toBe("code")
    const attempt = {
      attemptID: "con_test",
      url: "https://example.com",
      instructions: "wait",
      mode: "auto" as const,
      time: { created: 1, expires: 2 },
    }
    expect(authorizationMode(attempt)).toBe("auto")
    expect(integrationAttemptID(attempt)).toBe("con_test")
  })
})

describe("provider connect metadata timeout", () => {
  test("resolves the wrapped value when the request settles in time", async () => {
    expect(await withConnectTimeout(Promise.resolve("ok"), 50)).toBe("ok")
  })

  test("resolves undefined when the request hangs past the timeout", async () => {
    expect(await withConnectTimeout(new Promise<string>(() => {}), 10)).toBeUndefined()
  })

  test("resolves undefined when the request rejects", async () => {
    expect(await withConnectTimeout(Promise.reject(new Error("down")), 50)).toBeUndefined()
  })
})
