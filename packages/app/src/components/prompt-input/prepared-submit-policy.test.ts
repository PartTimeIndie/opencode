import { expect, test } from "bun:test"
import { preparedSendPolicy } from "./prepared-submit-policy"

const commands = [{ name: "goal" }, { name: "review" }, { name: "spawn-new-agent", source: "skill" }]

test("queued and working commands remain prompt text, not server commands", () => {
  for (const text of ["/review this", "/goal fix this"]) {
    expect(preparedSendPolicy({ text, working: true, shouldQueue: false, commands }).command).toBeUndefined()
    expect(preparedSendPolicy({ text, working: false, shouldQueue: true, commands }).command).toBeUndefined()
  }
  expect(preparedSendPolicy({ text: "/review this", working: false, shouldQueue: false, commands })).toMatchObject({ command: "review", arguments: "this" })
  expect(preparedSendPolicy({ text: "/spawn-new-agent work", working: false, shouldQueue: false, commands }).command).toBeUndefined()
})

test("goal control stays a command, visible goal becomes a prompt and pins its UI goal", () => {
  expect(preparedSendPolicy({ text: "/goal stop", working: true, shouldQueue: true, commands })).toMatchObject({ command: "goal", visibleGoal: "" })
  expect(preparedSendPolicy({ text: "/goal fix this", working: false, shouldQueue: false, commands })).toMatchObject({ command: undefined, visibleGoal: "fix this" })
  expect(preparedSendPolicy({ text: "/goal fix this", working: true, shouldQueue: false, commands })).toMatchObject({ command: undefined, visibleGoal: "fix this" })
  expect(preparedSendPolicy({ text: "/goal fix this", working: false, shouldQueue: true, commands })).toMatchObject({ command: undefined, visibleGoal: "fix this" })
})
