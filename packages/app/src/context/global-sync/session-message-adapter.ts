import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { compareMessageTime } from "@/utils/message-order"
import { toolDetailsMetadata } from "@opencode-ai/core/util/tool-details"
import { recoveryNotice } from "./recovery-notice"

const fallbackModel: UserMessage["model"] = { providerID: "", modelID: "" }

export function adaptSessionMessages(sessionID: string, input: readonly SessionMessage[]) {
  const messages: Message[] = []
  const parts: { id: string; part: Part[] }[] = []
  const ordered = orderedSessionMessages(input)
  let agent = "assistant"
  let model = fallbackModel
  let parentID: string | undefined

  for (const message of ordered) {
    if (message.type === "agent-switched") {
      agent = message.agent
      continue
    }
    if (message.type === "model-switched") {
      model = { providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant }
      continue
    }
    if (message.type === "assistant") {
      if (!parentID) continue
      messages.push(adaptAssistantMessage(sessionID, message, parentID))
      parts.push({
        id: message.id,
        part: (message.content ?? []).flatMap((content) => adaptAssistantPart(sessionID, message, content)),
      })
      continue
    }
    if (message.type === "system") {
      if (parentID && message.metadata?.systemNotice === "server-recovery") {
        const notice = recoveryNotice(sessionID, message, parentID)
        messages.push(notice.message)
        parts.push({ id: message.id, part: notice.parts })
      }
      continue
    }

    const adapted = adaptUserLikeMessage(sessionID, message, agent, model)
    if (!adapted) continue
    parentID = adapted.message.id
    messages.push(adapted.message)
    parts.push({ id: adapted.message.id, part: adapted.parts })
  }

  return { messages, parts }
}

export function needsOlderSessionMessageContext(input: readonly SessionMessage[]) {
  for (const message of orderedSessionMessages(input)) {
    if (isUserLikeMessage(message)) return false
    if (message.type === "assistant" || (message.type === "system" && message.metadata?.systemNotice === "server-recovery")) return true
  }
  return false
}

function orderedSessionMessages(input: readonly SessionMessage[]) {
  return input.slice().sort(compareMessageTime)
}

function isUserLikeMessage(message: SessionMessage) {
  return message.type === "user" || message.type === "compaction" || message.type === "synthetic" || message.type === "shell"
}

function adaptUserLikeMessage(
  sessionID: string,
  message: SessionMessage,
  agent: string,
  model: UserMessage["model"],
): { message: UserMessage; parts: Part[] } | undefined {
  if (message.type === "user") {
    return {
      message: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model,
      },
      parts: [
        textPart(sessionID, message.id, message.text),
        ...(message.files ?? []).map((file, index) => filePart(sessionID, message.id, `file:${index}`, file.uri, file.mime, file.name)),
      ],
    }
  }
  if (message.type === "compaction") {
    return {
      message: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model,
      },
      parts: [
        {
          id: `${message.id}:compaction`,
          sessionID,
          messageID: message.id,
          type: "compaction",
          auto: message.reason === "auto",
        },
        textPart(sessionID, message.id, `${message.summary}\n\n${message.recent}`.trim(), "summary"),
      ],
    }
  }
  if (message.type === "synthetic") {
    return {
      message: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model,
      },
      parts: [textPart(sessionID, message.id, message.text)],
    }
  }
  if (message.type === "shell") {
    return {
      message: {
        id: message.id,
        sessionID,
        role: "user",
        time: { created: message.time.created },
        agent,
        model,
      },
      parts: [textPart(sessionID, message.id, `$ ${message.command}\n${message.output}`.trim())],
    }
  }
}

function adaptAssistantMessage(sessionID: string, message: SessionMessageAssistant, parentID: string): AssistantMessage {
  const model = assistantModel(message.model)
  const error = message.error || message.failure
    ? {
        name: "UnknownError" as const,
        data: {
          message: message.failure?.message ?? message.error?.message ?? "The session step failed.",
          ...(message.failure?.code !== undefined ? { code: message.failure.code } : {}),
          ...(message.failure?.remediation !== undefined ? { remediation: message.failure.remediation } : {}),
        },
      }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    parentID,
    time: message.time,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: {
      input: message.tokens?.input ?? 0,
      output: message.tokens?.output ?? 0,
      reasoning: message.tokens?.reasoning ?? 0,
      cache: { read: message.tokens?.cache.read ?? 0, write: message.tokens?.cache.write ?? 0 },
    },
    variant: model.variant,
    finish: message.finish,
    error,
  }
}

function assistantModel(value: unknown) {
  if (!record(value)) return fallbackModel
  return {
    providerID: typeof value.providerID === "string" ? value.providerID : "",
    modelID: typeof value.id === "string" ? value.id : typeof value.modelID === "string" ? value.modelID : "",
    variant: typeof value.variant === "string" ? value.variant : undefined,
  }
}

function adaptAssistantPart(
  sessionID: string,
  message: SessionMessageAssistant,
  content: SessionMessageAssistant["content"][number],
): Part[] {
  if (content.type === "text") return [textPart(sessionID, message.id, content.text, content.id)]
  if (content.type === "reasoning") {
    return [
      {
        id: content.id,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        metadata: content.providerMetadata,
        time: { start: message.time.created, end: message.time.completed },
      },
    ]
  }
  if (content.type === "custom") {
    return [
      {
        id: content.id,
        sessionID,
        messageID: message.id,
        type: "custom",
        kind: content.kind,
        data: content.data,
        title: content.title,
        fallback: content.fallback,
        metadata: content.metadata,
        time: content.time,
      },
    ]
  }
  return [adaptToolPart(sessionID, message, content)]
}

function adaptToolPart(sessionID: string, message: SessionMessageAssistant, content: SessionMessageAssistantTool): Part {
  const start = content.time.ran ?? content.time.created
  const end = content.time.completed ?? start
  const metadata = toolMetadata(content)
  const base = {
    id: content.id,
    sessionID,
    messageID: message.id,
    type: "tool" as const,
    callID: content.id,
    tool: content.name,
    metadata: content.provider?.metadata,
  }
  if (content.state.status === "pending") return { ...base, state: { status: "pending", input: {}, raw: content.state.input } }
  if (content.state.status === "running")
    return {
      ...base,
      state: { status: "running", input: content.state.input, title: content.name, metadata, time: { start } },
    }
  if (content.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: content.state.input,
        error: content.state.error.message,
        metadata,
        time: { start, end },
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input: content.state.input,
      output: content.state.content.map((item) => (item.type === "text" ? item.text : `[${item.mime}: ${item.name ?? item.uri}]`)).join("\n"),
      title: content.name,
      metadata,
      time: { start, end, compacted: content.time.pruned },
      attachments: content.state.attachments?.map((item, index) => filePart(sessionID, message.id, `attachment:${index}`, item.uri, item.mime, item.name)),
    },
  }
}

function toolMetadata(content: SessionMessageAssistantTool) {
  const metadata = content.provider?.resultMetadata ?? {}
  if (content.state.status === "pending") return metadata
  if (content.name !== "task") return toolDetailsMetadata(content.name, content.state.structured, metadata)
  const structured = content.state.structured
  return {
    ...metadata,
    ...(typeof structured.task_id === "string" && structured.task_id ? { task_id: structured.task_id } : {}),
    ...(typeof structured.sessionID === "string" && structured.sessionID ? { sessionID: structured.sessionID } : {}),
    ...(typeof structured.background === "boolean" ? { background: structured.background } : {}),
    ...(structured.state === "running" || structured.state === "completed" || structured.state === "error" || structured.state === "cancelled"
      ? { state: structured.state }
      : {}),
  }
}

function textPart(sessionID: string, messageID: string, text: string, id = "text"): Part {
  return { id: `${messageID}:${id}`, sessionID, messageID, type: "text", text }
}

function filePart(sessionID: string, messageID: string, id: string, url: string, mime: string, filename?: string): FilePart {
  return { id: `${messageID}:${id}`, sessionID, messageID, type: "file", url, mime, filename }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
