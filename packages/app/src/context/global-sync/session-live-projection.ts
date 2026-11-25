import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { toolDetailsMetadata } from "@opencode-ai/core/util/tool-details"
import { latestMessage } from "@/utils/message-order"
import { recoveryNotice } from "./recovery-notice"

type StreamEvent = {
  id?: string
  type: string
  data?: unknown
}

type Store = {
  message: Readonly<Record<string, readonly Message[] | undefined>>
  part: Readonly<Record<string, readonly Part[] | undefined>>
}

type EventEvidence = {
  timestamp: number
  eventID?: string
}

type ToolEvidence = EventEvidence & { status: "pending" | "running" | "completed" | "error" }

export type LiveProjectionAction =
  | { kind: "message"; sessionID: string; message: Message; parts?: Part[] }
  | { kind: "part"; sessionID: string; messageID: string; part: Part }
  | { kind: "handled"; sessionID: string }

export function createSessionLiveProjection() {
  const seen = new Set<string>()
  const shells = new Map<string, { messageID: string; command: string }>()
  const tools = new Map<string, ToolEvidence>()
  const assistants = new Map<string, EventEvidence>()

  const handle = (event: StreamEvent, store: Store): LiveProjectionAction | undefined => {
    const data = record(event.data)
    if (!data || typeof data.sessionID !== "string") return
    const type = event.type.replace(/\.\d+$/, "")
    if (!LIVE_EVENT_TYPES.has(type)) return
    if (event.id && seen.has(event.id)) return { kind: "handled", sessionID: data.sessionID }

    const action = type.startsWith("session.next.shell.")
      ? projectShell(type, data, store, shells)
      : project(type, data, store, event.id, tools, assistants)
    if (!action) return
    if (event.id) {
      seen.add(event.id)
      if (seen.size > 4096) seen.delete(seen.values().next().value!)
    }
    return action
  }

  const clear = () => {
    seen.clear()
    shells.clear()
    // Ordering evidence deliberately survives stream reconnects. Both maps are
    // bounded below, and retained evidence prevents hydrated state from accepting
    // a delayed older event after the transient deduplication window is reset.
  }
  return { handle, clear }
}

const LIVE_EVENT_TYPES = new Set([
  "session.next.prompt.promoted",
  "session.next.context.updated",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
])

function projectShell(
  type: string,
  data: Record<string, unknown>,
  store: Store,
  shells: Map<string, { messageID: string; command: string }>,
): LiveProjectionAction | undefined {
  const sessionID = data.sessionID as string
  if (typeof data.callID !== "string" || typeof data.timestamp !== "number") return
  const key = `${sessionID}\n${data.callID}`
  if (type === "session.next.shell.started") {
    if (typeof data.messageID !== "string" || typeof data.command !== "string") return
    shells.set(key, { messageID: data.messageID, command: data.command })
    const previous = latestMessage((store.message[sessionID] ?? []).filter((message) => message.role === "user"))
    return {
      kind: "message",
      sessionID,
      message: {
        id: data.messageID,
        sessionID,
        role: "user",
        time: { created: data.timestamp },
        agent: previous?.role === "user" ? previous.agent : "build",
        model: previous?.role === "user" ? previous.model : { providerID: "", modelID: "" },
      },
      parts: [shellPart(sessionID, data.messageID, data.command, "")],
    }
  }

  const shell = shells.get(key)
  if (!shell) return
  shells.delete(key)
  return {
    kind: "part",
    sessionID,
    messageID: shell.messageID,
    part: shellPart(sessionID, shell.messageID, shell.command, typeof data.output === "string" ? data.output : ""),
  }
}

function shellPart(sessionID: string, messageID: string, command: string, output: string): Part {
  return {
    id: `${messageID}:shell`,
    sessionID,
    messageID,
    type: "text",
    text: `$ ${command}\n${output}`.trim(),
  }
}

function project(
  type: string,
  data: Record<string, unknown>,
  store: Store,
  eventID: string | undefined,
  tools: Map<string, ToolEvidence>,
  assistants: Map<string, EventEvidence>,
): LiveProjectionAction | undefined {
  const sessionID = data.sessionID as string
  if (type === "session.next.context.updated") {
    if (typeof data.messageID !== "string" || !data.messageID.startsWith("msg_crash_") ||
      typeof data.timestamp !== "number" || typeof data.text !== "string") return
    const parent = latestMessage((store.message[sessionID] ?? []).filter((message) => message.role === "user"))
    if (!parent) return
    const notice = recoveryNotice(sessionID, { id: data.messageID, text: data.text, time: { created: data.timestamp } }, parent.id)
    return { kind: "message", sessionID, ...notice }
  }
  if (type === "session.next.prompt.promoted") return projectPromotedPrompt(sessionID, data, store)
  if (type === "session.next.step.started") return startAssistant(sessionID, data, store)
  if (type === "session.next.step.ended" || type === "session.next.step.failed")
    return finishAssistant(type, sessionID, data, store, eventID, assistants)
  if (type === "session.next.text.started" || type === "session.next.text.ended")
    return projectText(type, sessionID, data, store)
  if (type === "session.next.reasoning.started" || type === "session.next.reasoning.ended")
    return projectReasoning(type, sessionID, data, store)
  return projectTool(type, sessionID, data, store, eventID, tools)
}

function projectPromotedPrompt(
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
): LiveProjectionAction | undefined {
  if (typeof data.messageID !== "string" || typeof data.timestamp !== "number") return
  const prompt = record(data.prompt)
  if (!prompt || typeof prompt.text !== "string") return

  const parts: Part[] = [
    {
      id: `${data.messageID}:text`,
      sessionID,
      messageID: data.messageID,
      type: "text",
      text: prompt.text,
    },
  ]
  if (Array.isArray(prompt.files)) {
    for (const [index, file] of prompt.files.entries()) {
      const attachment = record(file)
      if (!attachment || typeof attachment.uri !== "string" || typeof attachment.mime !== "string") continue
      parts.push({
        id: `${data.messageID}:file:${index}`,
        sessionID,
        messageID: data.messageID,
        type: "file",
        mime: attachment.mime,
        filename: typeof attachment.name === "string" ? attachment.name : undefined,
        url: attachment.uri,
      })
    }
  }

  const existing = findMessage(store, sessionID, data.messageID)
  const existingParts = store.part[data.messageID] ?? []
  const missing = parts.filter((part) =>
    existingParts.every((current) => {
      if (part.type === "text") return current.type !== "text" || current.text !== part.text
      if (!("url" in current) || !("mime" in current)) return true
      const file = current as { url: string; mime: string }
      const expected = part as { url: string; mime: string }
      return file.url !== expected.url || file.mime !== expected.mime
    }),
  )
  const model = record(prompt.model)
  const promptModel =
    model && typeof model.providerID === "string" && typeof model.id === "string"
      ? {
          providerID: model.providerID,
          modelID: model.id,
          variant: typeof model.variant === "string" ? model.variant : undefined,
        }
      : undefined

  if (existing?.role === "user") {
    // Optimistic messages can retain a previous selection. Explicit promoted metadata is authoritative;
    // omitted metadata preserves the existing resume/fallback value.
    const agent = typeof prompt.agent === "string" ? prompt.agent : existing.agent
    const nextModel = promptModel ?? existing.model
    if (missing.length === 0 && agent === existing.agent && nextModel === existing.model)
      return { kind: "handled", sessionID }
    return { kind: "message", sessionID, message: { ...existing, agent, model: nextModel }, parts: missing }
  }

  if (existing && missing.length === 0) return { kind: "handled", sessionID }
  if (existing) return { kind: "message", sessionID, message: existing, parts: missing }

  const previous = latestMessage((store.message[sessionID] ?? []).filter((message) => message.role === "user"))
  const message: Message = {
    id: data.messageID,
    sessionID,
    role: "user",
    time: { created: typeof data.timeCreated === "number" ? data.timeCreated : data.timestamp },
    agent: typeof prompt.agent === "string" ? prompt.agent : (previous?.agent ?? "assistant"),
    model: promptModel ?? previous?.model ?? { providerID: "", modelID: "" },
    ...(typeof prompt.system === "string" ? { system: prompt.system } : {}),
  }
  return { kind: "message", sessionID, message, parts }
}

function startAssistant(
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
): LiveProjectionAction | undefined {
  if (typeof data.assistantMessageID !== "string" || typeof data.timestamp !== "number") return
  const existing = findMessage(store, sessionID, data.assistantMessageID)
  if (existing) return { kind: "handled", sessionID }
  const parent = latestMessage((store.message[sessionID] ?? []).filter((message) => message.role === "user"))
  if (!parent) return
  const model = record(data.model)
  return {
    kind: "message",
    sessionID,
    message: {
      id: data.assistantMessageID,
      sessionID,
      role: "assistant",
      parentID: parent.id,
      time: { created: data.timestamp },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: typeof model?.id === "string" ? model.id : "",
      providerID: typeof model?.providerID === "string" ? model.providerID : "",
      variant: typeof model?.variant === "string" ? model.variant : undefined,
      mode: "build",
      agent: typeof data.agent === "string" ? data.agent : "assistant",
      path: { cwd: "", root: "" },
    },
  }
}

function finishAssistant(
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
  eventID: string | undefined,
  evidence: Map<string, EventEvidence>,
): LiveProjectionAction | undefined {
  if (typeof data.assistantMessageID !== "string" || typeof data.timestamp !== "number") return
  const message = findMessage(store, sessionID, data.assistantMessageID)
  if (!message || message.role !== "assistant") return
  const key = `${sessionID}\n${data.assistantMessageID}`
  const incoming = { timestamp: data.timestamp, eventID }
  const current = evidence.get(key) ?? (message.time.completed ? { timestamp: message.time.completed } : undefined)
  if (current && compareEvidence(incoming, current) <= 0) return { kind: "handled", sessionID }
  const tokens = record(data.tokens)
  const cache = record(tokens?.cache)
  const error = record(data.error)
  const action = {
    kind: "message",
    sessionID,
    message: {
      ...message,
      time: { ...message.time, completed: data.timestamp },
      ...(type === "session.next.step.failed"
        ? {
            finish: "error",
            error: {
              name: "UnknownError" as const,
              data: { message: typeof error?.message === "string" ? error.message : "Unknown error" },
            },
          }
        : {
            finish: typeof data.finish === "string" ? data.finish : message.finish,
            error: undefined,
            cost: typeof data.cost === "number" ? data.cost : message.cost,
            tokens: tokens
              ? {
                  input: number(tokens.input),
                  output: number(tokens.output),
                  reasoning: number(tokens.reasoning),
                  cache: { read: number(cache?.read), write: number(cache?.write) },
                }
              : message.tokens,
          }),
    },
  } satisfies LiveProjectionAction
  remember(evidence, key, incoming)
  return action
}

function projectText(
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
): LiveProjectionAction | undefined {
  if (typeof data.assistantMessageID !== "string" || typeof data.textID !== "string") return
  if (!findMessage(store, sessionID, data.assistantMessageID)) return
  const id = `${data.assistantMessageID}:${data.textID}`
  const existing = findPart(store, data.assistantMessageID, id)
  const incoming = type.endsWith(".ended") && typeof data.text === "string" ? data.text : ""
  const text = existing?.type === "text" && existing.text.startsWith(incoming) ? existing.text : incoming
  return {
    kind: "part",
    sessionID,
    messageID: data.assistantMessageID,
    part: { id, sessionID, messageID: data.assistantMessageID, type: "text", text },
  }
}

function projectReasoning(
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
): LiveProjectionAction | undefined {
  if (
    typeof data.assistantMessageID !== "string" ||
    typeof data.reasoningID !== "string" ||
    typeof data.timestamp !== "number"
  )
    return
  if (!findMessage(store, sessionID, data.assistantMessageID)) return
  const existing = findPart(store, data.assistantMessageID, data.reasoningID)
  const incoming = type.endsWith(".ended") && typeof data.text === "string" ? data.text : ""
  const text = existing?.type === "reasoning" && existing.text.startsWith(incoming) ? existing.text : incoming
  return {
    kind: "part",
    sessionID,
    messageID: data.assistantMessageID,
    part: {
      id: data.reasoningID,
      sessionID,
      messageID: data.assistantMessageID,
      type: "reasoning",
      text,
      metadata: record(data.providerMetadata) ?? (existing?.type === "reasoning" ? existing.metadata : undefined),
      time: {
        start: existing?.type === "reasoning" ? existing.time.start : data.timestamp,
        ...(type.endsWith(".ended") ? { end: data.timestamp } : {}),
      },
    },
  }
}

function projectTool(
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  store: Store,
  eventID: string | undefined,
  evidence: Map<string, ToolEvidence>,
): LiveProjectionAction | undefined {
  if (
    typeof data.assistantMessageID !== "string" ||
    typeof data.callID !== "string" ||
    typeof data.timestamp !== "number"
  )
    return
  if (!findMessage(store, sessionID, data.assistantMessageID)) return
  const existing = findPart(store, data.assistantMessageID, data.callID)
  const existingState = existing?.type === "tool" ? existing.state : undefined
  const incomingStatus: ToolEvidence["status"] =
    type === "session.next.tool.success"
      ? "completed"
      : type === "session.next.tool.failed"
        ? "error"
        : type === "session.next.tool.called" || type === "session.next.tool.progress"
          ? "running"
          : "pending"
  const evidenceKey = `${sessionID}\n${data.assistantMessageID}\n${data.callID}`
  const currentEvidence = evidence.get(evidenceKey)
  if (
    (existingState?.status === "completed" || existingState?.status === "error") &&
    incomingStatus !== "completed" &&
    incomingStatus !== "error"
  )
    return { kind: "handled", sessionID }
  const fallback =
    existingState && "time" in existingState && existingState.time
      ? {
          timestamp:
            existingState.status === "completed" || existingState.status === "error"
              ? existingState.time.end
              : existingState.time.start,
          status: existingState.status,
        }
      : undefined
  const incoming = { timestamp: data.timestamp, eventID, status: incomingStatus }
  if (compareToolEvidence(incoming, currentEvidence ?? fallback) <= 0) return { kind: "handled", sessionID }
  const pendingRaw = existing?.type === "tool" && existing.state.status === "pending" ? existing.state.raw : undefined
  const tool =
    existing?.type === "tool"
      ? existing.tool
      : typeof data.name === "string"
        ? data.name
        : typeof data.tool === "string"
          ? data.tool
          : undefined
  if (!tool) return
  if (type === "session.next.tool.input.ended" && pendingRaw === undefined) return
  const inputText =
    type === "session.next.tool.input.ended" ? (typeof data.text === "string" ? data.text : "") : undefined
  if (inputText !== undefined && !pendingRaw!.startsWith(inputText) && !inputText.startsWith(pendingRaw!)) return
  const base = {
    id: data.callID,
    sessionID,
    messageID: data.assistantMessageID,
    type: "tool" as const,
    callID: data.callID,
    tool,
    metadata: existing?.type === "tool" ? existing.metadata : record(record(data.provider)?.metadata),
  }
  const currentInput = existing?.type === "tool" ? existing.state.input : {}
  const currentStart =
    existing?.type === "tool" && "time" in existing.state && existing.state.time
      ? existing.state.time.start
      : data.timestamp
  const part = (() => {
    if (type === "session.next.tool.input.started") {
      if (existing?.type === "tool") return existing
      return { ...base, state: { status: "pending" as const, input: {}, raw: "" } }
    }
    if (type === "session.next.tool.input.ended") {
      const raw = pendingRaw!.startsWith(inputText!) ? pendingRaw! : inputText!
      return { ...base, state: { status: "pending" as const, input: {}, raw } }
    }
    if (type === "session.next.tool.called" || type === "session.next.tool.progress")
      return {
        ...base,
        state: {
          status: "running" as const,
          input: record(data.input) ?? currentInput,
          title: tool,
          metadata: toolMetadata(tool, record(data.structured), record(record(data.provider)?.metadata)),
          time: { start: currentStart },
        },
      }
    if (type === "session.next.tool.success")
      return {
        ...base,
        state: {
          status: "completed" as const,
          input: currentInput,
          output: toolOutput(data.content),
          title: tool,
          metadata: toolMetadata(tool, record(data.structured), record(record(data.provider)?.metadata)),
          time: { start: currentStart, end: data.timestamp },
        },
      }
    const error = record(data.error)
    return {
      ...base,
      state: {
        status: "error" as const,
        input: currentInput,
        error: typeof error?.message === "string" ? error.message : "Unknown error",
        metadata: toolMetadata(tool, undefined, {
          ...(existingState && "metadata" in existingState ? existingState.metadata : {}),
          ...record(record(data.provider)?.metadata),
        }),
        time: { start: currentStart, end: data.timestamp },
      },
    }
  })() as Part
  remember(evidence, evidenceKey, incoming)
  return { kind: "part", sessionID, messageID: data.assistantMessageID, part }
}

function compareToolEvidence(incoming: ToolEvidence, current: ToolEvidence | undefined) {
  if (!current) return 1
  const incomingTerminal = incoming.status === "completed" || incoming.status === "error"
  const currentTerminal = current.status === "completed" || current.status === "error"
  if (incomingTerminal !== currentTerminal) return incomingTerminal ? 1 : -1
  const ordered = compareEvidence(incoming, current)
  if (ordered !== 0) return ordered
  if (incoming.status === current.status) return 0
  return incoming.status === "running" ? 1 : -1
}

function compareEvidence(incoming: EventEvidence, current: EventEvidence) {
  if (incoming.timestamp !== current.timestamp) return incoming.timestamp - current.timestamp
  // Core event IDs are ascending, so they are the durable sequence tie-breaker when timestamps collide.
  if (incoming.eventID && current.eventID && incoming.eventID !== current.eventID) {
    return incoming.eventID > current.eventID ? 1 : -1
  }
  return 0
}

function remember<T>(evidence: Map<string, T>, key: string, value: T) {
  evidence.set(key, value)
  if (evidence.size > 4096) evidence.delete(evidence.keys().next().value!)
}

function findMessage(store: Store, sessionID: string, messageID: string) {
  return store.message[sessionID]?.find((message) => message.id === messageID)
}

function findPart(store: Store, messageID: string, partID: string) {
  return store.part[messageID]?.find((part) => part.id === partID)
}

function toolOutput(value: unknown) {
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => {
      const content = record(item)
      if (!content) return ""
      if (content.type === "text" && typeof content.text === "string") return content.text
      if (typeof content.mime !== "string") return ""
      const name =
        typeof content.name === "string" ? content.name : typeof content.uri === "string" ? content.uri : "attachment"
      return `[${content.mime}: ${name}]`
    })
    .filter(Boolean)
    .join("\n")
}

function toolMetadata(tool: string, structured?: Record<string, unknown>, metadata?: Record<string, unknown>) {
  if (tool !== "task" || !structured) return toolDetailsMetadata(tool, structured, metadata)
  return {
    ...metadata,
    ...(typeof structured.task_id === "string" && structured.task_id ? { task_id: structured.task_id } : {}),
    ...(typeof structured.sessionID === "string" && structured.sessionID ? { sessionID: structured.sessionID } : {}),
    ...(typeof structured.background === "boolean" ? { background: structured.background } : {}),
    ...(structured.state === "running" ||
    structured.state === "completed" ||
    structured.state === "error" ||
    structured.state === "cancelled"
      ? { state: structured.state }
      : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function number(value: unknown) {
  return typeof value === "number" ? value : 0
}
