import type { SurfaceBlockingRequest } from "@opencode-ai/sdk/v2"
import type { DockArea } from "@/context/layout-dock"
import type { ImageAttachmentPart } from "@/context/prompt"
import type { ExplorableSection, ExplorableVariant } from "@/components/explorable-review"
import type { SurfaceAction, SurfaceEffect } from "@/components/control-surface-runtime"

export type QuestionControlType =
  | "pick_one"
  | "pick_many"
  | "confirm"
  | "rank"
  | "rate"
  | "ask_text"
  | "ask_image"
  | "ask_file"
  | "ask_code"
  | "show_diff"
  | "show_plan"
  | "show_options"
  | "review_section"
  | "thumbs"
  | "emoji_react"
  | "slider"
  | "accordion"
  | "details"
  | "tabs"
  | "object_tree"
  | "table"
  | "form"

export type QuestionOption = {
  id?: string
  label: string
  description?: string
  tooltip?: string
  pros?: string[]
  cons?: string[]
  details?: unknown
  finalizeRemaining?: boolean
}

export type QuestionMarkdownBlock = {
  id: string
  type: "markdown"
  content: string
}

export type QuestionActionLinkBlock = {
  id: string
  type: "action_link"
  label: string
  href: string
  description?: string
}

export type QuestionMediaItem = {
  id: string
  label: string
  mediaType: "image" | "audio" | "video" | "file"
  src: string
  description?: string
  defaultChecked?: boolean
}

export type QuestionMediaChecklistBlock = {
  id: string
  type: "media_checklist"
  label?: string
  description?: string
  items: QuestionMediaItem[]
}

export type QuestionBodyBlock = QuestionMarkdownBlock | QuestionActionLinkBlock | QuestionMediaChecklistBlock

export type QuestionV2Info = SurfaceBlockingRequest["questions"][number] & {
  type?: QuestionControlType
  context?: string
  options?: QuestionOption[]
  recommended?: string
  recommendedOptions?: string[]
  allowOther?: boolean
  allowFeedback?: boolean
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  minLength?: number
  maxLength?: number
  placeholder?: string
  language?: string
  content?: string
  markdown?: string
  sections?: ExplorableSection[]
  before?: string
  after?: string
  filePath?: string
  emojis?: string[]
  form?: QuestionFormSpec
  body?: QuestionBodyBlock[]
}

export type QuestionDetailReview = {
  level: "question" | "option"
  title: string
  markdown?: string
  content?: string
  sections?: ExplorableSection[]
  variant: ExplorableVariant
  source: "context" | "review"
}

export type QuestionDetailTarget =
  | { type: "question" }
  | {
      type: "option"
      key: string
    }

export type QuestionFormRangeValue = {
  start?: number
  end?: number
}

export type QuestionFormValue = string | string[] | boolean | number | QuestionFormRangeValue

export type QuestionFormFieldType =
  | "text"
  | "email"
  | "number"
  | "number_range"
  | "duration_range"
  | "textarea"
  | "rich_text"
  | "recipient_list"
  | "attachment_list"
  | "file_picker"
  | "folder_picker"
  | "image_preview"
  | "video_preview"
  | "checkbox"
  | "select"
  | "button"
  | "display"
  | "hidden"

export type QuestionFormRichTextAction = "bold" | "italic" | "underline" | "link" | "bullet_list" | "numbered_list"
export type QuestionFormNumber = number | "NaN" | "Infinity" | "-Infinity"

export type QuestionFormAutocomplete = {
  provider: "gmail-recipients"
  minLength?: QuestionFormNumber
}

export type QuestionFormSuggestion = {
  email: string
  name?: string
  count?: number
  lastSeen?: number
}

export type QuestionFormSuggestionState = {
  query: string
  items: QuestionFormSuggestion[]
  active: number
  loading: boolean
}

export type QuestionFormField = {
  id: string
  type: QuestionFormFieldType
  label?: string
  description?: string
  tooltip?: string
  placeholder?: string
  required?: boolean
  defaultValue?: unknown
  value?: unknown
  rows?: QuestionFormNumber
  min?: QuestionFormNumber
  max?: QuestionFormNumber
  step?: QuestionFormNumber
  minLength?: QuestionFormNumber
  maxLength?: QuestionFormNumber
  src?: string
  poster?: string
  startLabel?: string
  endLabel?: string
  options?: QuestionOption[]
  toolbar?: QuestionFormRichTextAction[]
  accept?: string
  multiple?: boolean
  autocomplete?: QuestionFormAutocomplete
}

export type QuestionFormLayoutNode = {
  id?: string
  type: "hstack" | "vstack" | "field" | "text" | "review"
  field?: string
  when?: { field: string; equals: string }
  text?: string
  markdown?: string
  content?: string
  sections?: ExplorableSection[]
  variant?: ExplorableVariant
  title?: string
  tooltip?: string
  width?: string
  height?: string
  gap?: string
  children?: QuestionFormLayoutNode[]
}

export type QuestionFormSpec = {
  version: 1
  id?: string
  title?: string
  description?: string
  tooltip?: string
  fields: QuestionFormField[]
  layout?: QuestionFormLayoutNode
  submitLabel?: string
  effects?: SurfaceEffect[]
  actions?: SurfaceAction[]
}

export type QuestionDockActions = {
  currentArea?: DockArea
  pinned?: boolean
  onDock: (area: DockArea) => void
  onUnpin?: () => void
}

export type QuestionImageAttachmentPart = ImageAttachmentPart & { url?: string }
export type QuestionAttachmentMap = Record<string, QuestionImageAttachmentPart[]>

export const questionDockAreas = ["top", "left", "middle", "right", "bottom"] as const
export const defaultRichTextToolbar: QuestionFormRichTextAction[] = [
  "bold",
  "italic",
  "underline",
  "link",
  "bullet_list",
  "numbered_list",
]

export function finalizeRemainingOption(options: QuestionOption[] | undefined) {
  return (options ?? []).find((option) => option.finalizeRemaining === true)
}

// Computes which option each still-open question receives when the user clicks the
// request-wide finalize button. Already answered questions and questions without
// their own finalize option keep their current state.
export function finalizeRemainingOverlay(questions: ReadonlyArray<{ options?: QuestionOption[]; answered: boolean }>) {
  return questions.map(({ options, answered }) => (answered ? undefined : finalizeRemainingOption(options)))
}
