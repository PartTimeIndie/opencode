import { describe, expect, test } from "bun:test"
import { pluginItemID } from "./plugin-action-id"
import { cancelSessionTool, startSessionPrompt } from "./session-action"

describe("desktop testing plugin action IDs", () => {
  test("accepts both local item IDs and already scoped IDs", () => {
    expect(pluginItemID("speech-to-text-app", "microphone")).toBe("speech-to-text-app/microphone")
    expect(pluginItemID("speech-to-text-app", "speech-to-text-app/microphone")).toBe("speech-to-text-app/microphone")
  })
})

describe("desktop testing session actions", () => {
  test("forwards session.cancelTool to the V2 session client", async () => {
    const calls: Array<{ sessionID: string; callID: string }> = []
    const result = await cancelSessionTool(
      {
        v2: {
          session: {
            cancelTool: async (input) => {
              calls.push(input)
              return { data: true }
            },
          },
        },
      },
      { sessionID: "ses_test", callID: "call_test" },
    )

    expect(calls).toEqual([{ sessionID: "ses_test", callID: "call_test" }])
    expect(result).toEqual({ data: true })
  })

  test("accepts session.prompt without waiting for the provider turn", async () => {
    const calls: unknown[] = []
    const providerTurn = Promise.withResolvers<unknown>()
    const result = startSessionPrompt(
      {
        v2: {
          session: {
            prompt: (input) => {
              calls.push(input)
              return providerTurn.promise
            },
          },
        },
      },
      {
        sessionID: "ses_test",
        agent: "build",
        model: { providerID: "provider", id: "model", variant: "high" },
        prompt: { text: "Keep working" },
      },
    )

    expect(result).toEqual({ accepted: true })
    expect(calls).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        model: { providerID: "provider", id: "model", variant: "high" },
        prompt: { text: "Keep working" },
      },
    ])

    providerTurn.reject(new Error("provider failed after acceptance"))
    await Promise.resolve()
  })

  test("forwards a default chain model to the provider turn", async () => {
    const calls: unknown[] = []
    const providerTurn = Promise.withResolvers<unknown>()
    startSessionPrompt(
      {
        v2: {
          session: {
            prompt: (input) => {
              calls.push(input)
              return providerTurn.promise
            },
          },
        },
      },
      {
        sessionID: "ses_test",
        agent: "build",
        model: {
          providerID: "zhipuai-coding-plan",
          id: "glm-5.3-flash",
          chain: {
            id: "standard-coder",
            name: "Standard Coder",
            active: 0,
            steps: [
              { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
              { providerID: "cursor", id: "gpt-6.1-sol", variant: "medium" },
            ],
          },
        },
        prompt: { text: "Use the configured chain" },
      },
    )

    expect(calls).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        model: {
          providerID: "zhipuai-coding-plan",
          id: "glm-5.3-flash",
          chain: {
            id: "standard-coder",
            name: "Standard Coder",
            active: 0,
            steps: [
              { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
              { providerID: "cursor", id: "gpt-6.1-sol", variant: "medium" },
            ],
          },
        },
        prompt: { text: "Use the configured chain" },
      },
    ])

    providerTurn.reject(new Error("provider failed after acceptance"))
    await Promise.resolve()
  })

  test("admits a session.prompt without any model", async () => {
    const calls: unknown[] = []
    const providerTurn = Promise.withResolvers<unknown>()
    startSessionPrompt(
      {
        v2: {
          session: {
            prompt: (input) => {
              calls.push(input)
              return providerTurn.promise
            },
          },
        },
      },
      {
        sessionID: "ses_test",
        agent: "build",
        prompt: { text: "Keep the stored session model" },
      },
    )

    expect(calls).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        prompt: { text: "Keep the stored session model" },
      },
    ])

    providerTurn.reject(new Error("provider failed after acceptance"))
    await Promise.resolve()
  })
})
