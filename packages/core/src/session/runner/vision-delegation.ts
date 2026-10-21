export * as VisionDelegation from "./vision-delegation"

import type { Model } from "@opencode-ai/llm"
import { ModelV2 } from "../../model"
import { ConfigVision } from "../../config/vision"
import { FileAttachment } from "../prompt"
import { SessionMessage } from "../message"
import { modelSupportsFile, type ImageInputCapabilities } from "./to-llm-message"

/** Session `metadata` column key holding the durable vision-analysis sidecar. */
export const SIDECAR_KEY = "vision_analysis"

export type PendingImage = {
  message: SessionMessage.User
  fileIndex: number
  file: FileAttachment
  userText: string
}

export type Candidate = { model: string; variant?: string }

export type AnalysisMap = Record<string, string>

const isImageMime = (mime: string) => mime.toLowerCase().startsWith("image/")

/** User-attached images the target model cannot ingest and that have no analysis yet. */
export const pendingImages = (
  messages: readonly SessionMessage.Message[],
  model: Model,
  capabilities?: ImageInputCapabilities,
): PendingImage[] =>
  messages.flatMap((message) => {
    if (message.type !== "user" || !message.files?.length) return []
    return message.files
      .map((file, fileIndex) => ({ message, fileIndex, file, userText: message.text }))
      .filter(
        ({ file }) =>
          isImageMime(file.mime) && !modelSupportsFile(model, file, capabilities) && file.description === undefined,
      )
  })

export const resolveTemplate = (vision: ConfigVision.Info | undefined) =>
  vision?.prompt_template ?? ConfigVision.DEFAULT_PROMPT_TEMPLATE

export const buildPrompt = (template: string, userText: string, fileName: string | undefined) =>
  template.replaceAll("{{user_message}}", userText).replaceAll("{{image_name}}", fileName ?? "image")

const toCandidate = (ref: { model: string; variant?: string }): Candidate =>
  ref.variant ? { model: ref.model, variant: ref.variant } : { model: ref.model }

/** Primary followed by ordered fallbacks. Empty when no primary is configured. */
export const candidates = (vision: ConfigVision.Info | undefined): Candidate[] => {
  if (!vision?.primary) return []
  return [toCandidate({ model: vision.primary.model, variant: vision.primary.variant }), ...(vision.fallbacks ?? []).map(toCandidate)]
}

export const visionRef = (candidate: Candidate): ModelV2.Ref => {
  const parsed = ModelV2.parse(candidate.model)
  const ref: ModelV2.Ref = { id: parsed.modelID, providerID: parsed.providerID }
  return candidate.variant ? { ...ref, variant: ModelV2.VariantID.make(candidate.variant) } : ref
}

/** Return a new message list with the analysis written onto the attachment's `description`. */
export const withAnalysis = (
  messages: readonly SessionMessage.Message[],
  messageID: string,
  fileIndex: number,
  analysis: string,
): readonly SessionMessage.Message[] =>
  messages.map((message) => {
    if (message.id !== messageID || message.type !== "user" || !message.files) return message
    return new SessionMessage.User({
      ...message,
      files: message.files.map((file, index) =>
        index === fileIndex ? FileAttachment.create({ ...file, description: analysis }) : file,
      ),
    })
  })

export const sidecarKey = (messageID: string, fileIndex: number) => `${messageID}:${fileIndex}`

export const decodeAnalyses = (raw: unknown): AnalysisMap => {
  if (typeof raw !== "object" || raw === null) return {}
  const entries = Object.entries(raw as Record<string, unknown>).filter(([, value]) => typeof value === "string")
  return Object.fromEntries(entries) as AnalysisMap
}
