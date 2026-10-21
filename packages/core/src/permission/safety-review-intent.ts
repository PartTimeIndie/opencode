export * as PermissionSafetyReviewIntent from "./safety-review-intent"

export const MAX_ENVELOPE_CHARS = 32_000
export const MAX_RECENT_MESSAGES = 10

const MAX_ANCHOR_CHARS = 12_000
const MAX_RECENT_CHARS = 15_000
const MAX_RECENT_MESSAGE_CHARS = 4_000
const MAX_PLAN_CHARS = 10_000
const MAX_ATTACHMENTS = 4
const TRUNCATED = "\n...[truncated]...\n"

export type Attachment = {
  readonly name?: string
  readonly mime: string
  readonly reference?: string
  readonly description?: string
}

export type Message = {
  readonly role: "user" | "assistant"
  readonly messageID?: string
  readonly text: string
  readonly attachments?: ReadonlyArray<Attachment>
}

export type Plan = {
  readonly revision: number
  readonly markdown: string
}

export type Envelope = {
  readonly anchor: {
    readonly role: "user"
    readonly messageID?: string
    readonly text: string
    readonly attachments?: ReadonlyArray<Attachment>
  }
  readonly recent: ReadonlyArray<{
    readonly role: "user" | "assistant"
    readonly messageID?: string
    readonly text: string
  }>
  readonly plan?: {
    readonly revision: number
    readonly markdown: string
    readonly authority: "context_only"
  }
  readonly truncated: boolean
}

export function planFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  const value = metadata?.["opencode.plan_document"]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const plan = value as Record<string, unknown>
  if (typeof plan.markdown !== "string") return
  if (typeof plan.revision !== "number" || !Number.isSafeInteger(plan.revision) || plan.revision < 0) return
  return { markdown: plan.markdown, revision: plan.revision } satisfies Plan
}

export function build(input: {
  readonly messages: ReadonlyArray<Message>
  readonly anchorBeforeMessageID?: string
  readonly plan?: Plan
}) {
  const boundary = input.anchorBeforeMessageID
    ? input.messages.findIndex((message) => message.messageID === input.anchorBeforeMessageID)
    : input.messages.length
  if (boundary === -1) return
  const scoped = input.messages.slice(0, boundary)
  const anchorIndex = scoped.findLastIndex((message) => message.role === "user")
  if (anchorIndex === -1) return

  const originalAnchor = scoped[anchorIndex]
  const attachments = originalAnchor.attachments?.slice(0, MAX_ATTACHMENTS).map(boundAttachment)
  const attachmentChars = attachments?.reduce((total, attachment) => total + attachmentLength(attachment), 0) ?? 0
  const anchorText = truncate(originalAnchor.text.trim(), Math.max(0, MAX_ANCHOR_CHARS - attachmentChars))
  if (!anchorText.value && !attachments?.length) return

  const recentCandidates = scoped
    .slice(0, anchorIndex)
    .filter((message) => message.text.trim())
    .slice(-MAX_RECENT_MESSAGES)
  const recent = recentCandidates.toReversed().reduce(
    (state, message) => {
      if (state.remaining <= 0) return { ...state, truncated: true }
      const text = truncate(message.text.trim(), Math.min(state.remaining, MAX_RECENT_MESSAGE_CHARS))
      return {
        remaining: state.remaining - text.value.length,
        messages: [{ role: message.role, messageID: message.messageID, text: text.value }, ...state.messages],
        truncated: state.truncated || text.truncated,
      }
    },
    { remaining: MAX_RECENT_CHARS, messages: [] as Envelope["recent"], truncated: false },
  )
  const used = anchorText.value.length + attachmentChars + (MAX_RECENT_CHARS - recent.remaining)
  const plan = input.plan
    ? truncate(input.plan.markdown.trim(), Math.min(MAX_PLAN_CHARS, Math.max(0, MAX_ENVELOPE_CHARS - used)))
    : undefined
  return {
    anchor: {
      role: "user" as const,
      messageID: originalAnchor.messageID,
      text: anchorText.value,
      ...(attachments?.length ? { attachments } : {}),
    },
    recent: recent.messages,
    ...(input.plan && plan?.value
      ? { plan: { revision: input.plan.revision, markdown: plan.value, authority: "context_only" as const } }
      : {}),
    truncated:
      anchorText.truncated ||
      recent.truncated ||
      recentCandidates.length < scoped.slice(0, anchorIndex).filter((message) => message.text.trim()).length ||
      (input.plan !== undefined && (plan?.truncated === true || !plan?.value)) ||
      (originalAnchor.attachments?.length ?? 0) > MAX_ATTACHMENTS,
  } satisfies Envelope
}

export function explain(intent: Envelope, tool?: { readonly name: string; readonly input: unknown }) {
  const input = tool?.input
  const description = input && typeof input === "object" && "description" in input ? input.description : undefined
  const path = input && typeof input === "object" && "path" in input ? input.path : undefined
  const action = typeof description === "string" && description.trim()
    ? description.trim()
    : typeof path === "string" && path.trim() && (tool?.name === "edit" || tool?.name === "write")
      ? `${tool.name === "edit" ? "Replace matching text in" : "Write"} ${path.trim()}`
      : undefined
  return {
    goal: intent.anchor.text ? truncate(intent.anchor.text, 320).value : undefined,
    action: action ? truncate(action, 320).value : undefined,
  }
}

function truncate(value: string, maximum: number) {
  if (value.length <= maximum) return { value, truncated: false }
  if (maximum <= TRUNCATED.length) return { value: value.slice(0, maximum), truncated: true }
  const available = maximum - TRUNCATED.length
  const head = Math.ceil(available * 0.7)
  return { value: value.slice(0, head) + TRUNCATED + value.slice(value.length - (available - head)), truncated: true }
}

function boundAttachment(attachment: Attachment) {
  return {
    ...(attachment.name ? { name: truncate(attachment.name, 256).value } : {}),
    mime: truncate(attachment.mime, 128).value,
    ...(attachment.reference && !attachment.reference.startsWith("data:")
      ? { reference: truncate(attachment.reference.split(/[?#]/, 1)[0] ?? "", 512).value }
      : {}),
    ...(attachment.description ? { description: truncate(attachment.description, 512).value } : {}),
  }
}

function attachmentLength(attachment: Attachment) {
  return (
    (attachment.name?.length ?? 0) +
    attachment.mime.length +
    (attachment.reference?.length ?? 0) +
    (attachment.description?.length ?? 0)
  )
}
