import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText, tool } from "ai"
import z from "zod"

const response = (chunks: ReadonlyArray<unknown>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  id: "chatcmpl-test",
  model: "test-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const fetchStub = (chunks: ReadonlyArray<unknown>): typeof fetch =>
  Object.assign(async (..._args: Parameters<typeof fetch>) => response(chunks), {
    preconnect: fetch.preconnect,
  })

const surface = tool({
  inputSchema: z.object({
    mode: z.literal("blocking"),
    questions: z.array(z.object({ question: z.string() })),
  }),
})

const ping = tool({ inputSchema: z.object({}) })

const stream = (
  chunks: ReadonlyArray<unknown>,
  options: {
    tools?: Parameters<typeof streamText>[0]["tools"]
    repair?: Parameters<typeof streamText>[0]["experimental_repairToolCall"]
  } = {},
) =>
  streamText({
    model: createOpenRouter({ apiKey: "test-key", fetch: fetchStub(chunks) })("test-model"),
    messages: [{ role: "user", content: "Call the requested tool" }],
    tools: options.tools ?? { surface },
    maxRetries: 0,
    experimental_repairToolCall: options.repair,
  })

const calls = async (result: ReturnType<typeof streamText>) => {
  const calls = []
  for await (const event of result.fullStream) {
    if (event.type === "tool-call") calls.push(event)
  }
  return calls
}

const start = (name: string, args?: string, index = 0) => ({
  index,
  id: `call_${name}`,
  type: "function",
  function: { name, ...(args === undefined ? {} : { arguments: args }) },
})

const delta = (args: string, index = 0) => ({ index, function: { arguments: args } })

describe("OpenRouter streamed tool arguments", () => {
  test("materializes the final argument snapshot instead of an earlier parsable placeholder", async () => {
    const result = await calls(
      stream([
        chunk({ role: "assistant", tool_calls: [start("surface", "{}")] }),
        chunk({
          tool_calls: [delta('{"mode":"blocking","questions":[{"question":"Continue?"}]}')],
        }),
        chunk({}, "tool_calls"),
      ]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      toolCallId: "call_surface",
      toolName: "surface",
      input: { mode: "blocking", questions: [{ question: "Continue?" }] },
    })
  })

  test("drops an empty object placeholder before merging incremental argument fragments", async () => {
    const result = await calls(
      stream([
        chunk({ role: "assistant", tool_calls: [start("surface", "{}")] }),
        chunk({ tool_calls: [delta('{"mode":')] }),
        chunk({ tool_calls: [delta('"blocking","questions":[')] }),
        chunk({ tool_calls: [delta('{"question":"Continue?"}]}')] }),
        chunk({}, "tool_calls"),
      ]),
    )

    expect(result[0]).toMatchObject({
      input: { mode: "blocking", questions: [{ question: "Continue?" }] },
    })
  })

  test("accumulates valid primitive fragments instead of treating each as a snapshot", async () => {
    const result = await calls(
      stream([
        chunk({ role: "assistant", tool_calls: [start("surface", "{}")] }),
        chunk({ tool_calls: [delta('{"count":')] }),
        chunk({ tool_calls: [delta("123")] }),
        chunk({ tool_calls: [delta("}")] }),
        chunk({}, "tool_calls"),
      ]),
    )

    expect(result[0]).toMatchObject({ input: { count: 123 } })
  })

  test("accepts cumulative partial snapshots that strictly extend the current argument stream", async () => {
    const result = await calls(
      stream([
        chunk({ role: "assistant", tool_calls: [start("surface", "{}")] }),
        chunk({ tool_calls: [delta('{"count":')] }),
        chunk({ tool_calls: [delta('{"count":1')] }),
        chunk({ tool_calls: [delta('{"count":12')] }),
        chunk({ tool_calls: [delta('{"count":123}')] }),
        chunk({}, "tool_calls"),
      ]),
    )

    expect(result[0]).toMatchObject({ input: { count: 123 } })
  })

  test("keeps terminal non-tool reasons from materializing pending tool calls", async () => {
    for (const finishReason of ["length", "content_filter"]) {
      const result = await calls(
        stream([
          chunk({ role: "assistant", tool_calls: [start("surface", '{"mode":"blocking"')] }),
          chunk({}, finishReason),
        ]),
      )

      expect(result).toHaveLength(0)
    }
  })

  test("materializes missing arguments as an empty object for a parameterless tool", async () => {
    const result = await calls(
      stream([chunk({ role: "assistant", tool_calls: [start("ping")] }), chunk({}, "tool_calls")], {
        tools: { ping },
      }),
    )

    expect(result[0]).toMatchObject({ toolName: "ping", input: {} })
  })

  test("materializes explicitly empty arguments as an empty object for a parameterless tool", async () => {
    const result = await calls(
      stream([chunk({ role: "assistant", tool_calls: [start("ping", "")] }), chunk({}, "tool_calls")], {
        tools: { ping },
      }),
    )

    expect(result[0]).toMatchObject({ toolName: "ping", input: {} })
  })

  test("preserves malformed provider arguments for the AI SDK repair boundary", async () => {
    let repairedInput: string | undefined
    const result = stream(
      [
        chunk({ role: "assistant", tool_calls: [start("surface", '{"mode":"blocking"')] }),
        chunk({}, "tool_calls"),
      ],
      {
        repair: async ({ toolCall }) => {
          repairedInput = toolCall.input
          return null
        },
      },
    )

    for await (const _event of result.fullStream) {
      // Consuming fullStream exercises provider parsing, AI SDK materialization, and repair.
    }
    expect(repairedInput).toBe('{"mode":"blocking"')
  })

  test("keeps interleaved tool argument state isolated by call index", async () => {
    const result = await calls(
      stream(
        [
          chunk({
            role: "assistant",
            tool_calls: [start("surface", "{}"), start("ping", "", 1)],
          }),
          chunk({ tool_calls: [delta('{"mode":', 0), delta("{}", 1)] }),
          chunk({ tool_calls: [delta('"blocking","questions":[{"question":"Continue?"}]}', 0)] }),
          chunk({}, "tool_calls"),
        ],
        { tools: { surface, ping } },
      ),
    )

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      toolName: "surface",
      input: { mode: "blocking", questions: [{ question: "Continue?" }] },
    })
    expect(result[1]).toMatchObject({ toolName: "ping", input: {} })
  })
})
