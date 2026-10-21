import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ReadLifecycle } from "@opencode-ai/core/session/runner/read-lifecycle"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"

const created = DateTime.makeUnsafe(0)
const model = { provider: "openai", id: "gpt-test", route: { id: "openai" } } as never

const user = (suffix: string): SessionMessage.Message =>
  new SessionMessage.User({
    id: `msg_user_${suffix}`,
    type: "user",
    text: `prompt ${suffix}`,
    time: { created },
  } as never)

const readTool = (input: {
  id: string
  path: string
  offset?: number
  sha256?: string
  truncated?: boolean
  next?: number
  raw?: boolean
  pageCount?: number
}): SessionMessage.AssistantTool =>
  new SessionMessage.AssistantTool({
    type: "tool",
    id: input.id,
    name: "read",
    state: new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: { path: input.path, ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.raw ? { raw: true } : {}) },
      content: [{ type: "text", text: `page of ${input.path} lines ${input.offset ?? 1}+ (${input.pageCount ?? 40} lines)` }],
      outputPaths: [],
      structured: {
        type: "text-page",
        content: "page",
        mime: "text/plain",
        offset: input.offset ?? 1,
        truncated: input.truncated ?? false,
        ...(input.next !== undefined ? { next: input.next } : {}),
        ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
      },
    }),
    time: { created, ran: created, completed: created },
  } as never)

const assistant = (...content: SessionMessage.AssistantContent[]): SessionMessage.Message =>
  new SessionMessage.Assistant({
    id: `msg_assistant_${content[0]?.id ?? "x"}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-test" },
    content,
    time: { created, completed: created },
  } as never)

const sha = (seed: string) => seed.padEnd(64, "0").slice(0, 64)

describe("read lifecycle", () => {
  test("keeps closed-segment reads frozen even when later turns reread the same version", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r1", path: "src/a.ts", offset: 1, sha256: sha("aaa") })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 1, sha256: sha("aaa") })),
    ]
    const markers = ReadLifecycle.supersededReadMarkers(messages)
    // r1 lives in a closed segment: its projection is frozen and never rewritten
    expect(markers.size).toBe(0)
  })

  test("folds an older tail read into the later identical covering read", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r0", path: "src/a.ts", offset: 1, sha256: sha("aaa") })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 1, sha256: sha("aaa") })),
      assistant(readTool({ id: "call_r3", path: "src/a.ts", offset: 1, sha256: sha("aaa") })),
    ]
    const markers = ReadLifecycle.supersededReadMarkers(messages)
    // r3 is the latest read of that version: stays exact. r2 folds into r3.
    expect(markers.get("call_r3")).toBeUndefined()
    expect(markers.get("call_r2")).toBeDefined()
    expect(markers.get("call_r2")).toContain("call_r3")
  })

  test("never supersedes when the content version changed (different sha)", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r1", path: "src/a.ts", offset: 1, sha256: sha("old") })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 1, sha256: sha("new") })),
    ]
    expect(ReadLifecycle.supersededReadMarkers(messages).size).toBe(0)
  })

  test("respects range coverage for truncated pages", () => {
    // both reads happen inside the mutable tail of the current prompt
    const base = [
      user("1"),
      user("2"),
      assistant(readTool({ id: "call_r1", path: "src/a.ts", offset: 200, sha256: sha("same"), truncated: true, next: 300 })),
    ]
    // newer page ends before the older page's end: no supersession
    const narrow = [...base, assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 100, sha256: sha("same"), truncated: true, next: 150 }))]
    expect(ReadLifecycle.supersededReadMarkers(narrow).size).toBe(0)
    // newer page extends beyond the older page's end: supersession
    const wide = [...base, assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 100, sha256: sha("same"), truncated: true, next: 400 }))]
    expect(ReadLifecycle.supersededReadMarkers(wide).get("call_r1")).toContain("call_r2")
  })

  test("never supersedes a raw-pinned read", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r1", path: "src/a.ts", offset: 1, sha256: sha("same"), raw: true })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 1, sha256: sha("same") })),
    ]
    expect(ReadLifecycle.supersededReadMarkers(messages).size).toBe(0)
  })

  test("projection replaces only the superseded provider view", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r1", path: "src/a.ts", offset: 1, sha256: sha("same") })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/a.ts", offset: 1, sha256: sha("same") })),
      assistant(readTool({ id: "call_r3", path: "src/a.ts", offset: 1, sha256: sha("same") })),
    ]
    const projected = toLLMMessages(messages, model)
    const rendered = projected.map((message) => JSON.stringify(message)).join("\n")
    expect(rendered).toContain("Superseded read of src/a.ts")
    expect(rendered).toContain("page of src/a.ts")
    // exactly one folded view (r3), the retained read r2 and frozen r1 stay exact
    expect(rendered.match(/Superseded read of src\/a\.ts/g)?.length).toBe(1)
    expect(rendered.match(/page of src\/a\.ts/g)?.length).toBe(2)
  })

  test("is deterministic across repeated projections", () => {
    const messages = [
      user("1"),
      assistant(readTool({ id: "call_r1", path: "src/b.ts", offset: 1, sha256: sha("xyz") })),
      user("2"),
      assistant(readTool({ id: "call_r2", path: "src/b.ts", offset: 1, sha256: sha("xyz") })),
    ]
    expect(toLLMMessages(messages, model)).toEqual(toLLMMessages(messages, model))
  })
})
