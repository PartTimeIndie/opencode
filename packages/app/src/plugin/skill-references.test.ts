import { describe, expect, test } from "bun:test"
import { skillReferences } from "./skill-references"

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
