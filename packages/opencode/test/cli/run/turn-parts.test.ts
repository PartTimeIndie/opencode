import { describe, expect, test } from "bun:test"
import { terminalToolPartsForTurn, unemittedTextParts } from "../../../src/cli/cmd/run/turn-parts"

function assistant(id: string, partID: string, created: number) {
  return {
    id,
    type: "assistant" as const,
    time: { created },
    content: [{
      id: partID,
      type: "tool",
      tool: "fixture",
      state: { status: "completed", input: {}, output: "ok" },
    }],
  }
}

describe("non-interactive current-turn part recovery", () => {
  test("progress text does not suppress a missed final answer with the same part ID", () => {
    const final = { id: "final-message", content: [
      { id: "text-0", type: "text", text: "CRIKI_FINAL_SIGNAL_BODY_BEGIN\nDone\nCRIKI_FINAL_SIGNAL_BODY_END" },
      { id: "reasoning-0", type: "reasoning", text: "private reasoning" },
    ] } as const
    expect(unemittedTextParts(final, new Set(["progress-message:text-0"]))).toEqual([final.content[0]])
    expect(unemittedTextParts(final, new Set(["final-message:text-0"]))).toEqual([])
  })

  test("excludes resumed history and retains current parts beyond an old 200-message window", () => {
    const history = Array.from({ length: 250 }, (_, index) => assistant(`old-${index}`, `old-part-${index}`, index))
    const messages = [
      ...history,
      { id: "current-turn", type: "user" as const, time: { created: 250 }, content: [] },
      assistant("current-step-1", "current-first", 251),
      assistant("current-step-2", "current-latest", 252),
      { id: "next-turn", type: "user" as const, time: { created: 253 }, content: [] },
      assistant("next-step", "other-part", 254),
    ]

    expect(terminalToolPartsForTurn(messages, "current-turn", new Set(["current-first"])).map((part) => part.id))
      .toEqual(["current-latest"])
  })

  test("uses sortable message IDs when a turn shares one millisecond", () => {
    const messages = [
      assistant("msg_003", "current-part", 100),
      { id: "msg_002", type: "user" as const, time: { created: 100 }, content: [] },
      assistant("msg_001", "historical-part", 100),
    ]

    expect(terminalToolPartsForTurn(messages, "msg_002", new Set()).map((part) => part.id))
      .toEqual(["current-part"])
  })
})
