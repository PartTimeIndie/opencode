import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import plugin from "./index.js"
import manifest from "./package.json"

const skill = readFileSync(new URL("./skills/native-orchestrator/SKILL.md", import.meta.url), "utf8")
const text = skill.replace(/\s+/g, " ")

test("the native orchestrator uses only the host's scoped one-shot skill toggle", () => {
  const items = []
  plugin.app({ toolbar: { register: (item) => items.push(item) } })
  expect(plugin.id).toBe("native-orchestrator-app")
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    id: "native-orchestrator",
    title: "Nativer Orchestrator",
    placement: "composer",
    defaultVisible: true,
    mobile: "visible",
    skill: { name: "native-orchestrator" },
    appendOnSubmit: true,
  })
  for (const key of ["run", "mount", "visible", "enabled", "command"]) expect(items[0][key]).toBeUndefined()
  expect(manifest.exports).toEqual({ "./app": "./index.js" })
  expect(manifest.opencode.app.capabilities).toEqual(["ui:toolbar", "host:composer"])
  const icon = readFileSync(new URL(items[0].icon.src), "utf8")
  expect(icon).toContain('stroke="currentColor"')
  expect(icon).not.toMatch(/<script|<image|(?:href|src)=["']https?:|#[0-9a-f]{3,8}\b|<text/i)
})

test("the manual OpenCode skill plans in Main before creating conversation forks", () => {
  expect(skill).toMatch(/^---\nname: native-orchestrator\n/)
  expect(skill).toContain("disable-model-invocation: true")
  expect(skill).toContain("OpenCode-only")
  expect(skill.indexOf("## 1. Plan in the main conversation")).toBeLessThan(skill.indexOf("## 2. Fork the agreed plan"))
  expect(text).toContain("dispatch uses native `task` from Main")
  expect(text).toContain("already agreed and explicitly authorized for implementation")
  expect(skill).toContain("Do not start implementation children during planning")
  expect(skill).toContain("completed conversation context, including the agreed plan")
  expect(skill).toContain("Later Main messages are not automatically broadcast")
  expect(skill).toContain("A conversation fork and a file mirror are different")
})

test("planning stays in normal mode without a handoff and forks still require authorization", () => {
  expect(text).toContain("Planning and plan refinement stay in the Orchestrator main conversation in normal mode")
  expect(text).toContain("even when the user says to plan first")
  expect(text).toContain("Do not call `switch_agent` or enter Plan Mode for this workflow")
  expect(text).toContain("obtain explicit implementation authorization before dispatch")
  expect(text).not.toContain('`switch_agent` with `agent: "plan"`')
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8").replace(/\s+/g, " ")
  expect(readme).toContain("Planning stays in the Orchestrator main conversation in normal mode")
  expect(readme).toContain("The workflow does not switch agents or enter Plan Mode")
})

test("the skill hands execution to the child without restarting Main's workflow", () => {
  const child = text.indexOf("directly assigned execution fork")
  expect(child).toBeGreaterThan(-1)
  expect(child).toBeLessThan(text.indexOf("## 1. Plan in the main conversation"))
  expect(text).toContain("Imported parent history is background")
  expect(text).toContain("Carry out and verify your current assignment yourself; do not delegate it again")
  expect(text).toContain("Main coordinates, reviews and handles any authorized integration")
  expect(text).toContain("Start each conversation-fork assignment and follow-up with an explicit handoff")
})

test("explicit ordinary-subagent requests retain the agreed scope without weakening native admission", () => {
  expect(text).toContain("If the user explicitly requests ordinary subagents without conversation forks")
  expect(text).toContain('use `context: "fresh"` with a self-contained assignment')
  expect(text).toContain("never an automatic fallback after fork admission fails")
  expect(text).toContain("Main retains planning and rule decisions")
  expect(text).toContain("No mirror or worktree is implied")
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8").replace(/\s+/g, " ")
  expect(readme).toContain("Main keeps planning and rule decisions")
  expect(readme).toContain("mirrors are not implied")
})

test("native collection and reviewed integration retain their real authorization gates", () => {
  for (const text of [
    "same actual model, reasoning/variant and permission settings",
    '`workspace: "mirror"`',
    "`task_wait`",
    "`task_result`",
    "terminal child",
    "no total-runtime deadline",
    "`task_integrate` without `plan_digest`",
    "fresh single-use host approval",
    "package's `bun typecheck`",
    "Do not silently switch to direct implementation",
    "Historical children, claims and approvals stay unchanged",
  ]) expect(skill.replace(/\s+/g, " ")).toContain(text)
  expect(skill).not.toContain("experimental.session_orchestrator")
  expect(skill).not.toContain("workspaceMode")
})
