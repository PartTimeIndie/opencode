import type { ToolPart } from "@opencode-ai/sdk/v2"

type StreamEvent = {
  readonly type: string
  readonly properties?: unknown
}

type ToolStarted = {
  readonly kind: "tool-started"
  readonly sessionID: string
  readonly messageID: string
  readonly callID: string
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly timestamp: number
}

type ToolSettled = {
  readonly kind: "tool-succeeded" | "tool-failed"
  readonly sessionID: string
  readonly messageID: string
  readonly callID: string
  readonly timestamp: number
  readonly content?: unknown
  readonly structured?: unknown
  readonly error?: unknown
}

export type V2RunProgress =
  | {
      readonly kind: "step-started"
      readonly sessionID: string
      readonly messageID: string
      readonly agent: string
      readonly model: string
    }
  | {
      readonly kind: "text" | "reasoning"
      readonly sessionID: string
      readonly messageID: string
      readonly partID: string
      readonly text: string
      readonly timestamp: number
    }
  | ToolStarted
  | ToolSettled

export function v2RunProgress(event: StreamEvent, sessionID: string): V2RunProgress | undefined {
  const properties = record(event.properties)
  if (!properties || properties.sessionID !== sessionID) return
  const timestamp = typeof properties.timestamp === "number" ? properties.timestamp : Date.now()

  if (event.type === "session.next.step.started") {
    const model = record(properties.model)
    if (
      typeof properties.assistantMessageID !== "string" ||
      typeof properties.agent !== "string" ||
      !model
    )
      return
    const providerID = typeof model.providerID === "string" ? model.providerID : "unknown"
    const modelID = typeof model.id === "string" ? model.id : "unknown"
    return {
      kind: "step-started",
      sessionID,
      messageID: properties.assistantMessageID,
      agent: properties.agent,
      model: `${providerID}/${modelID}`,
    }
  }

  if (event.type === "session.next.text.ended" || event.type === "session.next.reasoning.ended") {
    const id = event.type === "session.next.text.ended" ? properties.textID : properties.reasoningID
    if (typeof properties.assistantMessageID !== "string" || typeof id !== "string" || typeof properties.text !== "string")
      return
    return {
      kind: event.type === "session.next.text.ended" ? "text" : "reasoning",
      sessionID,
      messageID: properties.assistantMessageID,
      partID: id,
      text: properties.text,
      timestamp,
    }
  }

  if (event.type === "session.next.tool.called") {
    const input = record(properties.input)
    if (
      typeof properties.assistantMessageID !== "string" ||
      typeof properties.callID !== "string" ||
      typeof properties.tool !== "string" ||
      !input
    )
      return
    return {
      kind: "tool-started",
      sessionID,
      messageID: properties.assistantMessageID,
      callID: properties.callID,
      tool: properties.tool,
      input,
      timestamp,
    }
  }

  if (event.type !== "session.next.tool.success" && event.type !== "session.next.tool.failed") return
  if (typeof properties.assistantMessageID !== "string" || typeof properties.callID !== "string") return
  return {
    kind: event.type === "session.next.tool.success" ? "tool-succeeded" : "tool-failed",
    sessionID,
    messageID: properties.assistantMessageID,
    callID: properties.callID,
    timestamp,
    ...(event.type === "session.next.tool.success"
      ? { content: properties.content, structured: properties.structured }
      : { error: properties.error }),
  }
}

export function settledV2ToolPart(progress: ToolSettled, started?: ToolStarted): ToolPart {
  const start = started?.timestamp ?? progress.timestamp
  const input = started?.input ?? {}
  const tool = started?.tool ?? "tool"
  if (progress.kind === "tool-failed") {
    return {
      id: progress.callID,
      sessionID: progress.sessionID,
      messageID: progress.messageID,
      type: "tool",
      callID: progress.callID,
      tool,
      state: {
        status: "error",
        input,
        error: errorText(progress.error),
        time: { start, end: progress.timestamp },
      },
    }
  }
  return {
    id: progress.callID,
    sessionID: progress.sessionID,
    messageID: progress.messageID,
    type: "tool",
    callID: progress.callID,
    tool,
    state: {
      status: "completed",
      input,
      output: contentText(progress.content),
      title: "",
      metadata: record(progress.structured) ?? {},
      time: { start, end: progress.timestamp },
    },
  }
}

function contentText(value: unknown) {
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((item) => {
      const part = record(item)
      if (!part) return []
      if (part.type === "text" && typeof part.text === "string") return [part.text]
      if (part.type === "image" && typeof part.mime === "string") return [`[image: ${part.mime}]`]
      return []
    })
    .join("\n")
}

function errorText(value: unknown) {
  if (typeof value === "string") return value
  const error = record(value)
  if (error && typeof error.message === "string" && error.message.trim()) return error.message
  return "Tool execution failed"
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
