import type { AssistantMessage, Message, Session, UserMessage } from "@opencode-ai/sdk/v2"

export type SessionModelSource = {
  id?: string
  sessionID: string
  agent: string
  updatedAt?: number
  model: UserMessage["model"] & { chain?: NonNullable<Session["model"]>["chain"] }
}

type Local = {
  session: {
    reset(): void
    restore(msg: SessionModelSource, options?: { force?: boolean }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

// While a session is running, its newest assistant step carries the model and thinking
// variant that are actually executing. The last user message can be stale here: model
// chains escalate, agent handoffs switch models, and the run may continue with a
// different pick than the prompt was admitted with.
//
// A revert boundary hides every message from that ID onward, so steps beyond it must
// never feed the composer — the same comparison the timeline applies to user turns.
export const selectRunningAssistant = (
  messages: readonly Message[] | undefined,
  status?: string,
  revertMessageID?: string,
) => {
  if (status === undefined || status === "idle") return
  return messages?.findLast(
    (message): message is AssistantMessage => message.role === "assistant" && (!revertMessageID || message.id < revertMessageID),
  )
}

export const selectSessionModelSource = (lastUser: UserMessage | undefined, session: Session | undefined): SessionModelSource | undefined => {
  if (session?.agent && session.model) {
    return {
      sessionID: session.id,
      agent: session.agent,
      updatedAt: session.time.updated,
      model: {
        providerID: session.model.providerID,
        modelID: session.model.id,
        variant: session.model.variant,
        chain: session.model.chain,
      },
    }
  }
  return lastUser
}

export const sessionModelSourceKey = (msg: SessionModelSource) =>
  [
    msg.id ?? msg.sessionID,
    msg.agent,
    msg.model.providerID,
    msg.model.modelID,
    msg.model.variant ?? "",
    msg.model.chain?.id ?? "",
    msg.updatedAt ?? "",
  ].join("\u0000")

export const syncSessionModel = (local: Local, msg: SessionModelSource, options?: { force?: boolean }) => {
  local.session.restore(msg, options)
}
