import { afterEach, describe, expect, test } from "bun:test"
import { LLM, Message, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect } from "effect"
import { Flag } from "../src/flag/flag"
import { InstallationVersion } from "../src/installation/version"
import { providerHeaders } from "../src/session/provider-headers"

const client = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (client === undefined) {
    delete process.env.OPENCODE_CLIENT
    return
  }
  process.env.OPENCODE_CLIENT = client
})

describe("session provider headers", () => {
  ;["desktop", "cli", "headless"].forEach((client) => {
    test(`attributes hosted requests to the actual ${client} host`, () => {
      process.env.OPENCODE_CLIENT = client
      const headers = providerHeaders({ provider: "opencode", sessionID: "ses_headers" })
      expect(headers["x-opencode-client"]).toBe(Flag.OPENCODE_CLIENT)
      expect(headers["x-opencode-client"]).toBe(client)
      expect(headers["User-Agent"]).toStartWith(`opencode/${InstallationVersion} `)
    })
  })

  test("uses the actual CLI default when the host client flag is absent", () => {
    delete process.env.OPENCODE_CLIENT
    expect(providerHeaders({ provider: "opencode", sessionID: "ses_headers" })["x-opencode-client"]).toBe("cli")
  })

  test("omits unavailable request and project IDs instead of creating identities", () => {
    const headers = providerHeaders({ provider: "opencode", sessionID: "ses_headers" })
    expect(headers["x-opencode-request"]).toBeUndefined()
    expect(headers["x-opencode-project"]).toBeUndefined()
  })

  ;["openai", "anthropic", "openrouter", "zhipuai"].forEach((provider) => {
    test(`keeps OpenCode attribution private on ${provider} requests`, () => {
      const headers = providerHeaders({
        provider,
        sessionID: "ses_headers",
        requestID: "msg_headers",
        projectID: "project_headers",
      })
      expect(Object.keys(headers).filter((key) => key.startsWith("x-opencode-"))).toEqual([])
      expect(headers["x-session-affinity"]).toBe("ses_headers")
      expect(headers["X-Session-Id"]).toBe("ses_headers")
      expect(headers["User-Agent"]).toStartWith(`opencode/${InstallationVersion} `)
    })
  })

  ;["opencode", "opencode-go"].forEach((provider) => {
    test(`retains attribution through the actual ${provider} HTTP preparation`, async () => {
      process.env.OPENCODE_CLIENT = "desktop"
      const request = LLM.request({
        model: Model.make({ id: "header-fixture", provider, route }),
        messages: [Message.user("Inspect local request preparation")],
        http: {
          headers: providerHeaders({
            provider,
            sessionID: "ses_headers",
            requestID: "msg_headers",
            projectID: "project_headers",
          }),
        },
      })
      const prepared = await Effect.runPromise(
        route.body.from(request).pipe(Effect.flatMap((body) => route.prepareTransport(body, request))),
      )
      expect(prepared.request.headers).toMatchObject({
        "x-opencode-client": "desktop",
        "x-opencode-session": "ses_headers",
        "x-opencode-request": "msg_headers",
        "x-opencode-project": "project_headers",
      })
      expect(prepared.request.headers["user-agent"]).toStartWith(`opencode/${InstallationVersion} `)
    })
  })
})
