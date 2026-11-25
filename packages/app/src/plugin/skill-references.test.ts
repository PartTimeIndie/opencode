import { describe, expect, test } from "bun:test"
import { skillReferenceDiagnostics, skillReferences } from "./skill-references"

const commands = [
  { name: "visual-qa-testing", description: "Verify UI", aliases: ["visual qa"], source: "skill" as const },
  { name: "progressive-plan-builder", description: "Create a plan", source: "skill" as const },
  { name: "configured", description: "Not a skill", source: "command" as const },
]

describe("skillReferences", () => {
  test("returns every real skill for the full catalog", () => {
    expect(skillReferences({ commands })).toEqual([
      {
        name: "visual-qa-testing",
        reference: "/visual-qa-testing",
        title: undefined,
        description: "Verify UI",
        aliases: ["visual qa"],
      },
      {
        name: "progressive-plan-builder",
        reference: "/progressive-plan-builder",
        title: undefined,
        description: "Create a plan",
        aliases: [],
      },
    ])
  })

  test("joins visible toolbar metadata to real skills only", () => {
    expect(
      skillReferences({
        commands,
        toolbar: [
          {
            title: "Visual QA",
            skill: { name: "visual-qa-testing", aliases: ["ui testing", "visual qa", "  "] },
          },
          { title: "Missing", skill: { name: "missing-skill" } },
          { title: "Plain plugin" },
        ],
      }),
    ).toEqual([
      {
        name: "visual-qa-testing",
        reference: "/visual-qa-testing",
        title: "Visual QA",
        description: "Verify UI",
        aliases: ["visual qa", "ui testing"],
      },
    ])
  })
})

describe("skillReferenceDiagnostics", () => {
  test("distinguishes command targets, missing skills and clean entries", () => {
    expect(
      skillReferenceDiagnostics({
        commands,
        toolbar: [
          { title: "Codex Image", command: { name: "configured" } },
          { title: "Missing", skill: { name: "missing-skill" } },
          { title: "Missing command", command: { name: "unknown-command" } },
          {
            title: "Visual QA",
            skill: { name: "visual-qa-testing", aliases: ["ui testing"] },
          },
        ],
      }),
    ).toEqual([
      {
        name: "configured",
        title: "Codex Image",
        reference: "/configured",
        kind: "command-not-skill",
        message: "This is a command, not a skill. An appended reference does not dispatch its command template.",
      },
      {
        name: "missing-skill",
        title: "Missing",
        reference: "/missing-skill",
        kind: "not-found",
        message: "Name not found in the current location catalog.",
      },
      {
        name: "unknown-command",
        title: "Missing command",
        reference: "/unknown-command",
        kind: "not-found",
        message: "Name not found in the current location catalog.",
      },
    ])
  })

  test("reports manual-only and unavailable tools independently using server constraints", () => {
    const result = skillReferenceDiagnostics({
      commands,
      toolbar: [{ title: "Visual QA", skill: { name: "visual-qa-testing" } }],
      constraints: [{ name: "visual-qa-testing", manualOnly: true, missingTools: ["surface"] }],
    })
    expect(result.map((item) => item.kind)).toEqual(["manual-only", "missing-tools"])
    // A toolbar-armed submission appends the exact slash token, which the core
    // gate accepts as explicit user invocation; only the bare click does nothing.
    expect(result[0]?.message).toContain("submitted with your message")
    expect(result[1]?.missingTools).toEqual(["surface"])
  })

  test("never hides matching skill entries from a second catalog", () => {
    expect(
      skillReferenceDiagnostics({
        commands,
        toolbar: [{ title: "Plan", skill: { name: "progressive-plan-builder" } }],
      }),
    ).toEqual([])
  })
})
