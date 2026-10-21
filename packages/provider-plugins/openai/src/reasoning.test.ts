import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { openaiReasoningEfforts, openaiReasoningVariants } from "./reasoning"

test("GPT-6 Luna exposes only its advertised reasoning levels", () => {
  expect(
    openaiReasoningEfforts(
      { id: "gpt-6-luna", reasoning: true, release_date: "2026-09-01" },
      "@ai-sdk/openai",
    ),
  ).toEqual(["low", "medium", "high", "xhigh", "max"])
})

test("GPT-6 Luna versioned API IDs keep Luna-specific reasoning levels", () => {
  for (const id of ["gpt-6-luna.1", "openai/gpt-6-luna-preview"]) {
    expect(openaiReasoningEfforts({ id, reasoning: true, release_date: "2024-01-01" }, "@ai-sdk/openai")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  }
  expect(
    openaiReasoningEfforts(
      { id: "gpt-6-lunar", reasoning: true, release_date: "2026-09-01" },
      "@ai-sdk/openai",
    ),
  ).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
})

test("GPT-6 Sol-class models expose MAX like their gpt-5.6+ siblings", () => {
  for (const id of ["gpt-6-sol", "gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-6-unknown", "gpt-7"]) {
    expect(
      openaiReasoningEfforts({ id, reasoning: true, release_date: "2026-09-01" }, "@ai-sdk/openai"),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  }
  // Lookalikes without the family boundary stay on the release-date default: no MAX.
  for (const id of ["gpt-60", "gpt-6luna"]) {
    expect(
      openaiReasoningEfforts({ id, reasoning: true, release_date: "2026-09-01" }, "@ai-sdk/openai"),
    ).toEqual(["none", "low", "medium", "high", "xhigh"])
  }
  // The MAX tier still starts at gpt-5.6: older families stay without it.
  expect(
    openaiReasoningEfforts(
      { id: "gpt-5.5", reasoning: true, release_date: "2026-09-01" },
      "@ai-sdk/openai",
    ),
  ).toEqual(["none", "low", "medium", "high", "xhigh"])
})

test("GPT-6 Luna MAX catalog variant carries the request reasoning effort", () => {
  const variant = openaiReasoningVariants({
    id: "gpt-6-luna",
    reasoning: true,
    release_date: "2026-09-01",
    variants: [],
  }).find((item) => item.id === "max")

  expect(variant?.options).toEqual({
    reasoningEffort: "max",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  })
})

test("OpenAI Responses SDK serializes GPT-6 Luna MAX into the request body", async () => {
  let requestBody: unknown
  const openai = createOpenAI({
    apiKey: "test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(await new Request(input, init).text())
        return Response.json({ error: { message: "Request captured by test" } }, { status: 400 })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  await expect(
    openai.responses("gpt-6-luna").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      providerOptions: {
        openai: {
          reasoningEffort: "max",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
          store: false,
          forceReasoning: true,
        },
      },
    }),
  ).rejects.toThrow()

  expect(requestBody).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "max", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
  })
})

test("existing Luna variants are preserved without generating duplicates", () => {
  const existing = [{ id: "max" }, { id: "custom" }]
  const variants = openaiReasoningVariants({
    id: "gpt-6-luna",
    reasoning: true,
    release_date: "2026-09-01",
    variants: existing,
  })

  expect(variants.map((variant) => variant.id)).toEqual(["low", "medium", "high", "xhigh"])
  expect(existing).toEqual([{ id: "max" }, { id: "custom" }])
})

test("mutating returned Luna efforts does not change future classifications", () => {
  const efforts = openaiReasoningEfforts(
    { id: "gpt-6-luna", reasoning: true, release_date: "2026-09-01" },
    "@ai-sdk/openai",
  )
  efforts.push("none")

  expect(
    openaiReasoningEfforts(
      { id: "gpt-6-luna", reasoning: true, release_date: "2026-09-01" },
      "@ai-sdk/openai",
    ),
  ).toEqual(["low", "medium", "high", "xhigh", "max"])
})
