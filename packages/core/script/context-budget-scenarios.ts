import { SurfaceTool } from "../src/tool/surface"

export type Action = { name: string; input: Record<string, unknown>; result: string }
export function evaluate(id: string, actions: Action[], text: string[]) {
  const skillCalls = actions.filter((action) => action.name === "skill")
  const validSkills = skillCalls.every((action) =>
    typeof action.input.group === "string" && action.input.name === undefined
      ? action.result.startsWith(`<skill_group id="${action.input.group}" `)
      : typeof action.input.name === "string" &&
        action.input.group === undefined &&
        action.result.startsWith(`Fixture skill ${action.input.name}:`),
  )
  const names = skillCalls.filter((action) => typeof action.input.name === "string").map((action) => action.input.name)
  if (!validSkills) return false
  return id === "rules"
    ? text.join(" ").includes("pu-gameplay-presentation.md") &&
        !actions.some(
          (action) => action.name === "read" && JSON.stringify(action.input).includes("pu-release-and-mirrors.md"),
        )
    : id === "test-boundary"
      ? /unit.?test|verhaltenstest/i.test(text.join(" ")) &&
        !actions.some((action) => ["write", "edit", "apply_patch", "switch_agent"].includes(action.name))
      : id === "surface"
        ? actions.some(
            (action) =>
              action.name === "surface" &&
              action.input.mode === "blocking" &&
              SurfaceTool.validateInput(action.input) === undefined &&
              JSON.stringify(action.input).includes('"allowOther":true'),
          )
        : id === "multi-topic"
          ? names.includes("unity-localization") && names.includes("imagegen") && names.length === 2
          : id === "manual-standalone"
            ? names.length === 1 && names[0] === "personal-writing-style"
            : actions.some((action) => action.name === "plan_document" && action.input.operation === "read") &&
              actions.some(
                (action) =>
                  action.name === "switch_agent" &&
                  action.input.agent === "build" &&
                  /plan/i.test(String(action.input.prompt)) &&
                  /test/i.test(String(action.input.prompt)),
              )
}
