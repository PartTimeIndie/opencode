import type { AssistantMessage, Message, Session, UserMessage } from "@opencode-ai/sdk/v2"

export function runningModelStatus(input: {
  status: string
  messages?: readonly Message[]
  startedAt?: number
  session?: Session
}) {
  if (input.status === "idle") return
  const user = input.messages?.findLast((message): message is UserMessage => message.role === "user")
  if (!user) return

  let assistantMessages: AssistantMessage[] = []
  for (const message of input.messages ?? []) {
    if (message.role === "assistant" && message.parentID === user.id) {
      if (!input.startedAt || message.time.created >= input.startedAt) {
        assistantMessages.push(message)
      }
    }
  }

  if (assistantMessages.length === 0) {
    // The turn has not produced an assistant step yet. While the runner is
    // resolving (or the turn waits for input), showing the session's selected
    // model keeps the status consistent with the composer instead of an
    // open-ended "resolving model" label.
    const model = input.session?.model
    if (!model?.providerID || !model.id) {
      return {
        status: input.status,
        agent: undefined,
        model: undefined,
        variant: undefined,
        chain: undefined,
      }
    }
    const chain = model.chain
    const index = chain?.steps.findIndex(
      (item) => item.providerID === model.providerID && item.id === model.id && item.variant === model.variant,
    )
    return {
      status: input.status,
      agent: undefined,
      model: `${model.providerID}/${model.id}`,
      variant: model.variant,
      chain: index !== undefined && index >= 0 ? `${chain?.name} · ${index + 1}/${chain?.steps.length}` : undefined,
    }
  }

  // Find the assistant message with the latest timestamp
  let latestAssistant = assistantMessages[0]
  for (let i = 1; i < assistantMessages.length; i++) {
    const current = assistantMessages[i]
    if (current.time.created > latestAssistant.time.created) {
      latestAssistant = current
    }
    // If timestamps are equal, keep the later one in the array (current) to maintain some order
    else if (current.time.created === latestAssistant.time.created) {
      latestAssistant = current
    }
  }

  const step = latestAssistant
  const chain = input.session?.model?.chain
  const index = step && chain?.steps.findIndex(
    (item) => item.providerID === step.providerID && item.id === step.modelID && item.variant === step.variant,
  )
  return {
    status: input.status,
    agent: step?.agent,
    model: step?.providerID && step.modelID ? `${step.providerID}/${step.modelID}` : undefined,
    variant: step?.variant,
    chain: index !== undefined && index >= 0 ? `${chain?.name} · ${index + 1}/${chain?.steps.length}` : undefined,
  }
}
