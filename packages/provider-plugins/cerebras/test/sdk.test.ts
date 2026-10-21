import { describe, expect, test } from "bun:test"
import { createSDK, normalizeRequest } from "../src/sdk"

const normalize = (body: Record<string, unknown>) => JSON.parse(normalizeRequest(JSON.stringify(body)))

describe("Cerebras SDK request contract", () => {
  test("renames reasoning in assistant history, including empty reasoning", () => {
    expect(
      normalize({
        messages: [
          { role: "assistant", content: "answer", reasoning_content: "thought" },
          { role: "assistant", content: null, reasoning_content: "" },
          { role: "assistant", content: "no reasoning" },
        ],
      }).messages,
    ).toEqual([
      { role: "assistant", content: "answer", reasoning: "thought" },
      { role: "assistant", content: null, reasoning: "" },
      { role: "assistant", content: "no reasoning" },
    ])
  })

  test("preserves an explicitly provided Cerebras reasoning field", () => {
    expect(
      normalize({ messages: [{ role: "assistant", reasoning: "canonical", reasoning_content: "legacy" }] }).messages,
    ).toEqual([{ role: "assistant", reasoning: "canonical" }])
  })

  test("does not rewrite tool arguments, results, or user text", () => {
    const messages = [
      { role: "user", content: "reasoning_content" },
      {
        role: "assistant",
        tool_calls: [{ id: "call", function: { name: "echo", arguments: '{"reasoning_content":"keep"}' } }],
      },
      { role: "tool", tool_call_id: "call", content: '{"reasoning_content":"keep"}' },
    ]
    expect(normalize({ messages }).messages).toEqual(messages)
  })

  test("omits unsupported options and preserves supported request fields", () => {
    expect(
      normalize({
        model: "qwen-3.8-27b",
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        reasoning_effort: "high",
        max_tokens: 200,
        temperature: 0.5,
        top_p: 0.9,
        seed: 1,
        stop: ["end"],
        tools: [],
      }),
    ).toEqual({
      model: "qwen-3.8-27b",
      messages: [],
      stream: true,
      reasoning_effort: "high",
      max_tokens: 200,
      temperature: 0.5,
      top_p: 0.9,
      seed: 1,
      stop: ["end"],
      tools: [],
    })
  })

  test("real SDK generation preserves URL, headers, cancellation and response reasoning", async () => {
    const abort = new AbortController()
    const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = []
    const sdk = await createSDK({
      apiKey: "fixture-key",
      baseURL: "https://fixture.invalid/v1",
      headers: { "X-Test": "preserved" },
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          calls.push({ input, init })
          return Response.json({
            id: "fixture",
            created: 0,
            model: "qwen-3.8-27b",
            choices: [
              {
                index: 0,
                message: { role: "assistant", reasoning: "new thought", content: "answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const response = await sdk("qwen-3.8-27b").doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "previous thought" },
            { type: "text", text: "previous answer" },
          ],
        },
      ],
      abortSignal: abort.signal,
    })
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.input)).toBe("https://fixture.invalid/v1/chat/completions")
    expect(calls[0]?.init?.signal).toBe(abort.signal)
    expect(new Headers(calls[0]?.init?.headers).get("X-Test")).toBe("preserved")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fixture-key")
    expect(JSON.parse(String(calls[0]?.init?.body)).messages).toEqual([
      { role: "assistant", content: "previous answer", reasoning: "previous thought" },
    ])
    expect(response.content).toContainEqual({ type: "reasoning", text: "new thought" })
    expect(response.content).toContainEqual({ type: "text", text: "answer" })
  })

  test("does not swallow fetch errors", async () => {
    const failure = new Error("fixture transport failed")
    const sdk = await createSDK({
      apiKey: "fixture-key",
      fetch: Object.assign(() => Promise.reject(failure), { preconnect: fetch.preconnect }),
    })
    await expect(sdk("qwen-3.8-27b").doStream({ prompt: [] })).rejects.toBe(failure)
  })
})
