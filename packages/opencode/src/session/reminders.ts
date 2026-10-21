import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { Session } from "./session"

/**
 * Agent prompts, tool policies, and handoff behavior are configuration-owned.
 * This compatibility hook deliberately does not infer lifecycle semantics from
 * reserved agent names.
 */
export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  return input.messages
})

export * as SessionReminders from "./reminders"
