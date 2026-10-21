import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2"
import { runningModelStatus } from "./session-running-status"

const user = (id: string, time: number) => ({
  id,
  sessionID: "session",
  role: "user" as const,
  agent: "build",
  model: { providerID: "first", modelID: "selected" },
  time: { created: time },
})
const assistant = (id: string, parentID: string, time: number, model?: { providerID: string; modelID: string }) => ({
  id,
  sessionID: "session",
  role: "assistant" as const,
  agent: "build",
  providerID: model?.providerID ?? "actual",
  modelID: model?.modelID ?? "running",
  parentID,
  time: { created: time },
  mode: "build",
  path: { cwd: "project", root: "project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

describe("runningModelStatus", () => {
  test("shows the actual model from the current turn, not the selected model", () => {
    const messages: Message[] = [user("one", 100), assistant("step", "one", 200)]
    expect(runningModelStatus({ status: "busy", messages, startedAt: 150 })).toMatchObject({
      agent: "build",
      model: "actual/running",
    })
  })

  test("uses timestamp order when delayed stale assistant metadata arrives after a newer model step", () => {
    const messages: Message[] = [
      user("one", 100),
      assistant("current-luna", "one", 400, { providerID: "luna", modelID: "xhigh" }),
      assistant("delayed-old-free", "one", 350, { providerID: "free", modelID: "old" }),
    ]

    expect(runningModelStatus({ status: "busy", messages, startedAt: 300 })).toMatchObject({
      model: "luna/xhigh",
    })
  })

  test("does not mislabel a new turn with the previous assistant's model", () => {
    const messages: Message[] = [user("one", 100), assistant("old", "one", 200), user("two", 300)]
    expect(runningModelStatus({ status: "busy", messages, startedAt: 300 })).toMatchObject({
      agent: undefined,
      model: undefined,
    })
    expect(
      runningModelStatus({ status: "busy", messages: [user("one", 100), assistant("old", "one", 200)], startedAt: 300 })?.model,
    ).toBeUndefined()
  })

  test("keeps the status consistent with the composer while the new turn has no assistant step yet", () => {
    const session = {
      model: {
        id: "glm-5.3-flash",
        providerID: "zhipuai-coding-plan",
        variant: "default",
        chain: {
          id: "standard-coder",
          name: "Standard Coder",
          steps: [
            { id: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variant: "default" },
            { id: "muse-spark-1.3-contributor", providerID: "opencode-go" },
          ],
        },
      },
    } as Session
    const messages: Message[] = [user("one", 100), assistant("old", "one", 200), user("two", 300)]
    expect(runningModelStatus({ status: "busy", messages, startedAt: 300, session })).toMatchObject({
      agent: undefined,
      model: "zhipuai-coding-plan/glm-5.3-flash",
      variant: "default",
      chain: "Standard Coder · 1/2",
    })
  })

  test("shows the session model without a chain label when it is not a chain step", () => {
    const session = {
      model: { id: "gpt-6.1-sol", providerID: "openai", variant: "xhigh" },
    } as Session
    expect(
      runningModelStatus({ status: "busy", messages: [user("one", 100)], startedAt: 300, session }),
    ).toMatchObject({
      model: "openai/gpt-6.1-sol",
      variant: "xhigh",
      chain: undefined,
    })
  })

  test("shows a chain step only when the actual model matches a configured step", () => {
    const session = {
      model: {
        chain: {
          id: "planning",
          name: "Planning",
          steps: [
            { providerID: "first", id: "selected" },
            { providerID: "actual", id: "running" },
          ],
        },
      },
    } as Session
    expect(runningModelStatus({ status: "busy", messages: [user("one", 100), assistant("step", "one", 200)], session })?.chain).toBe(
      "Planning · 2/2",
    )
  })

  test("matches the actual thinking variant rather than an identically named chain step", () => {
    const session = {
      model: { chain: { id: "planning", name: "Planning", steps: [
        { providerID: "actual", id: "running", variant: "high" },
        { providerID: "actual", id: "running", variant: "medium" },
      ] } },
    } as Session
    const messages: Message[] = [user("one", 100), { ...assistant("step", "one", 200), variant: "medium" }]
    expect(runningModelStatus({ status: "busy", messages, session })).toMatchObject({
      variant: "medium",
      chain: "Planning · 2/2",
    })
  })

  test("never displays a prior model after the run settles", () => {
    expect(runningModelStatus({ status: "idle", messages: [user("one", 100), assistant("step", "one", 200)] })).toBeUndefined()
  })
})
