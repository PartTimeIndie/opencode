import { describe, expect, test } from "bun:test"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"

const MARKER = "opencode.scheduled-job-result/v1"
const binding = { name: "scheduled_job_result", marker: MARKER }

const user = (text: string) => ({ type: "user", text })
const interjection = user("Zwischenfrage ohne Vertrag")
const assistantEcho = {
  type: "assistant",
  content: [{ type: "text", text: `Vertrag zur Info: ${MARKER}` }],
}
const compaction = { type: "compaction", summary: `älterer Lauf ${MARKER}`, recent: "" }
const resultCall = (status: string) => ({
  type: "assistant" as const,
  content: [{ type: "tool" as const, name: binding.name, state: { status } }],
})
const otherToolCall = {
  type: "assistant",
  content: [{ type: "tool", name: "read", state: { status: "completed" } }],
}

describe("ToolRegistry.openContractMarkers", () => {
  test("no contracted prompt keeps the gate closed, even with echoed marker text", () => {
    const messages = [user("ganz normaler Chat"), assistantEcho, compaction]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([])
    expect(ToolRegistry.openContractMarkers(messages, [])).toEqual([])
  })

  test("a contracted prompt opens the gate until the result call settles", () => {
    const messages = [user(`Job\n\n${MARKER}`), otherToolCall]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([MARKER])
  })

  test("ordinary interjected user inputs and non-user text do not close an open run", () => {
    const messages = [user(`Job\n\n${MARKER}`), resultCall("running"), interjection, assistantEcho, compaction]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([MARKER])
  })

  test("a completed result call after the latest contracted prompt closes the gate", () => {
    const messages = [user(`Job\n\n${MARKER}`), resultCall("completed"), interjection]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([])
  })

  test("pending, running and error results do not settle the run", () => {
    for (const status of ["pending", "running", "error"]) {
      const messages = [user(`Job\n\n${MARKER}`), resultCall(status)]
      expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([MARKER])
    }
  })

  test("a new contracted prompt in the same session reopens the gate past older settled runs", () => {
    const messages = [
      user(`Lauf 1\n\n${MARKER}`),
      resultCall("completed"),
      interjection,
      user(`Lauf 2\n\n${MARKER}`),
    ]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([MARKER])
    const settledAgain = [...messages, resultCall("completed")]
    expect(ToolRegistry.openContractMarkers(settledAgain, [binding])).toEqual([])
  })

  test("a completed result call that predates the latest contracted prompt does not settle it", () => {
    const messages = [resultCall("completed"), user(`Lauf 2\n\n${MARKER}`)]
    expect(ToolRegistry.openContractMarkers(messages, [binding])).toEqual([MARKER])
  })

  test("bindings settle independently per tool and marker", () => {
    const other = { name: "other_contract_tool", marker: "opencode.other-contract/v1" }
    const messages = [user(`Job A\n\n${MARKER}`), user(`Job B\n\n${other.marker}`), resultCall("completed")]
    expect(ToolRegistry.openContractMarkers(messages, [binding, other])).toEqual([other.marker])
  })
})
