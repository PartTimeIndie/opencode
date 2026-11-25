import { getFilename } from "@opencode-ai/core/util/path"
import {
  type FilePartSource,
  type Part,
  type PromptAgentAttachment,
  type PromptFileAttachment,
} from "@opencode-ai/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { formatCommentNote } from "@/utils/comment-note"

type PromptRequestPart =
  | {
      id: string
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
      time?: Extract<Part, { type: "text" }>["time"]
      metadata?: Record<string, unknown>
    }
  | {
      id: string
      type: "file"
      mime: string
      filename?: string
      url: string
      source?: FilePartSource
      unpack?: boolean
    }
  | {
      id: string
      type: "agent"
      name: string
      source?: {
        value: string
        start: number
        end: number
      }
    }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  requestText?: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"

export function imageAttachmentUrl(attachment: ImageAttachmentPart) {
  if (attachment.annotation) throw new Error("Annotation must be resolved before sending")
  if (attachment.sourcePath) return `file://${encodeFilePath(attachment.sourcePath)}`
  return attachment.dataUrl
}

export function imageAttachmentRequestPart(attachment: ImageAttachmentPart, id = Identifier.ascending("part")) {
  const url = imageAttachmentUrl(attachment)
  if (!url) return
  return {
    id,
    type: "file",
    mime: attachment.mime,
    url,
    filename: attachment.sourcePath ?? attachment.filename,
    ...(attachment.unpack ? { unpack: true } : {}),
  } satisfies PromptRequestPart
}

export function imageAttachmentPromptFile(attachment: ImageAttachmentPart): PromptFileAttachment | undefined {
  const uri = imageAttachmentUrl(attachment)
  if (!uri) return
  return {
    uri,
    mime: attachment.mime,
    name: attachment.sourcePath ?? attachment.filename,
    ...(attachment.unpack ? { unpack: true } : {}),
  }
}

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: input.requestText ?? input.text,
    },
  ]

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: getFilename(attachment.path),
      source: {
        type: "file",
        text: {
          value: attachment.content,
          start: attachment.start,
          end: attachment.end,
        },
        path,
      },
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = `file://${encodeFilePath(absolute(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(path),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const images = input.images.flatMap((attachment) => {
    const part = imageAttachmentRequestPart(attachment)
    return part ? [part] : []
  })

  requestParts.push(...files, ...context, ...agents, ...images)

  const promptText = requestParts
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n")
  const promptFiles = requestParts.flatMap((part): PromptFileAttachment[] => {
    if (part.type !== "file") return []
    return [
      {
        uri: part.url,
        mime: part.mime,
        name: part.filename,
        ...(part.unpack ? { unpack: true } : {}),
        ...(part.source
          ? {
              source: {
                text: part.source.text.value,
                start: part.source.text.start,
                end: part.source.text.end,
              },
            }
          : {}),
      },
    ]
  })
  const promptAgents = requestParts.flatMap((part): PromptAgentAttachment[] => {
    if (part.type !== "agent") return []
    return [
      {
        name: part.name,
        ...(part.source
          ? {
              source: {
                text: part.source.value,
                start: part.source.start,
                end: part.source.end,
              },
            }
          : {}),
      },
    ]
  })

  return {
    requestParts,
    requestPrompt: {
      text: promptText,
      ...(promptFiles.length ? { files: promptFiles } : {}),
      ...(promptAgents.length ? { agents: promptAgents } : {}),
    },
    optimisticParts: requestParts.map((part, index) =>
      toOptimisticPart(
        index === 0 && part.type === "text" && input.requestText !== undefined ? { ...part, text: input.text } : part,
        input.sessionID,
        input.messageID,
      ),
    ),
  }
}
