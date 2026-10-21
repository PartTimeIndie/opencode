import { describe, expect, test } from "bun:test"
import { authoritativePromptText, runPromptAdmission } from "../../../src/component/prompt"

describe("Prompt admission helpers", () => {
  test("rejected durable admission reports failure without committing composer state", async () => {
    const events: string[] = []
    const result = await runPromptAdmission({
      request: async () => {
        throw new Error("rejected")
      },
      active: () => true,
      onCommit: () => events.push("clear"),
      onReject: () => events.push("toast"),
    })

    expect(result).toBe("rejected")
    expect(events).toEqual(["toast"])
  })

  test("successful admission does not commit after the originating prompt is gone", async () => {
    const events: string[] = []
    const result = await runPromptAdmission({
      request: async () => {},
      active: () => false,
      onCommit: () => events.push("navigate"),
      onReject: () => events.push("toast"),
    })

    expect(result).toBe("inactive")
    expect(events).toEqual([])
  })

  test("authoritative prompt text includes the final IME character and avoids destroyed input", () => {
    expect(authoritativePromptText({ isDestroyed: false, plainText: "final-\ud55c" }, "final-\ud558")).toBe(
      "final-\ud55c",
    )
    expect(
      authoritativePromptText(
        {
          isDestroyed: true,
          get plainText(): string {
            throw new Error("destroyed input must not be read")
          },
        },
        "retained draft",
      ),
    ).toBe("retained draft")
  })
})
