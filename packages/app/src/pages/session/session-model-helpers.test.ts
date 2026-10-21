import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  resetSessionModel,
  selectRunningAssistant,
  selectSessionModelSource,
  sessionModelSourceKey,
  syncSessionModel,
} from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

const assistant = (input?: {
  id?: string
  providerID?: string
  modelID?: string
  variant?: string
  completed?: boolean
}) =>
  ({
    id: input?.id ?? "msg_asst",
    sessionID: "session",
    role: "assistant",
    parentID: "msg",
    time: { created: 2, ...(input?.completed ? { completed: 3 } : {}) },
    providerID: input?.providerID ?? "anthropic",
    modelID: input?.modelID ?? "claude-opus-5",
    variant: input?.variant,
    mode: "build",
    agent: "build",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as AssistantMessage

describe("syncSessionModel", () => {
  test("resynchronizes when canonical chain metadata arrives after the base model", () => {
    const direct = message({ model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "medium" } })
    const chained = {
      ...direct,
      model: {
        ...direct.model,
        chain: {
          id: "luna-free-qa",
          name: "Luna Free QA",
          steps: [{ providerID: "openai", id: "gpt-5.6-luna" }],
          active: 0,
        },
      },
    }

    expect(sessionModelSourceKey(chained)).not.toBe(sessionModelSourceKey(direct))
  })

  test("reconciles a fresh session readback even when its selected agent and model are unchanged", () => {
    const session = {
      id: "session",
      slug: "session",
      projectID: "project",
      directory: "/repo",
      title: "Session",
      version: "dev",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      time: { created: 1, updated: 2 },
    }

    expect(sessionModelSourceKey(selectSessionModelSource(undefined, { ...session, time: { ...session.time, updated: 3 } })!)).not.toBe(
      sessionModelSourceKey(selectSessionModelSource(undefined, session)!),
    )
  })

  test("uses canonical session metadata when paging has evicted the last user turn", () => {
    expect(
      selectSessionModelSource(undefined, {
        id: "session",
        slug: "session",
        projectID: "project",
        directory: "/repo",
        title: "Long session",
        version: "dev",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6-luna", variant: "high" },
        time: { created: 1, updated: 2 },
      }),
    ).toEqual({
      sessionID: "session",
      agent: "build",
      updatedAt: 2,
      model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high", chain: undefined },
    })
  })

  test("keeps the canonical session selection ahead of a stale loaded user turn", () => {
    const user = message({ model: { providerID: "openrouter", modelID: "openrouter/free" } })
    expect(
      selectSessionModelSource(user, {
        id: "session",
        slug: "session",
        projectID: "project",
        directory: "/repo",
        title: "Long session",
        version: "dev",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
        time: { created: 1, updated: 2 },
      }),
    ).toEqual({
      sessionID: "session",
      agent: "build",
      updatedAt: 2,
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high", chain: undefined },
    })
  })

  test("falls back to the loaded user turn for legacy sessions without a canonical selection", () => {
    const user = message({ model: { providerID: "openrouter", modelID: "openrouter/free" } })
    expect(
      selectSessionModelSource(user, {
        id: "session",
        slug: "session",
        projectID: "project",
        directory: "/repo",
        title: "Legacy session",
        version: "dev",
        time: { created: 1, updated: 2 },
      }),
    ).toBe(user)
  })

  test("keeps the session's Luna/default selection instead of an assistant Sol/high display override", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
       message({ model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "default" } }),
    )

    expect(calls).toEqual([
       message({ model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "default" } }),
    ])
  })

  test("forwards the force option so a session switch overrides a remembered pick", () => {
    const calls: Array<{ msg: unknown; force?: boolean }> = []

    syncSessionModel(
      {
        session: {
          restore(msg, options) {
            calls.push({ msg, force: options?.force })
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
      { force: true },
    )

    expect(calls).toEqual([
      {
        msg: message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
        force: true,
      },
    ])
  })

  test("keeps an OpenRouter free session model from being replaced by a remembered Sol/Xhigh pick", () => {
    const calls: unknown[] = []
    const selected = message({
      model: { providerID: "openrouter", modelID: "openrouter/free", variant: "default" },
    })

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      selected,
      { force: true },
    )

    expect(calls).toEqual([selected])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("selectRunningAssistant", () => {
  test("picks the newest assistant step while the session is busy", () => {
    const messages: Message[] = [
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
      assistant({ id: "msg_asst_1" }),
    ]

    expect(selectRunningAssistant(messages, "busy")?.id).toBe("msg_asst_1")
  })

  test("returns nothing for an idle or unknown status", () => {
    const messages: Message[] = [message(), assistant()]

    expect(selectRunningAssistant(messages, "idle")).toBeUndefined()
    expect(selectRunningAssistant(messages, undefined)).toBeUndefined()
  })

  test("returns nothing when no assistant step exists yet", () => {
    expect(selectRunningAssistant([message()], "busy")).toBeUndefined()
    expect(selectRunningAssistant(undefined, "busy")).toBeUndefined()
  })

  test("keeps the executing step visible while the session stays busy", () => {
    const messages: Message[] = [
      message(),
      assistant({ id: "msg_asst_1", completed: true }),
      assistant({ id: "msg_asst_2", variant: "max" }),
    ]

    expect(selectRunningAssistant(messages, "busy")).toMatchObject({
      id: "msg_asst_2",
      modelID: "claude-opus-5",
      variant: "max",
    })
  })

  test("never surfaces a step beyond the revert boundary", () => {
    const messages: Message[] = [
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }),
      assistant({ id: "msg_asst_1", variant: "high" }),
      message({ model: { providerID: "anthropic", modelID: "claude-opus-5", variant: "max" } }),
      assistant({ id: "msg_asst_2", variant: "max" }),
    ]

    // The revert boundary hides msg_asst_2, so the pre-revert executing step wins.
    expect(selectRunningAssistant(messages, "busy", "msg_asst_2")).toMatchObject({
      id: "msg_asst_1",
      variant: "high",
    })
    expect(selectRunningAssistant(messages, "busy", "msg_asst_1")).toBeUndefined()
    expect(selectRunningAssistant(messages, "busy")).toMatchObject({ id: "msg_asst_2" })
  })
})
