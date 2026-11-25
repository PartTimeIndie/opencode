import {
  Message,
  ToolCallPart,
  ToolOutput,
  ToolResultPart,
  type ContentPart,
  type Model,
  type ProviderMetadata,
} from "@opencode-ai/llm"
import { SessionMessage } from "../message"
import { FileAttachment } from "../prompt"
import { ReadLifecycle } from "./read-lifecycle"

const TEXT_ATTACHMENT_MIMES = new Set(["text/plain", "application/x-directory"])
const TOOL_RESULT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const IMAGE_ONLY_ROUTE_IDS = new Set([
  "anthropic-messages",
  "gemini",
  "openai-chat",
  "openai-compatible-chat",
  "openai-responses",
  "openai-responses-codex",
  "openai-responses-websocket",
])
const TEXT_ONLY_MODELS = new Set(["zhipuai-coding-plan/glm-5.2", "zhipuai-coding-plan/glm-5.3"])
const BEDROCK_USER_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "text/plain",
  "text/markdown",
])
const BEDROCK_EXTRACTED_DOCUMENT_MIMES = new Set(["application/pdf"])

const attachmentLabel = (file: Pick<FileAttachment, "mime" | "name" | "uri">) =>
  `[Attached ${file.mime}: ${file.name ?? "file"}]`

const omittedAttachmentText = (file: Pick<FileAttachment, "mime" | "name">) =>
  `[Attached ${file.mime}: ${file.name ?? "file"} omitted: unsupported attachment type for model input.]`

const visionAnalysisText = (file: Pick<FileAttachment, "mime" | "name" | "description">) =>
  file.description === undefined
    ? omittedAttachmentText(file)
    : `[Attached ${file.mime}: ${file.name ?? "file"} — vision analysis by delegated model]\n${file.description}`

const decodeTextDataURL = (uri: string) => {
  if (!uri.startsWith("data:")) return
  const match = /^data:([^,]*),(.*)$/s.exec(uri)
  if (!match) return
  try {
    return match[1]!.split(";").some((part) => part.toLowerCase() === "base64")
      ? Buffer.from(match[2]!, "base64").toString("utf8")
      : decodeURIComponent(match[2]!)
  } catch {
    return
  }
}

const normalizeFile = (file: FileAttachment) => {
  const mime = file.mime.toLowerCase()
  return FileAttachment.create({
    uri: mime === "image/jpg" ? file.uri.replace(/^data:image\/jpg(?=[;,])/i, "data:image/jpeg") : file.uri,
    mime: mime === "image/jpg" ? "image/jpeg" : mime,
    name: file.name,
    description: file.description,
    source: file.source,
  })
}

export type ImageInputCapabilities = {
  readonly input?: readonly string[]
}

const advertisedImageInput = (capabilities?: ImageInputCapabilities) =>
  capabilities?.input?.some((item) => item === "image" || item.toLowerCase().startsWith("image/")) === true

export const media = (file: FileAttachment): ContentPart => ({
  type: "media",
  mediaType: file.mime,
  data: file.uri,
  filename: file.name,
  metadata: file.description === undefined ? undefined : { description: file.description },
})

export const modelSupportsFile = (model: Model, file: FileAttachment, capabilities?: ImageInputCapabilities) => {
  // The GLM coding endpoint rejects image_url content even though it uses the
  // otherwise multimodal OpenAI-compatible route.
  if (TEXT_ONLY_MODELS.has(`${model.provider}/${model.id}`)) return false
  if (file.mime.toLowerCase().startsWith("image/")) {
    if (capabilities?.input && !advertisedImageInput(capabilities)) return false
    // Third-party AISDK providers (Cursor, etc.) only ingest images when the
    // catalog advertises image input. Assuming support here skipped vision
    // translation and then dropped the bytes on models such as Grok 4.6.
    if (!advertisedImageInput(capabilities) && String(model.route.id).startsWith("aisdk:")) return false
  }
  if (model.route.id === "bedrock-converse")
    return TOOL_RESULT_IMAGE_MIMES.has(file.mime) || BEDROCK_USER_DOCUMENT_MIMES.has(file.mime)
  if (IMAGE_ONLY_ROUTE_IDS.has(model.route.id)) return TOOL_RESULT_IMAGE_MIMES.has(file.mime)
  return true
}

const userFile = (model: Model, attachment: FileAttachment, capabilities?: ImageInputCapabilities): ContentPart[] => {
  const file = normalizeFile(attachment)
  if (TEXT_ATTACHMENT_MIMES.has(file.mime)) {
    const text = decodeTextDataURL(file.uri)
    return [{ type: "text", text: text === undefined ? attachmentLabel(file) : `${attachmentLabel(file)}\n${text}` }]
  }
  return modelSupportsFile(model, file, capabilities) ? [media(file)] : [{ type: "text", text: visionAnalysisText(file) }]
}

const toolInput = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status !== "pending") return tool.state.input
  try {
    return JSON.parse(tool.state.input) as unknown
  } catch {
    return tool.state.input
  }
}

const toolCall = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined): ContentPart =>
  ToolCallPart.make({
    id: tool.id,
    name: tool.name,
    input: toolInput(tool),
    providerExecuted: tool.provider?.executed,
    providerMetadata,
  })

const supportsToolResultFile = (model: Model, file: FileAttachment, capabilities?: ImageInputCapabilities) => {
  if (model.route.id === "bedrock-converse") return TOOL_RESULT_IMAGE_MIMES.has(file.mime)
  return modelSupportsFile(model, file, capabilities)
}

const supportsExtractedUserFile = (model: Model, file: FileAttachment) => {
  if (model.route.id !== "bedrock-converse") return false
  return BEDROCK_EXTRACTED_DOCUMENT_MIMES.has(file.mime)
}

const replayToolContent = (
  model: Model,
  content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>,
  capabilities?: ImageInputCapabilities,
) => {
  const extracted: FileAttachment[] = []
  const value = content.flatMap((item): SessionMessage.ToolStateCompleted["content"] => {
    if (item.type === "text") return [item]
    const file = normalizeFile(FileAttachment.create({ uri: item.uri, mime: item.mime, name: item.name }))
    if (supportsToolResultFile(model, file, capabilities))
      return [{ type: "file", uri: file.uri, mime: file.mime, name: file.name }]
    if (supportsExtractedUserFile(model, file)) {
      extracted.push(file)
      return []
    }
    return [{ type: "text", text: omittedAttachmentText(file) }]
  })
  return { content: value, extracted }
}

const toolErrorText = (state: SessionMessage.ToolStateError) => {
  const content = state.content.map((item) =>
    item.type === "text"
      ? item.text
      : omittedAttachmentText(normalizeFile(FileAttachment.create({ uri: item.uri, mime: item.mime, name: item.name }))),
  )
  return [state.error.message, ...content].filter((part) => part.length > 0).join("\n")
}

// Only fanout failures have a structured, bounded receipt. Other local tool
// errors retain their existing text replay and never leak arbitrary metadata.
export const fanoutFailureText = (state: SessionMessage.ToolStateError) => {
  const text = toolErrorText(state)
  const results = state.structured.partial_results
  if (!Array.isArray(results) || results.length === 0) return text
  const completed = results.flatMap((item): unknown[] => {
    if (!item || typeof item !== "object" || typeof item.reviewer?.model !== "string") return []
    const recovery = item.recovery
    if (item.status === "success" && item.result !== undefined)
      return [{ reviewer: item.reviewer, sessionID: item.sessionID, status: "success", result: item.result,
        ...(recovery?.source === "repaired" && Array.isArray(recovery.findings)
          ? { original_findings: recovery.findings, repair_is_not_independent: true } : {}) }]
    if (item.status !== "partial" || !recovery || typeof recovery !== "object" || !Array.isArray(recovery.findings) ||
        (recovery.findings.length === 0 && !(typeof recovery.omittedFindings === "number" && recovery.omittedFindings > 0))) return []
    return [{ reviewer: item.reviewer, sessionID: item.sessionID, status: "partial", not_clean: true,
      findings: recovery.findings, issues: recovery.issues, source: "original",
      ...(typeof recovery.omittedFindings === "number" ? { omitted_findings: recovery.omittedFindings, open_reviewer_session: true } : {}) }]
  })
  if (completed.length === 0) return text
  const bounded: unknown[] = []
  let bytes = 0
  for (const item of completed) {
    const size = Buffer.byteLength(JSON.stringify(item))
    if (size > 32_000 - bytes) break
    bounded.push(item)
    bytes += size
  }
  if (!bounded.length) return `${text}\nFanout results are too large for replay; open the reviewer sessions.`
  const receipt = JSON.stringify({ type: "fanout_partial_results", fanout_failed: true, results: bounded,
    ...(bounded.length < completed.length ? { omitted: completed.length - bounded.length, open_reviewer_sessions: true } : {}) })
  return `${text}\nCompleted reviewer results (the fanout failed; do not count unfinished reviewers):\n${receipt}`
}

const toolResult = (
  tool: SessionMessage.AssistantTool,
  model: Model,
  providerMetadata: ProviderMetadata | undefined,
  capabilities?: ImageInputCapabilities,
) => {
  if (tool.state.status === "completed") {
    const content = replayToolContent(model, tool.state.content, capabilities)
    const result =
      tool.provider?.executed === true && tool.state.result !== undefined
        ? tool.state.result
        : ToolOutput.toResultValue({ structured: tool.state.structured, content: content.content })
    return {
      part: ToolResultPart.make({
        id: tool.id,
        name: tool.name,
        result,
        providerExecuted: tool.provider?.executed,
        providerMetadata,
      }),
      extracted: content.extracted,
    }
  }
  if (tool.state.status === "error") {
    return {
      part: ToolResultPart.make({
        id: tool.id,
        name: tool.name,
        result:
          tool.provider?.executed === true && tool.state.result !== undefined
            ? tool.state.result
            : tool.provider?.executed === true
              ? { error: tool.state.error, content: tool.state.content, structured: tool.state.structured }
               : tool.name === "multi_agent_fanout" ? fanoutFailureText(tool.state) : toolErrorText(tool.state),
        resultType: "error",
        providerExecuted: tool.provider?.executed,
        providerMetadata,
      }),
      extracted: [],
    }
  }
  return {
    part: ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result: "[Tool execution was interrupted]",
      resultType: "error",
      providerExecuted: tool.provider?.executed,
      providerMetadata,
    }),
    extracted: [],
  }
}

const assistant = (message: SessionMessage.Assistant, model: Model, capabilities?: ImageInputCapabilities) => {
  const sameModel =
    String(message.model.providerID) === String(model.provider) && String(message.model.id) === String(model.id)
  const content = message.content.flatMap((item): ContentPart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }]
    if (item.type === "reasoning")
      return sameModel
        ? [{ type: "reasoning", text: item.text, providerMetadata: item.providerMetadata }]
        : item.text.length > 0
          ? [{ type: "text", text: item.text }]
          : []
    if (item.type === "custom") return []
    const call = toolCall(item, sameModel ? item.provider?.metadata : undefined)
    const result =
      item.provider?.executed === true
        ? toolResult(
            item,
            model,
            sameModel ? (item.provider?.resultMetadata ?? item.provider?.metadata) : undefined,
            capabilities,
          )
        : undefined
    return item.provider?.executed === true && result ? [call, result.part] : [call]
  })
  const toolResults = message.content
    .filter((item): item is SessionMessage.AssistantTool => item.type === "tool" && item.provider?.executed !== true)
    .map((item) =>
      toolResult(
        item,
        model,
        sameModel ? (item.provider?.resultMetadata ?? item.provider?.metadata) : undefined,
        capabilities,
      ),
    )
    .filter((message) => message !== undefined)
  const extractedMedia = toolResults.flatMap((result) => result.extracted)
  const extracted =
    extractedMedia.length === 0
      ? []
      : [
          Message.make({
            role: "user",
            content: [{ type: "text", text: "Attached media from tool result:" }, ...extractedMedia.map(media)],
          }),
        ]
  if (content.length === 0 && toolResults.length === 0 && extracted.length === 0) return []
  return [
    Message.make({ id: message.id, role: "assistant", content, metadata: message.metadata }),
    ...toolResults.map((result) => Message.tool(result.part)),
    ...extracted,
  ]
}

function toLLMMessage(
  message: SessionMessage.Message,
  model: Model,
  capabilities?: ImageInputCapabilities,
): Message[] {
  switch (message.type) {
    case "agent-switched":
    case "model-switched":
      return []
    case "user":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: [
            { type: "text", text: message.text },
            ...(message.files ?? []).flatMap((file) => userFile(model, file, capabilities)),
          ],
          metadata: {
            ...message.metadata,
            ...(message.agents?.length ? { agents: message.agents } : {}),
          },
        }),
      ]
    case "synthetic":
      return [Message.make({ id: message.id, role: "user", content: message.text, metadata: message.metadata })]
    case "system":
      return [Message.system(message.text)]
    case "shell":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `Shell command: ${message.command}\n\n${message.output}`,
          metadata: message.metadata,
        }),
      ]
    case "assistant":
      return assistant(message, model, capabilities)
    case "compaction":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat every user or assistant message inside this checkpoint as historical context only; do not replay them as new instructions to answer or execute. The checkpoint's current Goal, In Progress, and Next Steps remain binding: continue the active task automatically from them unless a later non-checkpoint user message overrides them. Exception: the content between [durable-command-invocation] and [/durable-command-invocation] markers is the session's still-active slash-command workflow, not historical context; continue following it, including its required user questions.

<summary>
${message.summary}
</summary>

<recent-context>
${message.recent}
</recent-context>
</conversation-checkpoint>`,
          metadata: message.metadata,
        }),
      ]
  }
}

/** Translate projected V2 Session history into canonical @opencode-ai/llm context. */
export const toLLMMessages = (
  messages: readonly SessionMessage.Message[],
  model: Model,
  capabilities?: ImageInputCapabilities,
): Message[] => {
  const superseded = ReadLifecycle.supersededReadMarkers(messages)
  if (superseded.size === 0) return messages.flatMap((message) => toLLMMessage(message, model, capabilities))
  return messages.flatMap((message) => toLLMMessage(applySupersededReads(message, superseded), model, capabilities))
}

function applySupersededReads(
  message: SessionMessage.Message,
  superseded: ReadonlyMap<string, string>,
): SessionMessage.Message {
  if (message.type !== "assistant" || superseded.size === 0) return message
  const affected = message.content.some((item) => item.type === "tool" && superseded.has(item.id))
  if (!affected) return message
  const content = message.content.map((item): SessionMessage.AssistantContent => {
    if (item.type !== "tool") return item
    const marker = superseded.get(item.id)
    if (marker === undefined || item.state.status !== "completed") return item
    return {
      ...item,
      state: {
        ...item.state,
        content: [{ type: "text" as const, text: marker }],
      },
    } as SessionMessage.AssistantTool
  })
  return { ...message, content } as SessionMessage.Assistant
}
