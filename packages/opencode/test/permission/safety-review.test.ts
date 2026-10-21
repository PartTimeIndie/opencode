import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HeadlessAI } from "../../src/headless-ai"
import { PermissionSafetyReview } from "../../src/permission/safety-review"
import { testEffect } from "../lib/effect"
import type { ModelMessage } from "ai"

const calls: Parameters<HeadlessAI.Interface["object"]>[0][] = []
let decision: "safe" | "unsafe" = "safe"
let failure: Error | undefined
const modelDecisions = new Map<string, "safe" | "unsafe" | "failure">()

const headlessAI: HeadlessAI.Interface = {
  text: () => Effect.fail(new Error("text generation should not be used by safety review")),
  object: <T>(input: Parameters<HeadlessAI.Interface["object"]>[0]) =>
    Effect.sync(() => {
      calls.push(input)
      const modelDecision = modelDecisions.get(input.model ?? "")
      if (modelDecision === "failure") throw new Error("model failed")
      if (failure) throw failure
      return {
        model: input.model ?? "test/model",
        object: { decision: modelDecision ?? decision, reason: "test decision" } as T,
      }
    }),
}

const layer = Layer.succeed(HeadlessAI.Service, HeadlessAI.Service.of(headlessAI))
const it = testEffect(layer)

const request = {
  sessionID: "ses_test",
  permission: "bash",
  patterns: ["rm -rf tmp"],
  metadata: { source: "test" },
  intent: {
    anchor: { role: "user" as const, messageID: "msg_user", text: "Remove the temporary directory" },
    recent: [],
    truncated: false,
  },
}

test("project config keeps the active safety-review model contract", async () => {
  const config = (await Bun.file(`${import.meta.dir}/../../../../.opencode/opencode.json`).json()) as {
    access_control?: { safety_review?: { chain?: unknown } }
  }

  expect(config.access_control?.safety_review?.chain).toEqual([
    { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    { providerID: "openai", modelID: "gpt-5.6-luna", variant: "max" },
  ])
  expect(activeModelSelections(config)).not.toMatch(/gpt-5\.5|claude/i)
})

describe("PermissionSafetyReview", () => {
  test("builds intent from visible model-message text and attachment metadata", () => {
    const result = PermissionSafetyReview.intent([
      { role: "system", content: "System text must not authorize anything" },
      { role: "assistant", content: "Do you want me to edit the attachment?" },
      {
        role: "user",
        content: [
          { type: "text", text: "Yes, edit it" },
          { type: "file", data: "data:text/plain;base64,c2VjcmV0", mediaType: "text/plain", filename: "input.txt" },
        ],
      },
    ] satisfies ModelMessage[])

    expect(result).toMatchObject({
      anchor: {
        text: "Yes, edit it",
        attachments: [{ name: "input.txt", mime: "text/plain" }],
      },
      recent: [{ role: "assistant", text: "Do you want me to edit the attachment?" }],
    })
    expect(JSON.stringify(result)).not.toContain("c2VjcmV0")
    expect(JSON.stringify(result)).not.toContain("System text")
  })

  it.effect("uses the exact persisted Settings chain snapshot", () =>
    Effect.gen(function* () {
      calls.length = 0
      decision = "safe"
      failure = undefined

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: {
            mode: "approve_for_me",
            safety_review: {
              chain: [
                { providerID: "openrouter", modelID: "stealth/ox-alpha" },
                { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
                { providerID: "openai", modelID: "gpt-5.6-luna", variant: "max" },
              ],
            },
          },
        }),
      ).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.model).toBeUndefined()
      expect(calls[0]?.chain).toEqual([
        { providerID: "openrouter", modelID: "stealth/ox-alpha" },
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
        { providerID: "openai", modelID: "gpt-5.6-luna", variant: "max" },
      ])
      expect(calls[0]?.metadata).toMatchObject({ kind: "permission.safety_review", sessionID: "ses_test" })
      expect(calls[0]?.generation?.maxTokens).toBe(8192)
      const content = calls[0]?.messages[0]?.content
      expect(typeof content).toBe("string")
      expect(JSON.parse(content as string)).toMatchObject({
        permission: { action: "bash", resources: ["rm -rf tmp"] },
        intent: { anchor: { text: "Remove the temporary directory" } },
      })
    }),
  )

  it.effect("returns false so the permission popup is shown when the LLM marks the request unsafe", () =>
    Effect.gen(function* () {
      calls.length = 0
      decision = "unsafe"
      failure = undefined

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: {
            mode: "approve_for_me",
            safety_review: { model: "test/reviewer" },
          },
        }),
      ).toBe(false)
      expect(calls).toHaveLength(1)
    }),
  )

  it.effect("returns false so the permission popup is shown when the LLM review fails", () =>
    Effect.gen(function* () {
      calls.length = 0
      decision = "safe"
      failure = new Error("review model failed")

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: {
            mode: "approve_for_me",
            safety_review: { model: "test/reviewer" },
          },
        }),
      ).toBe(false)
      expect(calls).toHaveLength(1)
      failure = undefined
    }),
  )

  it.effect("fails closed when approve_for_me has no persisted chain snapshot", () =>
    Effect.gen(function* () {
      calls.length = 0
      decision = "safe"
      failure = undefined
      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: { mode: "approve_for_me" },
        }),
      ).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("does not run the LLM reviewer outside approve_for_me", () =>
    Effect.gen(function* () {
      calls.length = 0
      decision = "safe"
      failure = undefined

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: { mode: "ask" },
        }),
      ).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("uses the configured fallback after a primary provider failure", () =>
    Effect.gen(function* () {
      calls.length = 0
      modelDecisions.clear()
      modelDecisions.set("test/primary", "failure")
      modelDecisions.set("test/fallback", "safe")

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          accessControl: {
            mode: "approve_for_me",
            safety_review: { model: "test/primary", fallback: { model: "test/fallback" } },
          },
        }),
      ).toBe(true)
      expect(calls.map((call) => call.model)).toEqual(["test/primary", "test/fallback"])
      modelDecisions.clear()
    }),
  )

  it.effect("uses a safe fallback as a low-risk second opinion", () =>
    Effect.gen(function* () {
      calls.length = 0
      modelDecisions.clear()
      modelDecisions.set("test/primary", "unsafe")
      modelDecisions.set("test/fallback", "safe")

      expect(
        yield* PermissionSafetyReview.review({
          ...request,
          patterns: ["Get-Command ffprobe; where.exe ffprobe"],
          accessControl: {
            mode: "approve_for_me",
            safety_review: { model: "test/primary", fallback: { model: "test/fallback" } },
          },
        }),
      ).toBe(true)
      modelDecisions.clear()
    }),
  )
})

function activeModelSelections(value: unknown, selected = false): string {
  if (Array.isArray(value)) return value.map((entry) => activeModelSelections(entry, selected)).join("\n")
  if (!value || typeof value !== "object") return selected && typeof value === "string" ? value : ""
  return Object.entries(value)
    .map(([key, entry]) =>
      activeModelSelections(
        entry,
        selected || key === "model" || key === "small_model" || key === "chain" || key === "fallback",
      ),
    )
    .join("\n")
}
