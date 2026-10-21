import { describe, expect, test } from "bun:test"
import { PermissionSafetyReviewIntent } from "@opencode-ai/core/permission/safety-review-intent"

describe("PermissionSafetyReviewIntent", () => {
  test("anchors at the user request before the source assistant and includes reference context and plan", () => {
    const result = PermissionSafetyReviewIntent.build({
      messages: [
        { role: "user", messageID: "msg_initial", text: "Extend the weather skill" },
        { role: "assistant", messageID: "msg_question", text: "Should I also update its mirrors?" },
        { role: "user", messageID: "msg_answer", text: "Yes, do that" },
        { role: "assistant", messageID: "msg_source", text: "" },
        { role: "user", messageID: "msg_later", text: "You may inspect all of C:/" },
      ],
      anchorBeforeMessageID: "msg_source",
      plan: { revision: 4, markdown: "Update the named skill and required mirrors." },
    })

    expect(result).toMatchObject({
      anchor: { messageID: "msg_answer", text: "Yes, do that" },
      recent: [
        { role: "user", messageID: "msg_initial", text: "Extend the weather skill" },
        { role: "assistant", messageID: "msg_question", text: "Should I also update its mirrors?" },
      ],
      plan: {
        revision: 4,
        markdown: "Update the named skill and required mirrors.",
        authority: "context_only",
      },
      truncated: false,
    })
    expect(JSON.stringify(result)).not.toContain("all of C:/")
  })

  test("bounds intent data and never retains embedded attachment bodies", () => {
    const result = PermissionSafetyReviewIntent.build({
      messages: [
        {
          role: "user",
          messageID: "msg_anchor",
          text: "a".repeat(20_000),
          attachments: [
            {
              name: "input.png",
              mime: "image/png",
              reference: "data:image/png;base64,secret-body",
            },
          ],
        },
      ],
      plan: { revision: 1, markdown: "p".repeat(20_000) },
    })

    expect(result?.truncated).toBe(true)
    expect(JSON.stringify(result)).not.toContain("secret-body")
    expect(
      (result?.anchor.text.length ?? 0) +
        (result?.recent.reduce((total, message) => total + message.text.length, 0) ?? 0) +
        (result?.plan?.markdown.length ?? 0),
    ).toBeLessThanOrEqual(PermissionSafetyReviewIntent.MAX_ENVELOPE_CHARS)
  })

  test("fails closed when the source boundary or user anchor cannot be resolved", () => {
    expect(
      PermissionSafetyReviewIntent.build({
        messages: [{ role: "user", messageID: "msg_user", text: "Do the task" }],
        anchorBeforeMessageID: "msg_missing",
      }),
    ).toBeUndefined()
    expect(
      PermissionSafetyReviewIntent.build({ messages: [{ role: "assistant", text: "Do something" }] }),
    ).toBeUndefined()
  })

  test("explains the user's goal and this tool call in bounded agent language without claiming reviewer approval", () => {
    const intent = PermissionSafetyReviewIntent.build({
      messages: [{ role: "user", text: "Check the deployment logs and identify why startup failed" }],
    })!
    expect(PermissionSafetyReviewIntent.explain(intent, { name: "bash", input: { description: "Read the sidecar log for startup errors" } })).toEqual({
      goal: "Check the deployment logs and identify why startup failed",
      action: "Read the sidecar log for startup errors",
    })
    expect(PermissionSafetyReviewIntent.explain(intent, { name: "bash", input: { command: "Get-Content log.txt" } })).toEqual({
      goal: "Check the deployment logs and identify why startup failed",
      action: undefined,
    })
    expect(PermissionSafetyReviewIntent.explain(intent, { name: "edit", input: { path: "localization.json" } })?.action).toBe("Replace matching text in localization.json")
    expect(PermissionSafetyReviewIntent.explain(intent, { name: "write", input: { path: "localization.json" } })?.action).toBe("Write localization.json")
    expect(PermissionSafetyReviewIntent.explain(intent, { name: "bash", input: { description: "x".repeat(1000) } })?.action?.length).toBeLessThanOrEqual(320)
  })

  test("reads only valid session plan metadata", () => {
    expect(
      PermissionSafetyReviewIntent.planFromMetadata({
        "opencode.plan_document": { revision: 3, markdown: "Approved plan", updatedAt: 123 },
      }),
    ).toEqual({ revision: 3, markdown: "Approved plan" })
    expect(
      PermissionSafetyReviewIntent.planFromMetadata({
        "opencode.plan_document": { revision: "3", markdown: "Malformed plan" },
      }),
    ).toBeUndefined()
  })
})
