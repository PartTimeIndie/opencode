import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { fullscreenCloseButtonRight, shouldCloseVideoFullscreenOnEscape } from "./session-question-video"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@/utils/toast"
import type { QuestionV2Answer, QuestionV2AnswerFile, SurfaceBlockingRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { pickQuestionFolders, questionFolderValues } from "./session-question-folder-picker"
import { useServerSync } from "@/context/server-sync"
import { markQuestionChanged } from "@/context/global-sync/question-revision"
import {
  beginQuestionSettlement,
  isQuestionConflictError,
  isSurfaceRequestSettled,
  loadPendingQuestions,
  questionRequestErrorMessage,
  reconcileSurfaceRequest,
  rejectQuestion,
  replyQuestion,
  trackQuestionRejectSettlement,
  type PendingQuestionsSnapshot,
  type QuestionSettlement,
} from "@/context/question-request"
import { authTokenFromCredentials } from "@/utils/server"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useServerSDK } from "@/context/server-sdk"
import { ScopedKey } from "@/utils/server-scope"

import { attachmentMime } from "@/components/prompt-input/files"
import { imageAttachmentRequestPart } from "@/components/prompt-input/build-request-parts"
import { OnDemandExpectation } from "@/components/on-demand-surface"
import { ExplorableReview, type ExplorableSection, type ExplorableVariant } from "@/components/explorable-review"
import { OnDemandDiff } from "@/components/on-demand-diff"
import {
  matchingSurfaceActions,
  setValuePath,
  submitActionTitle,
  surfaceStyle,
  surfaceTargetValue,
  evaluateSurfaceExpression,
  type SurfaceAction,
  type SurfaceActionStep,
  type SurfaceEffect,
} from "@/components/control-surface-runtime"
import {
  runSurfaceRequestWithRetries,
  shouldRetrySurfaceRequest,
  type SurfaceRequestStatus,
} from "./session-question-retry"
import { shouldAutofocusQuestionDock } from "./session-question-autofocus"
import { QuestionDockMenu } from "./question-dock-menu"
import {
  isFormExpectation,
  isFormExpectationText,
  questionAriaLabel,
  questionExpectation,
} from "./session-question-expectation"
import {
  applyRichTextLink,
  captureRichTextSelection,
  restoreRichTextSelection,
  safeRichTextHref,
} from "./session-question-rich-text"
import {
  defaultRichTextToolbar,
  type QuestionAttachmentMap,
  type QuestionControlType,
  type QuestionDetailReview,
  type QuestionDetailTarget,
  type QuestionDockActions,
  type QuestionFormField,
  type QuestionFormLayoutNode,
  type QuestionFormNumber,
  type QuestionFormRangeValue,
  type QuestionFormRichTextAction,
  type QuestionFormSpec,
  type QuestionFormSuggestion,
  type QuestionFormSuggestionState,
  type QuestionFormValue,
  type QuestionImageAttachmentPart,
  type QuestionMediaChecklistBlock,
  type QuestionMediaItem,
  type QuestionV2Info,
  type QuestionOption,
  finalizeRemainingOption,
  finalizeRemainingOverlay,
} from "./question-dock-types"
import {
  displayFieldContent,
  hasValueBearingBody,
  mediaChecklistSelection,
  safeQuestionActionHref,
  structuredQuestionAnswer,
  type QuestionBodySelections,
} from "./session-question-body"

const DialogSelectDirectory = lazy(() =>
  import("@/components/dialog-select-directory").then((module) => ({ default: module.DialogSelectDirectory })),
)

type CacheEntry = {
  tab: number
  answers: string[][]
  custom: string[]
  customOn: boolean[]
  sliders: Record<number, number>
  rankings: Record<number, string[]>
  ratings: Record<number, Record<string, number>>
  forms: Record<number, Record<string, QuestionFormValue>>
  formInputs: Record<string, string>
  video: Record<string, { current: number; duration: number; paused: boolean }>
  body: Record<number, QuestionBodySelections>
  attachments?: QuestionAttachmentMap
}

const cache = new Map<string, CacheEntry>()

function Mark(props: { multi: boolean; picked: boolean; danger?: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span
        data-slot="question-option-box"
        data-type={props.multi ? "checkbox" : "radio"}
        data-picked={props.picked}
        data-tone={props.danger ? "danger" : undefined}
      >
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  compact?: boolean
  label: string
  description?: string
  tooltip?: string
  pros?: string[]
  cons?: string[]
  details?: unknown
  disabled: boolean
  danger?: boolean
  detailsActive?: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
  onDetails?: VoidFunction
}) {
  const hasDetails = createMemo(() => !!optionDetailReview(props))

  return (
    <span data-slot="question-option-wrap" data-detail-active={props.detailsActive === true}>
      <button
        type="button"
        ref={props.ref}
        data-slot="question-option"
        data-picked={props.picked}
        data-compact={props.compact}
        role={props.multi ? "checkbox" : "radio"}
        aria-checked={props.picked}
        disabled={props.disabled}
        title={props.tooltip ?? (props.compact ? optionTooltip(props) : undefined)}
        onFocus={props.onFocus}
        onClick={props.onClick}
      >
        <Mark multi={props.multi} picked={props.picked} danger={props.danger} />
        <span data-slot="question-option-main">
          <span data-slot="option-label">{props.label}</span>
          <Show when={!props.compact}>
            <Show when={props.description}>
              <span data-slot="option-description">{props.description}</span>
            </Show>
            <Show when={props.pros?.length}>
              <span data-slot="option-list" data-kind="pros">
                Pros: {props.pros!.join(", ")}
              </span>
            </Show>
            <Show when={props.cons?.length}>
              <span data-slot="option-list" data-kind="cons">
                Cons: {props.cons!.join(", ")}
              </span>
            </Show>
          </Show>
        </span>
      </button>
      <Show when={hasDetails()}>
        <button
          type="button"
          data-slot="question-detail-toggle"
          data-level="option"
          aria-expanded={props.detailsActive === true}
          aria-label={`Mehr Details zu ${props.label}`}
          disabled={props.disabled}
          onClick={props.onDetails}
        >
          Mehr Details
        </button>
      </Show>
    </span>
  )
}

function optionTooltip(option: Pick<QuestionOption, "label" | "description" | "pros" | "cons" | "details">) {
  return [
    option.description,
    option.pros?.length ? `Pros: ${option.pros.join(", ")}` : undefined,
    option.cons?.length ? `Cons: ${option.cons.join(", ")}` : undefined,
    optionDetailText(option),
    optionDetailEntriesFor(option)
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n"),
  ]
    .filter((item): item is string => !!item)
    .join("\n")
}

function optionDetails(value?: unknown) {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ")
}

function optionDetailEntries(value?: unknown) {
  if (!isRecord(value)) return []
  return Object.entries(value)
    .map(([key, entry]) => ({ label: readableDetailKey(key), value: detailValue(entry) }))
    .filter((entry) => entry.value)
}

function readableDetailKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (first) => first.toUpperCase())
}

function detailValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join("\n")
  return JSON.stringify(value, undefined, 2) ?? String(value)
}

function normalizedDetailText(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? ""
}

function hasAdditionalDetail(value: string | undefined, visible: Array<string | undefined>) {
  const normalized = normalizedDetailText(value)
  const visibleText = visible.map(normalizedDetailText).filter(Boolean)
  return !!normalized && !visibleText.some((item) => item === normalized) && !visibleText.join(" ").includes(normalized)
}

function visibleOptionText(option: Pick<QuestionOption, "label" | "description" | "pros" | "cons">) {
  return [option.label, option.description, ...(option.pros ?? []), ...(option.cons ?? [])]
}

function optionDetailText(option: Pick<QuestionOption, "label" | "description" | "pros" | "cons" | "details">) {
  if (Array.isArray(option.details) && option.details.every((item) => typeof item === "string")) {
    const visible = visibleOptionText(option)
    const seen = new Set(visible.map(normalizedDetailText).filter(Boolean))
    return option.details
      .filter((item) => {
        const normalized = normalizedDetailText(item)
        if (!hasAdditionalDetail(item, visible) || seen.has(normalized)) return false
        seen.add(normalized)
        return true
      })
      .join(" ")
  }
  const details = optionDetails(option.details)
  if (!hasAdditionalDetail(details, visibleOptionText(option))) return
  return details
}

function optionDetailEntriesFor(option: Pick<QuestionOption, "label" | "description" | "pros" | "cons" | "details">) {
  const visible = visibleOptionText(option)
  const seen = new Set(visible.map(normalizedDetailText).filter(Boolean))
  return optionDetailEntries(option.details).filter((entry) => {
    const normalized = normalizedDetailText(entry.value)
    if (!hasAdditionalDetail(entry.value, visible) || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function controlType(question: QuestionV2Info | undefined): QuestionControlType {
  if (question?.type) return question.type
  return question?.multiple ? "pick_many" : "pick_one"
}

function controlOptions(question: QuestionV2Info | undefined): QuestionOption[] {
  if (!question) return []
  if (question.type === "confirm" && !question.options?.length) {
    return [
      { label: "Yes", description: "Confirm and continue" },
      { label: "No", description: "Reject or keep discussing" },
    ]
  }
  if (question.type === "thumbs" && !question.options?.length) {
    return [
      { label: "Thumbs up", description: "Positive feedback" },
      { label: "Thumbs down", description: "Negative feedback" },
    ]
  }
  if (reviewControl(question.type) && !question.options?.length) {
    return [
      { label: "Approved", description: "Accept this plan or reviewed content" },
      { label: "Needs changes", description: "Request edits before continuing" },
    ]
  }
  if (question.type === "emoji_react" && question.emojis?.length) return question.emojis.map((label) => ({ label }))
  return question.options ?? []
}

function choiceControl(type: QuestionControlType | undefined) {
  return (
    type !== undefined && ["pick_one", "pick_many", "confirm", "show_options", "thumbs", "emoji_react"].includes(type)
  )
}

function textControl(type: QuestionControlType | undefined) {
  return type !== undefined && ["ask_text", "ask_code", "ask_file", "ask_image"].includes(type)
}

function reviewControl(type: QuestionControlType | undefined) {
  return (
    type !== undefined &&
    ["show_plan", "review_section", "show_diff", "accordion", "details", "tabs", "object_tree", "table"].includes(type)
  )
}

function reviewVariant(type: QuestionControlType | undefined): ExplorableVariant {
  if (type === "accordion" || type === "details" || type === "tabs" || type === "object_tree" || type === "table")
    return type
  return "review"
}

function visibleQuestionText(question: QuestionV2Info, type: QuestionControlType | undefined) {
  if (!reviewControl(type)) return [question.question]
  if (type === "show_diff") return [question.question, question.filePath, question.markdown ?? question.content, question.before, question.after]
  if (reviewVariant(type) === "review") {
    const content = question.markdown ?? question.content
    return [question.question, question.filePath, content, ...(content ? [] : sectionDetailText(question.sections))]
  }
  return [question.question, question.filePath, ...sectionDetailText(question.sections)]
}

function sectionDetailText(sections: ExplorableSection[] | undefined): string[] {
  return (sections ?? []).flatMap((section) => [section.title, section.content, ...sectionDetailText(section.children)])
}

function questionDetailReview(
  question: QuestionV2Info | undefined,
  type: QuestionControlType | undefined,
): QuestionDetailReview | undefined {
  if (!question) return
  if (question.context && hasAdditionalDetail(question.context, visibleQuestionText(question, type))) {
    return {
      level: "question",
      title: "Mehr Details zur Frage",
      content: question.context,
      variant: "review",
      source: "context",
    }
  }
  if (!reviewControl(type) && hasAdditionalDetail(question.markdown ?? question.content, [question.question])) {
    return {
      level: "question",
      title: "Mehr Details zur Frage",
      markdown: question.markdown,
      content: question.content,
      variant: "review",
      source: "review",
    }
  }
  if (!reviewControl(type) && question.sections?.length) {
    return {
      level: "question",
      title: "Mehr Details zur Frage",
      sections: question.sections,
      variant: "details",
      source: "review",
    }
  }
}

function optionDetailReview(option: QuestionOption | undefined): QuestionDetailReview | undefined {
  if (!option) return
  const details = optionDetailText(option)
  if (details) {
    return {
      level: "option",
      title: `Mehr Details: ${option.label}`,
      content: details,
      variant: "review",
      source: "review",
    }
  }
  const entries = optionDetailEntriesFor(option)
  if (entries.length === 0) return
  return {
    level: "option",
    title: `Mehr Details: ${option.label}`,
    sections: entries.map((entry, index) => ({
      id: detailSectionID(entry.label, index),
      title: entry.label,
      content: entry.value,
    })),
    variant: "object_tree",
    source: "review",
  }
}

function detailSectionID(label: string, index: number) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `detail-${index}`
}

function optionKey(option: QuestionOption) {
  return option.id ?? option.label
}

function formTooltip(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function dangerAnswer(value: string) {
  return /\b(cancel|abort|reject|decline|stop)\b|abbrechen|ablehnen/i.test(value)
}

function reviewSubmitAction(question: QuestionV2Info | undefined, type: QuestionControlType | undefined) {
  if (!question || type !== "accordion" || question.options?.length !== 1) return
  const option = question.options[0]
  if (option.id !== "implement") return
  return option
}

function formListField(field: QuestionFormField) {
  return field.type === "recipient_list" || field.type === "attachment_list" || field.type === "file_picker" || field.type === "folder_picker"
}

function formFreeTextField(field: QuestionFormField) {
  return field.type === "text" || field.type === "email" || field.type === "textarea" || field.type === "rich_text"
}

function formInitialValue(field: QuestionFormField): QuestionFormValue {
  if (formListField(field))
    return Array.isArray(field.defaultValue)
      ? field.defaultValue.filter((item): item is string => typeof item === "string")
      : []
  if (field.type === "checkbox") return field.defaultValue === true
  if (field.type === "number") {
    if (typeof field.defaultValue === "number" && Number.isFinite(field.defaultValue)) return field.defaultValue
    return ""
  }
  if (field.type === "number_range" || field.type === "duration_range") return formInitialRangeValue(field)
  if (field.type === "select") {
    if (typeof field.defaultValue === "string") return field.defaultValue
    return field.options?.[0] ? optionKey(field.options[0]) : ""
  }
  if (typeof field.defaultValue === "string")
    return field.type === "rich_text" ? richTextInitialHtml(field.defaultValue) : field.defaultValue
  if (typeof field.defaultValue === "number") return String(field.defaultValue)
  return ""
}

function formValueString(value: QuestionFormValue | undefined) {
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "true" : "false"
  return ""
}

function formInitialRangeValue(field: QuestionFormField): QuestionFormRangeValue {
  if (field.defaultValue && typeof field.defaultValue === "object" && !Array.isArray(field.defaultValue)) {
    const value = field.defaultValue as Record<string, unknown>
    return {
      start: typeof value.start === "number" && Number.isFinite(value.start) ? value.start : undefined,
      end: typeof value.end === "number" && Number.isFinite(value.end) ? value.end : undefined,
    }
  }
  return {}
}

function formValueNumber(value: QuestionFormValue | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
}

function formValueRange(value: QuestionFormValue | undefined): QuestionFormRangeValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return {
    start: typeof value.start === "number" && Number.isFinite(value.start) ? value.start : undefined,
    end: typeof value.end === "number" && Number.isFinite(value.end) ? value.end : undefined,
  }
}

function formValueList(value: QuestionFormValue | undefined) {
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.trim()) return [value.trim()]
  return []
}

function formNumber(value: QuestionFormNumber | undefined, fallback?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function defaultFormLayout(form: QuestionFormSpec): QuestionFormLayoutNode {
  return {
    type: "vstack",
    gap: "18px",
    children: form.fields
      .filter((field) => field.type !== "hidden")
      .map((field) => ({ type: "field", field: field.id })),
  }
}

function formFieldRequiredAnswered(field: QuestionFormField, value: QuestionFormValue | undefined) {
  if (!field.required) return true
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value)
  if (field.type === "number_range" || field.type === "duration_range") {
    const range = formValueRange(value)
    return range.start !== undefined && range.end !== undefined
  }
  return typeof value === "string" && value.trim().length >= (formNumber(field.minLength, 1) ?? 1)
}

function formFieldValidationError(field: QuestionFormField, value: QuestionFormValue | undefined) {
  if (field.type === "display" || field.type === "hidden" || field.type === "image_preview" || field.type === "video_preview" || field.type === "button")
    return
  if (!formFieldRequiredAnswered(field, value)) return "Dieses Feld ist erforderlich."
  if (!field.required && !hasQuestionFormValue(value)) return
  if (field.type === "number") {
    const number = formValueNumber(value)
    if (number === undefined) return "Bitte eine gueltige Zahl eingeben."
    const min = formNumber(field.min)
    const max = formNumber(field.max)
    if (min !== undefined && number < min) return `Muss mindestens ${min} sein.`
    if (max !== undefined && number > max) return `Muss hoechstens ${max} sein.`
    return
  }
  if (field.type === "number_range" || field.type === "duration_range") {
    const range = formValueRange(value)
    if (range.start === undefined || range.end === undefined) return "Start und Ende muessen gesetzt sein."
    if (range.start >= range.end) return "Start muss vor Ende liegen."
    const min = formNumber(field.min)
    const max = formNumber(field.max)
    if (min !== undefined && (range.start < min || range.end < min)) return `Werte muessen mindestens ${min} sein.`
    if (max !== undefined && (range.start > max || range.end > max)) return `Werte muessen hoechstens ${max} sein.`
  }
}

function hasQuestionFormValue(value: QuestionFormValue | undefined) {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "object" && value) {
    const range = formValueRange(value)
    return range.start !== undefined || range.end !== undefined
  }
  return typeof value === "string" && value.trim().length > 0
}

function formAnswer(form: QuestionFormSpec | undefined, values: Record<string, QuestionFormValue>) {
  return JSON.stringify({
    version: 1,
    type: "opencode.form.answer",
    formID: form?.id,
    values,
  })
}

function formRecipientSuggestions(value: unknown): QuestionFormSuggestion[] {
  if (!value || typeof value !== "object" || !("suggestions" in value) || !Array.isArray(value.suggestions)) return []
  return value.suggestions.filter((item): item is QuestionFormSuggestion => {
    return !!item && typeof item === "object" && "email" in item && typeof item.email === "string"
  })
}

function formSize(value: string | undefined) {
  if (!value || value === "auto") return undefined
  if (value === "fill") return "0"
  return value
}

function formStackSize(value: string | undefined) {
  if (!value || value === "auto") return undefined
  if (value === "fill") return "100%"
  return value
}

function formStackStyle(node: QuestionFormLayoutNode): JSX.CSSProperties {
  return {
    gap: node.gap ?? (node.type === "hstack" ? "16px" : "18px"),
    ...(formStackSize(node.width) ? { width: formStackSize(node.width) } : {}),
    ...(formStackSize(node.height) ? { height: formStackSize(node.height) } : {}),
  }
}

function formFieldLayout(field: QuestionFormField) {
  if (field.type === "button") return "button"
  if (
    field.type === "textarea" ||
    field.type === "rich_text" ||
    field.type === "image_preview" ||
    field.type === "video_preview" ||
    field.type === "display"
  ) {
    return "stacked"
  }
  return "inline"
}

function formChildStyle(parent: QuestionFormLayoutNode, child: QuestionFormLayoutNode): JSX.CSSProperties {
  const value = parent.type === "hstack" ? child.width : child.height
  if (value === "fill") {
    if (parent.type === "hstack") return { flex: "1 1 180px", "min-width": "min(100%, 180px)", "max-width": "100%" }
    return { flex: "1 1 0", "min-height": "0" }
  }
  if (!value || value === "auto") {
    if (parent.type === "hstack") return { flex: "0 1 auto", "min-width": "0", "max-width": "100%" }
    return { flex: "0 0 auto" }
  }
  if (parent.type === "hstack")
    return { flex: `0 0 min(${value}, 100%)`, width: `min(${value}, 100%)`, "min-width": "0", "max-width": "100%" }
  return { flex: `0 0 ${value}`, height: value, "min-height": "0" }
}

const embeddedReviewPrefix = "opencode.embeddedReview:v1:"

function embeddedFormReview(text: string | undefined) {
  if (!text?.startsWith(embeddedReviewPrefix)) return
  try {
    return JSON.parse(text.slice(embeddedReviewPrefix.length)) as {
      markdown?: string
      content?: string
      sections?: ExplorableSection[]
      variant?: ExplorableVariant
    }
  } catch {
    return
  }
}

function richTextActionLabel(action: QuestionFormRichTextAction) {
  if (action === "bold") return "B"
  if (action === "italic") return "I"
  if (action === "underline") return "U"
  if (action === "link") return "Link"
  if (action === "bullet_list") return "List"
  return "1. List"
}

function richTextInitialHtml(value: string) {
  if (/<\/?(?:a|b|br|div|em|i|li|ol|p|strong|u|ul)\b/i.test(value)) return sanitizeRichTextHtml(value)
  return escapeRichText(value).replace(/\r\n|\r|\n/g, "<br>")
}

function escapeRichText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function sanitizeRichTextHtml(value: string) {
  if (typeof document === "undefined") return escapeRichText(value)
  const template = document.createElement("template")
  template.innerHTML = value
  sanitizeRichTextNode(template.content)
  return template.innerHTML
}

function sanitizeRichTextNode(node: Node) {
  const allowed = new Set(["a", "b", "br", "div", "em", "i", "li", "ol", "p", "strong", "u", "ul"])
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (!(child instanceof HTMLElement)) {
      child.remove()
      continue
    }

    const tag = child.tagName.toLowerCase()
    if (!allowed.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes))
      sanitizeRichTextNode(node)
      return
    }

    for (const attribute of Array.from(child.attributes)) {
      if (tag === "a" && attribute.name.toLowerCase() === "href" && safeRichTextHref(attribute.value)) continue
      child.removeAttribute(attribute.name)
    }
    sanitizeRichTextNode(child)
  }
}

function DialogRichTextLink(props: { onSubmit: (url: string) => void }) {
  const dialog = useDialog()
  const [value, setValue] = createSignal("https://")
  const [error, setError] = createSignal("")

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const url = safeRichTextHref(value())
    if (!url) {
      setError("Use an http://, https://, or mailto: URL.")
      return
    }
    props.onSubmit(url)
    dialog.close()
  }

  return (
    <Dialog title="Link URL" class="w-full max-w-[480px] mx-auto">
      <form class="flex flex-col gap-6 p-6 pt-0" onSubmit={submit}>
        <TextField
          autofocus
          label="Link URL"
          value={value()}
          error={error()}
          onChange={(next) => {
            setValue(next)
            setError("")
          }}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large">
            Apply link
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export const SessionQuestionDock: Component<{
  request: SurfaceBlockingRequest
  onSubmit?: () => void
  autofocus?: boolean
  queueIndex?: number
  queueTotal?: number
  onPrevious?: () => void
  onNext?: () => void
  onLocalDismiss?: () => void
  dock?: QuestionDockActions
  collapsible?: boolean
  fill?: boolean
  actionTarget?: { kind: "request" | "tool"; id: string; revision: number }
  onToolDismiss?: () => void
  onValuesChange?: (values: Record<string, QuestionFormValue>) => void
}> = (props) => {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const cacheKey = ScopedKey.from(serverSDK().scope, props.request.id)

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(cacheKey)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as string[][]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    sliders: cached?.sliders ?? ({} as Record<number, number>),
    rankings: cached?.rankings ?? ({} as Record<number, string[]>),
    ratings: cached?.ratings ?? ({} as Record<number, Record<string, number>>),
    forms: cached?.forms ?? ({} as Record<number, Record<string, QuestionFormValue>>),
    formInputs: cached?.formInputs ?? ({} as Record<string, string>),
    video: cached?.video ?? ({} as Record<string, { current: number; duration: number; paused: boolean }>),
    body: cached?.body ?? ({} as Record<number, QuestionBodySelections>),
    detailViews: {} as Record<number, QuestionDetailTarget | undefined>,
    attachments: cached?.attachments ?? ({} as QuestionAttachmentMap),
    attachmentUploads: 0,
    folderPickerOpen: false,
    suggestions: {} as Record<string, QuestionFormSuggestionState>,
    editing: false,
    focus: 0,
    fullscreen: false,
    fullscreenVideo: "",
    collapsed: false,
  })
  const [requestStatus, setRequestStatus] = createSignal<SurfaceRequestStatus>({ type: "idle" })
  const [fullscreenVideoDialog, setFullscreenVideoDialog] = createSignal<HTMLDivElement>()
  const [fullscreenVideoTrigger, setFullscreenVideoTrigger] = createSignal<HTMLButtonElement>()

  const closeFullscreenVideo = () => {
    setStore("fullscreenVideo", "")
    requestAnimationFrame(() => {
      const trigger = fullscreenVideoTrigger()
      if (!trigger?.isConnected) return
      trigger.focus({ preventScroll: true })
    })
  }

  createEffect(() => {
    if (!store.fullscreenVideo) return
    const appRoot = document.getElementById("root")
    if (!appRoot) return
    const wasInert = appRoot.inert
    appRoot.inert = true
    onCleanup(() => (appRoot.inert = wasInert))
  })

  createEffect(() => {
    if (!store.fullscreenVideo) return
    const dialog = fullscreenVideoDialog()
    if (!dialog) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Tab" && dialog.contains(document.activeElement)) {
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            [
              "button:not([disabled])",
              "video[controls]",
              "[href]",
              "input:not([disabled])",
              "select:not([disabled])",
              "textarea:not([disabled])",
              '[tabindex]:not([tabindex="-1"])',
            ].join(","),
          ),
        ).filter((element) => element.tabIndex >= 0)
        if (!focusable.length) {
          event.preventDefault()
          dialog.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      if (event.key !== "Escape") return
      const activeElement = document.activeElement
      const focusOwner = dialog.contains(activeElement)
        ? "fullscreen"
        : activeElement === fullscreenVideoTrigger()
          ? "trigger"
          : "other"
      if (!shouldCloseVideoFullscreenOnEscape({ key: event.key, defaultPrevented: event.defaultPrevented, focusOwner }))
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeFullscreenVideo()
    }
    window.addEventListener("keydown", closeOnEscape, true)
    onCleanup(() => window.removeEventListener("keydown", closeOnEscape, true))
  })

  let root: HTMLDivElement | undefined
  let progressRef: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let disposed = false
  let submitting = false
  let focusFrame: number | undefined
  let activeQuestionController: AbortController | undefined
  let activeFormActionController: AbortController | undefined
  let preserveFormActionOnCleanup = false
  const suggestionTimers = new Map<string, number>()
  const suggestionControllers = new Map<string, AbortController>()

  const question = createMemo(() => questions()[store.tab] as QuestionV2Info | undefined)
  const detached = createMemo(() => props.request.detached === true)
  const currentType = createMemo(() => controlType(question()))
  const expectation = createMemo(() => questionExpectation(question(), currentType()))
  const options = createMemo(() => controlOptions(question()).filter((option) => option.finalizeRemaining !== true))
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => currentType() === "pick_many" || question()?.multiple === true)
  const customAllowed = createMemo(
    () => choiceControl(currentType()) && question()?.custom !== false && question()?.allowOther !== false,
  )
  const count = createMemo(() => Math.max(1, options().length + (customAllowed() ? 1 : 0)))
  const compactReviewActions = createMemo(() => reviewControl(currentType()) && question()?.allowFeedback === true)
  const questionDetails = createMemo(() => questionDetailReview(question(), currentType()))
  const activeDetailTarget = createMemo(() => store.detailViews[store.tab])
  const questionDetailsOpen = createMemo(() => activeDetailTarget()?.type === "question")
  const activeDetailReview = createMemo(() => {
    const target = activeDetailTarget()
    if (!target) return
    if (target.type === "question") return questionDetails()
    return optionDetailReview(options().find((option) => optionKey(option) === target.key))
  })
  const activeDetailCacheKey = createMemo(() => {
    const target = activeDetailTarget()
    if (!target) return `question:${props.request.id}:${store.tab}:details`
    if (target.type === "question") return `question:${props.request.id}:${store.tab}:details:question`
    return `question:${props.request.id}:${store.tab}:details:option:${target.key}`
  })
  const inlineContext = createMemo(() => {
    const q = question()
    if (!q?.context) return
    if (questionDetails()?.source === "context") return
    return q.context
  })
  const fillAvailableHeight = createMemo(
    () => !!activeDetailReview() || reviewControl(currentType()) || currentType() === "form" || !!question()?.body?.length,
  )

  const questionSummary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })
  const summary = createMemo(() => {
    if (detached()) return question()?.header ?? question()?.form?.title ?? question()?.question ?? "Detached action"
    const queueTotal = props.queueTotal ?? 1
    if (queueTotal <= 1) return questionSummary()
    return language.t("session.question.queueProgress", { current: props.queueIndex ?? 1, total: queueTotal })
  })
  const revealActiveProgress = () => {
    const container = progressRef
    const segment = container?.querySelectorAll<HTMLButtonElement>('[data-slot="question-progress-segment"]')[store.tab]
    if (!container || !segment) return
    const containerBox = container.getBoundingClientRect()
    const segmentBox = segment.getBoundingClientRect()
    if (segmentBox.left < containerBox.left) container.scrollLeft -= containerBox.left - segmentBox.left
    if (segmentBox.right > containerBox.right) container.scrollLeft += segmentBox.right - containerBox.right
  }
  createEffect(revealActiveProgress)
  const showQuestionText = createMemo(() => {
    const q = question()
    if (!q?.question) return false
    if (controlType(q) === "form" && (q.form?.title || q.form?.description)) return false
    return true
  })

  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")
  const showQuestionDetails = () =>
    setStore("detailViews", store.tab, questionDetailsOpen() ? undefined : { type: "question" })
  const showOptionDetails = (option: QuestionOption) => setStore("detailViews", store.tab, { type: "option", key: optionKey(option) })
  const optionDetailsOpen = (option: QuestionOption) => {
    const target = activeDetailTarget()
    return target?.type === "option" && target.key === optionKey(option)
  }
  const closeDetails = () => setStore("detailViews", store.tab, undefined)

  const last = createMemo(() => store.tab >= total() - 1)
  const finalReviewAction = createMemo(() => (last() ? reviewSubmitAction(question(), currentType()) : undefined))
  const implementationCompleteFollowup = createMemo(() => props.request.phase === "implementation_complete_followup")

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    if (store.fullscreen) {
      root.style.setProperty("--question-prompt-max-height", "calc(100dvh - 96px)")
      return
    }

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const tabQuestion = questions()[tab] as QuestionV2Info | undefined
    const list = controlOptions(tabQuestion)
    if (store.customOn[tab] === true && tabQuestion?.custom !== false && tabQuestion?.allowOther !== false)
      return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
        revealActiveProgress()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller, progressRef], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    if (shouldAutofocusQuestionDock({ autofocus: props.autofocus })) focus(pickFocus())
  })

  onCleanup(() => {
    disposed = true
    if (!preserveFormActionOnCleanup) activeFormActionController?.abort()
    suggestionTimers.forEach((timer) => window.clearTimeout(timer))
    suggestionControllers.forEach((controller) => controller.abort())
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
      sliders: { ...store.sliders },
      rankings: Object.fromEntries(Object.entries(store.rankings).map(([key, value]) => [key, [...value]])),
      ratings: Object.fromEntries(Object.entries(store.ratings).map(([key, value]) => [key, { ...value }])),
      forms: Object.fromEntries(Object.entries(store.forms).map(([key, value]) => [key, { ...value }])),
      formInputs: { ...store.formInputs },
      video: { ...store.video },
      body: Object.fromEntries(
        Object.entries(store.body).map(([index, blocks]) => [
          index,
          Object.fromEntries(Object.entries(blocks).map(([id, selected]) => [id, [...selected]])),
        ]),
      ),
      attachments: Object.fromEntries(Object.entries(store.attachments).map(([key, value]) => [key, value.map((item) => ({ ...item }))])),
    })
  })

  const fail = (err: unknown) => {
    const message = questionRequestErrorMessage(err)
    setRequestStatus({ type: "failed", message })
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const closeAfterSubmit = () => {
    props.dock?.onUnpin?.()
    props.onLocalDismiss?.()
    removeLocalQuestion()
    props.onSubmit?.()
  }

  const removeLocalQuestion = () => {
    const [sessionStore, setSessionStore] = serverSync().child(sdk().directory, { bootstrap: false })
    const questions = sessionStore.question[props.request.sessionID]
    if (!questions?.some((question) => question.id === props.request.id)) return
    markQuestionChanged(sessionStore, props.request.id)
    setSessionStore("question", props.request.sessionID, (current = []) => current.filter((question) => question.id !== props.request.id))
  }

  const reconcilePendingQuestions = (snapshot: PendingQuestionsSnapshot) => {
    const [sessionStore, setSessionStore] = serverSync().child(sdk().directory, { bootstrap: false })
    const pending = snapshot.pending.filter((question) => question.sessionID === props.request.sessionID)
    const current = sessionStore.question[props.request.sessionID] ?? []
    const next = snapshot.complete
      ? pending
      : [...new Map([...current, ...pending].map((question) => [question.id, question])).values()]
    current.concat(next).forEach((question) => markQuestionChanged(sessionStore, question.id))
    setSessionStore("question", props.request.sessionID, next)
  }

  const reconcileQuestionBeforeRetry = async () => {
    const settlement = await reconcileSurfaceRequest(sdk().client, {
      request: props.request,
      directory: sdk().directory,
      onReconcile: reconcilePendingQuestions,
    })
    if (!settlement) return { type: "retry" as const }
    return { type: "settled" as const, value: settlement }
  }

  createEffect(() => {
    if (!isSurfaceRequestSettled(props.request)) return
    removeLocalQuestion()
  })

  const appFetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const http = serverSDK().server.http
    headers.set("x-opencode-directory", sdk().directory)
    if (http.password)
      headers.set(
        "authorization",
        `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}`,
      )
    return (platform.fetch ?? fetch)(new URL(path, sdk().url), { ...init, headers })
  }

  const responseErrorText = (text: string, fallback: string) => {
    if (!text) return fallback
    try {
      const data = JSON.parse(text) as unknown
      if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error
    } catch {}
    return text
  }

  const responseError = async (response: Response) => responseErrorText(await response.text(), response.statusText)

  const formActionError = async (response: Response) => {
    const text = await response.text()
    const error = new Error(responseErrorText(text, response.statusText))
    try {
      const data = JSON.parse(text) as unknown
      if (!data || typeof data !== "object" || !("retry" in data)) return error
      if (data.retry !== "safe" && data.retry !== "reconcile") return error
      return Object.assign(error, { formActionRetry: data.retry })
    } catch {
      return error
    }
  }

  const formActionRetry = (error: unknown) => {
    if (!error || typeof error !== "object" || !("formActionRetry" in error)) return
    const retry = error.formActionRetry
    return retry === "safe" || retry === "reconcile" ? retry : undefined
  }

  const attachmentID = () => `question_attachment_${crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`

  const questionAttachmentKey = (index: number, fieldID?: string) => `${index}:${fieldID ?? ""}`

  const questionAttachments = (index: number, fieldID?: string) => store.attachments[questionAttachmentKey(index, fieldID)] ?? []

  const questionAttachmentAnswer = (attachment: QuestionImageAttachmentPart): QuestionV2AnswerFile | undefined => {
    const part = attachment.url
      ? { url: attachment.url, mime: attachment.mime, filename: attachment.filename }
      : imageAttachmentRequestPart(attachment)
    if (!part?.url) return
    return { type: "file", mime: attachment.mime, url: part.url, filename: attachment.filename }
  }

  const questionAttachmentAnswers = (index: number) =>
    Object.entries(store.attachments)
      .filter(([key]) => key.startsWith(`${index}:`))
      .flatMap(([, attachments]) => attachments.flatMap((attachment) => questionAttachmentAnswer(attachment) ?? []))

  const uploadQuestionAttachment = async (file: File, mime: string) => {
    const url = new URL("/app/surface-attachment", sdk().url)
    url.searchParams.set("directory", sdk().directory)
    url.searchParams.set("targetKind", props.actionTarget?.kind ?? "request")
    url.searchParams.set("targetID", props.actionTarget?.id ?? props.request.id)
    url.searchParams.set("filename", file.name)
    url.searchParams.set("mime", mime)
    const response = await appFetch(`${url.pathname}${url.search}`, {
      method: "POST",
      headers: { "content-type": mime },
      body: await file.arrayBuffer(),
    })
    if (!response.ok) throw new Error(await responseError(response))
    const data = (await response.json()) as { file?: { url?: string; path?: string; filename?: string } }
    if (!data.file?.url) throw new Error("Attachment upload did not return a file URL")
    return data.file
  }

  const addQuestionAttachment = async (index: number, fieldID: string | undefined, file: File) => {
    const mime = await attachmentMime(file)
    if (!mime?.startsWith("image/")) {
      showToast({ title: language.t("prompt.toast.pasteUnsupported.title"), description: language.t("prompt.toast.pasteUnsupported.description") })
      return false
    }
    const uploaded = await uploadQuestionAttachment(file, mime)
    const key = questionAttachmentKey(index, fieldID)
    const attachment: QuestionImageAttachmentPart = {
      type: "image",
      id: attachmentID(),
      filename: uploaded?.filename ?? file.name,
      sourcePath: uploaded?.path,
      mime,
      url: uploaded?.url,
    }
    setStore("attachments", key, (current = []) => [...current, attachment])
    return true
  }

  const clipboardFiles = (clipboardData: DataTransfer) =>
    Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

  const handleQuestionPaste = async (event: ClipboardEvent, index: number, fieldID?: string) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return false
    const files = clipboardFiles(clipboardData)
    const plainText = clipboardData.getData("text/plain") ?? ""
    if (files.length === 0 && (plainText || !platform.readClipboardImage)) return false
    event.preventDefault()
    event.stopPropagation()
    setStore("attachmentUploads", (current) => current + 1)
    try {
      const pasted = files.length > 0
        ? files
        : await platform.readClipboardImage?.({ includeBuffer: true }).then((file) => (file ? [file] : []))
      if (!pasted?.length) return true
      for (const file of pasted) await addQuestionAttachment(index, fieldID, file)
      return true
    } catch (err) {
      fail(err)
      return true
    } finally {
      setStore("attachmentUploads", (current) => Math.max(0, current - 1))
    }
  }

  const removeQuestionAttachment = (index: number, fieldID: string | undefined, id: string) => {
    const key = questionAttachmentKey(index, fieldID)
    setStore("attachments", key, (current = []) => current.filter((item) => item.id !== id))
  }

  const openQuestionAttachment = (attachment: QuestionImageAttachmentPart) => {
    if (attachment.sourcePath && platform.openPath) {
      void platform.openPath(attachment.sourcePath)
      return
    }
    if (attachment.url) window.open(attachment.url, "_blank", "noopener,noreferrer")
  }

  const renderQuestionAttachments = (index: number, fieldID?: string) => (
    <Show when={questionAttachments(index, fieldID).length > 0}>
      <div data-slot="question-attachments">
        <For each={questionAttachments(index, fieldID)}>
          {(attachment) => (
            <div data-slot="question-attachment">
              <button type="button" data-slot="question-attachment-preview" disabled={sending()} onClick={() => openQuestionAttachment(attachment)}>
                <span data-slot="question-attachment-name">{attachment.filename}</span>
              </button>
              <button type="button" data-slot="question-attachment-remove" disabled={sending()} aria-label={`Remove ${attachment.filename}`} onClick={() => removeQuestionAttachment(index, fieldID, attachment.id)}>
                <Icon name="close-small" size="small" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )

  const sending = createMemo(() => requestStatus().type === "submitting" || requestStatus().type === "retrying" || store.attachmentUploads > 0 || store.folderPickerOpen)
  const statusText = createMemo(() => {
    const status = requestStatus()
    if (status.type === "submitting") return language.t("session.question.status.sending")
    if (status.type === "retrying")
      return language.t("session.question.status.retrying", { current: status.retry, total: status.maxRetries })
    if (status.type === "failed") return status.message
  })

  const reply = async (answers: QuestionV2Answer[]) => {
    if (submitting || sending()) return
    submitting = true
    setRequestStatus({ type: "idle" })
    try {
      await runSurfaceRequestWithRetries({
        run: (signal) =>
          replyQuestion(
            sdk().client,
            {
              request: props.request,
              answers,
              directory: sdk().directory,
              onReconcile: reconcilePendingQuestions,
            },
            signal,
          ),
        onStatus: setRequestStatus,
        onController: (controller) => {
          activeQuestionController = controller
        },
        shouldRetry: (error) => !isQuestionConflictError(error) && shouldRetrySurfaceRequest(error),
        reconcileBeforeRetry: reconcileQuestionBeforeRetry,
      })
      replied = true
      cache.delete(cacheKey)
      closeAfterSubmit()
    } catch (err) {
      if (disposed) return
      submitting = false
      fail(err)
    }
  }

  const ownServerReject = (
    finish?: () => void,
    options: {
      beforeSubmit?: (signal: AbortSignal) => Promise<QuestionSettlement | undefined>
      onController?: (controller: AbortController | undefined) => void
      shouldRetry?: (error: unknown) => boolean
    } = {},
  ) => {
    const client = sdk().client
    const directory = sdk().directory
    return trackQuestionRejectSettlement(client, {
      request: props.request,
      finish,
      submit: () =>
        runSurfaceRequestWithRetries<QuestionSettlement>({
          run: async (signal) => {
            const settled = await options.beforeSubmit?.(signal)
            if (settled) return settled
            return rejectQuestion(
              client,
              { request: props.request, directory, onReconcile: reconcilePendingQuestions },
              signal,
            )
          },
          onStatus: setRequestStatus,
          onController: (controller) => {
            activeQuestionController = controller
            options.onController?.(controller)
          },
          shouldRetry: (error) =>
            !isQuestionConflictError(error) && (options.shouldRetry?.(error) ?? shouldRetrySurfaceRequest(error)),
          reconcileBeforeRetry: reconcileQuestionBeforeRetry,
        }),
      onSubmitted: () => {
        replied = true
        cache.delete(cacheKey)
        if (disposed) return
        closeAfterSubmit()
      },
    })
  }

  const serverReject = () => {
    if (submitting || sending()) return
    submitting = true
    const finishSettlement = detached() ? undefined : beginQuestionSettlement(props.request.sessionID)
    setRequestStatus({ type: "idle" })
    ownServerReject(finishSettlement)
  }

  const dismiss = () => {
    serverReject()
  }

  const sliderValue = (index: number) => {
    const q = questions()[index] as QuestionV2Info | undefined
    return store.sliders[index] ?? q?.defaultValue ?? q?.min ?? 0
  }

  const rankingValue = (index: number) => {
    const existing = store.rankings[index]
    if (existing?.length) return existing
    return controlOptions(questions()[index] as QuestionV2Info | undefined).map((item) => item.label)
  }

  const ratingValue = (index: number, option: QuestionOption) => {
    const q = questions()[index] as QuestionV2Info | undefined
    return store.ratings[index]?.[optionKey(option)] ?? q?.defaultValue ?? q?.min ?? 1
  }

  const formValues = (index: number) => {
    const form = (questions()[index] as QuestionV2Info | undefined)?.form
    const values = store.forms[index] ?? {}
    if (!form) return values
    return Object.fromEntries(
      form.fields.map((field) => [field.id, values[field.id] ?? formInitialValue(field)]),
    ) as Record<string, QuestionFormValue>
  }

  const formValue = (field: QuestionFormField) => formValues(store.tab)[field.id] ?? formInitialValue(field)

  const setFormField = (field: QuestionFormField, value: QuestionFormValue) => {
    setStore("forms", store.tab, (current = {}) => ({ ...current, [field.id]: value }))
    const form = currentForm()
    const values = { ...formValues(store.tab), [field.id]: value }
    props.onValuesChange?.(values)
    runLocalFormActions(form, "change", field.id, values, value)
    const action = matchingChangeAction(form, field, values)
    if (form && action) void submitFormAction(form, values, action, false, field.id)
  }

  const formSurfaceState = () =>
    Object.fromEntries(
      (currentForm()?.fields ?? []).map((field) => {
        const state = videoState(field)
        return [field.id, { currentTime: state.current, duration: state.duration, paused: state.paused }]
      }),
    )

  const formSurfaceContext = (values = formValues(store.tab), result?: Record<string, unknown>) => ({ values, state: formSurfaceState(), result })

  const runLocalFormActions = (
    form: QuestionFormSpec | undefined,
    event: "change" | "click" | "markStart" | "markEnd",
    source: string | undefined,
    values: Record<string, QuestionFormValue>,
    fallback: unknown,
  ) => {
    for (const action of matchingSurfaceActions(form?.actions, event, source, values)) {
      for (const step of action.steps) runLocalFormActionStep(step, values, fallback)
    }
  }

  const runLocalFormActionStep = (step: SurfaceActionStep, values: Record<string, QuestionFormValue>, fallback: unknown, result?: Record<string, unknown>) => {
    if (step.type !== "setValue") return
    const nextValues = setValuePath(values, step.target, evaluateSurfaceExpression(step.value, formSurfaceContext(values, result), fallback))
    const id = step.target.match(/^values\.([A-Za-z0-9_-]+)/)?.[1]
    const field = formFieldById(id)
    if (field) {
      setStore("forms", store.tab, (current = {}) => ({ ...current, [field.id]: nextValues[field.id] as QuestionFormValue }))
      props.onValuesChange?.(nextValues as Record<string, QuestionFormValue>)
    }
  }

  const runActionSetValueSteps = (action: SurfaceAction, values: Record<string, QuestionFormValue>, result?: Record<string, unknown>) => {
    for (const step of action.steps) runLocalFormActionStep(step, values, undefined, result)
  }

  const formInputKey = (field: QuestionFormField) => `${store.tab}:${field.id}`

  const setFormListInput = (field: QuestionFormField, value: string) => {
    setStore("formInputs", formInputKey(field), value)
    queueFormSuggestions(field, value)
  }

  const formSuggestionState = (field: QuestionFormField) =>
    store.suggestions[formInputKey(field)] ?? { query: "", items: [], active: 0, loading: false }

  const queueFormSuggestions = (field: QuestionFormField, value: string) => {
    const key = formInputKey(field)
    const query = value.trim()
    const minLength = formNumber(field.autocomplete?.minLength, 2) ?? 2
    if (
      field.type !== "recipient_list" ||
      field.autocomplete?.provider !== "gmail-recipients" ||
      query.length < minLength
    ) {
      suggestionTimers.get(key) && window.clearTimeout(suggestionTimers.get(key))
      suggestionControllers.get(key)?.abort()
      setStore("suggestions", key, { query, items: [], active: 0, loading: false })
      return
    }

    suggestionTimers.get(key) && window.clearTimeout(suggestionTimers.get(key))
    const timer = window.setTimeout(() => void loadFormSuggestions(field, query), 160)
    suggestionTimers.set(key, timer)
    setStore("suggestions", key, (current = { query, items: [], active: 0, loading: false }) => ({
      ...current,
      query,
      loading: true,
    }))
  }

  const loadFormSuggestions = async (field: QuestionFormField, query: string) => {
    const key = formInputKey(field)
    suggestionControllers.get(key)?.abort()
    const controller = new AbortController()
    suggestionControllers.set(key, controller)
    try {
      const url = new URL("/app/gmail/recipients", sdk().url)
      url.searchParams.set("q", query)
      url.searchParams.set("directory", sdk().directory)
      url.searchParams.set("targetKind", props.actionTarget?.kind ?? "request")
      url.searchParams.set("targetID", props.actionTarget?.id ?? props.request.id)
      url.searchParams.set("targetRevision", String(props.actionTarget?.revision ?? props.request.revision))
      url.searchParams.set("formID", currentForm()?.id ?? "")
      url.searchParams.set("fieldID", field.id)
      const response = await appFetch(`${url.pathname}${url.search}`, { signal: controller.signal })
      if (!response.ok) throw new Error(await responseError(response))
      const data = (await response.json()) as unknown
      const suggestions = formRecipientSuggestions(data).filter(
        (item) => !formValueList(formValue(field)).includes(item.email),
      )
      if ((store.formInputs[key] ?? "").trim() !== query) return
      setStore("suggestions", key, { query, items: suggestions, active: 0, loading: false })
    } catch (error) {
      if (controller.signal.aborted) return
      setStore("suggestions", key, (current = { query, items: [], active: 0, loading: false }) => ({
        ...current,
        loading: false,
      }))
    } finally {
      if (suggestionControllers.get(key) === controller) suggestionControllers.delete(key)
    }
  }

  const addFormListValue = (field: QuestionFormField, suggested?: string) => {
    const raw = (suggested ?? store.formInputs[formInputKey(field)] ?? "").trim()
    if (!raw) return
    const existing = formValueList(formValue(field))
    if (field.type === "folder_picker") {
      setFormField(field, questionFolderValues(existing, raw, field.multiple))
      setFormListInput(field, "")
      return
    }
    const values = raw
      .split(/[;,\n]/)
      .map((item) => item.trim())
      .filter((item) => item && !existing.includes(item))
    if (values.length === 0) return
    setFormField(field, field.multiple === false ? [values[0]!] : [...existing, ...values])
    setFormListInput(field, "")
  }

  const chooseFormSuggestion = (field: QuestionFormField, suggestion: QuestionFormSuggestion) => {
    addFormListValue(field, suggestion.email)
  }

  const moveFormSuggestion = (field: QuestionFormField, step: number) => {
    const key = formInputKey(field)
    const state = formSuggestionState(field)
    if (!state.items.length) return
    setStore("suggestions", key, "active", (state.active + step + state.items.length) % state.items.length)
  }

  const handleFormListKeyDown = (event: KeyboardEvent, field: QuestionFormField) => {
    const state = formSuggestionState(field)
    if (field.type === "recipient_list" && state.items.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        moveFormSuggestion(field, 1)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        moveFormSuggestion(field, -1)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setStore("suggestions", formInputKey(field), { query: "", items: [], active: 0, loading: false })
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const suggestion = state.items[state.active]
        if (suggestion) {
          event.preventDefault()
          chooseFormSuggestion(field, suggestion)
          return
        }
      }
    }

    if (event.key !== "Enter") return
    event.preventDefault()
    addFormListValue(field)
  }

  const removeFormListValue = (field: QuestionFormField, item: string) => {
    setFormField(
      field,
      formValueList(formValue(field)).filter((value) => value !== item),
    )
  }

  const addPickedFiles = (field: QuestionFormField, files: FileList | null) => {
    if (field.type === "folder_picker") return
    if (!files?.length) return
    const existing = formValueList(formValue(field))
    const picked = Array.from(files)
      .map((file) => {
        const path = (file as File & { path?: unknown }).path
        return typeof path === "string" && path ? path : file.name
      })
      .filter((item) => item && !existing.includes(item))
    if (!picked.length) return
    setFormField(field, field.multiple === false ? [picked[0]!] : [...existing, ...picked])
  }

  const browseFolders = async (field: QuestionFormField) => {
    if (sending()) return
    const connection = server.current
    if (!connection) return
    setStore("folderPickerOpen", true)
    try {
      const paths = await pickQuestionFolders({
        platform,
        server: connection,
        title: field.label ?? "Folder",
        multiple: field.multiple,
        pickServer: () =>
          new Promise((resolve) => {
            dialog.push(
              () => (
                <DialogSelectDirectory
                  server={connection}
                  title={field.label}
                  multiple={field.multiple === true}
                  onSelect={resolve}
                />
              ),
              () => resolve(null),
            )
          }),
      })
      if (disposed || !paths.length) return
      setStore("folderPickerOpen", false)
      setFormField(field, questionFolderValues(formValueList(formValue(field)), paths, field.multiple))
    } catch (error) {
      if (!disposed) showToast({ title: field.label ?? "Folder", description: questionRequestErrorMessage(error) })
    } finally {
      if (!disposed) setStore("folderPickerOpen", false)
    }
  }

  const applyRichTextAction = (
    field: QuestionFormField,
    action: QuestionFormRichTextAction,
    input: HTMLDivElement | undefined,
  ) => {
    input?.focus()
    if (action === "link") {
      if (!input) return
      const range = captureRichTextSelection(input)
      dialog.push(
        () => (
          <DialogRichTextLink
            onSubmit={(url) => {
              applyRichTextLink(input, range, url)
              setFormField(field, sanitizeRichTextHtml(input.innerHTML))
            }}
          />
        ),
        () => restoreRichTextSelection(input, range),
      )
      return
    }
    if (action === "bold") document.execCommand("bold")
    if (action === "italic") document.execCommand("italic")
    if (action === "underline") document.execCommand("underline")
    if (action === "bullet_list") document.execCommand("insertUnorderedList")
    if (action === "numbered_list") document.execCommand("insertOrderedList")
    if (input) setFormField(field, sanitizeRichTextHtml(input.innerHTML))
  }

  const answerFor = (index: number): QuestionV2Answer => {
    const q = questions()[index] as QuestionV2Info | undefined
    const type = controlType(q)
    const text = (store.custom[index] ?? "").trim()
    const attachments = questionAttachmentAnswers(index)
    if (q && hasValueBearingBody(q)) {
      return [structuredQuestionAnswer(q, store.answers[index] ?? [], store.body[index] ?? {}, text)!, ...attachments]
    }
    if (textControl(type)) return text ? [text, ...attachments] : attachments
    if (type === "form") return [formAnswer(q?.form, formValues(index)), ...attachments]
    if (type === "slider") return [`value: ${sliderValue(index)}`]
    if (type === "rank") return [`rank: ${rankingValue(index).join(" > ")}`]
    if (type === "rate") return controlOptions(q).map((option) => `${option.label}: ${ratingValue(index, option)}`)
    if (reviewControl(type)) {
      const action = reviewSubmitAction(q, type)
      const answers = action ? [action.label] : (store.answers[index] ?? [])
      return text ? [...answers, `feedback: ${text}`, ...attachments] : [...answers, ...attachments]
    }
    if (type === "show_options" && q?.allowFeedback && text)
      return [...(store.answers[index] ?? []), `feedback: ${text}`, ...attachments]
    return [...(store.answers[index] ?? []), ...attachments]
  }

  const matchingSubmitAction = (form: QuestionFormSpec | undefined, values: Record<string, QuestionFormValue>) =>
    matchingSurfaceActions(form?.actions, "submit", undefined, values).find((action) =>
      action.steps.some((step) => step.type === "gmail" || step.type === "gmx" || step.type === "command" || step.type === "dismiss"),
    )

  const matchingClickAction = (form: QuestionFormSpec | undefined, field: QuestionFormField, values: Record<string, QuestionFormValue>) =>
    matchingSurfaceActions(form?.actions, "click", field.id, values).find((action) =>
      action.steps.some((step) => step.type === "command" || step.type === "dismiss"),
    )

  const matchingChangeAction = (form: QuestionFormSpec | undefined, field: QuestionFormField, values: Record<string, QuestionFormValue>) =>
    matchingSurfaceActions(form?.actions, "change", field.id, values).find((action) => action.steps.some((step) => step.type === "command"))

  const actionHasDismiss = (action: SurfaceAction | undefined) => action?.steps.some((step) => step.type === "dismiss") === true

  const currentSubmitAction = () => {
    const q = question()
    if (!last() || controlType(q) !== "form") return
    return matchingSubmitAction(q?.form, formValues(store.tab))
  }

  const submitFormAction = async (
    form: QuestionFormSpec,
    values: Record<string, QuestionFormValue>,
    action: SurfaceAction,
    closeOnSuccess: boolean,
    source?: string,
  ) => {
    if (submitting || sending()) return
    submitting = true
    const settlesQuestion = !props.actionTarget && (closeOnSuccess || actionHasDismiss(action))
    preserveFormActionOnCleanup = detached() && action.steps.some((step) => step.type === "gmail" || step.type === "gmx")
    const client = sdk().client
    const directory = sdk().directory
    const invocationID = crypto.randomUUID()
    const run = async (signal: AbortSignal) => {
      const response = await appFetch("/app/form-action", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestID: props.request.id,
          revision: props.request.revision,
          invocationID,
          target: props.actionTarget ?? {
            kind: "request",
            id: props.request.id,
            revision: props.request.revision,
          },
          directory,
          formID: form.id,
          values,
          action: { id: action.id, source },
        }),
      })
      if (!response.ok) throw await formActionError(response)
      const data = (await response.json().catch(() => undefined)) as {
        result?: Record<string, unknown>
        gmail?: Record<string, unknown>
        gmx?: { result?: { messageID?: string; accepted?: string[]; rejected?: string[]; archive?: string }; state?: string }
      } | undefined
      if (!disposed) runActionSetValueSteps(action, values, data?.result ?? data?.gmail ?? data?.gmx)
      const gmail = data?.gmail
      const gmx = data?.gmx
      const receipt = gmail
        ? [
            typeof gmail.messageID === "string" ? `ID: ${gmail.messageID}` : undefined,
            typeof gmail.draftID === "string" ? `Entwurf: ${gmail.draftID}` : undefined,
            Array.isArray(gmail.to) ? `An: ${gmail.to.join(", ")}` : undefined,
            typeof gmail.subject === "string" ? `Betreff: ${gmail.subject}` : undefined,
          ].filter(Boolean).join(" · ")
        : gmx ? [
            gmx.result?.messageID ? `ID: ${gmx.result.messageID}` : undefined,
            gmx.result?.accepted?.length ? `Angenommen: ${gmx.result.accepted.join(", ")}` : undefined,
            gmx.result?.rejected?.length ? `Abgelehnt: ${gmx.result.rejected.join(", ")}` : undefined,
            gmx.result?.archive ? `Kopie: ${gmx.result.archive}` : undefined,
          ].filter(Boolean).join(" · ") : undefined
      showToast({
        title: receipt ? `${submitActionTitle(action)} — ${receipt}` : submitActionTitle(action),
        variant: "success",
        persistent: true,
      })
    }
    if (settlesQuestion) {
      const state = {
        started: false,
        committed: false,
        error: undefined as unknown,
        action: undefined as Promise<{ ok: true } | { ok: false; error: unknown }> | undefined,
      }
      setRequestStatus({ type: "idle" })
      ownServerReject(detached() ? undefined : beginQuestionSettlement(props.request.sessionID), {
        beforeSubmit: async (signal) => {
          if (!state.started) {
            state.started = true
            const controller = new AbortController()
            if (signal.aborted) controller.abort(signal.reason)
            signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
            activeFormActionController = controller
            state.action = run(controller.signal).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            void state.action.finally(() => {
              if (activeFormActionController === controller) activeFormActionController = undefined
            })
          }
          if (!state.committed && isSurfaceRequestSettled(props.request)) state.committed = true
          let snapshot: PendingQuestionsSnapshot | undefined
          if (!state.committed) {
            snapshot = await loadPendingQuestions(client, directory)
            reconcilePendingQuestions(snapshot)
            state.committed = !snapshot.pending.some(
              (request) => request.id === props.request.id && request.sessionID === props.request.sessionID,
            )
          }
          if (state.committed) return { settled: "already-settled", snapshot }
          const result = await state.action!
          if (result.ok) {
            state.committed = true
            return
          }
          state.error = result.error
          if (formActionRetry(result.error) === "safe") state.started = false
          throw state.error ?? new Error("Form action settlement could not be confirmed")
        },
        shouldRetry: (error) =>
          isSurfaceRequestSettled(props.request) ||
          (formActionRetry(error) !== "safe" && shouldRetrySurfaceRequest(error)),
      })
      return
    }

    const controller = new AbortController()
    activeFormActionController = controller
    setRequestStatus({ type: "submitting", attempt: 0 })
    try {
      await run(controller.signal)
      submitting = false
      setRequestStatus({ type: "idle" })
      if (props.actionTarget?.kind === "tool" && actionHasDismiss(action)) props.onToolDismiss?.()
    } catch (err) {
      if (disposed) return
      submitting = false
      fail(err)
    } finally {
      if (activeFormActionController === controller) activeFormActionController = undefined
    }
  }

  const submit = () => {
    const q = question()
    if (last() && controlType(q) === "form") {
      const values = formValues(store.tab)
      const action = matchingSubmitAction(q?.form, values)
      if (q?.form && action) {
        void submitFormAction(q.form, values, action, true)
        return
      }
    }

    void reply(questions().map((_, i) => answerFor(i)))
  }

  const answered = (i: number) => {
    const q = questions()[i] as QuestionV2Info | undefined
    const type = controlType(q)
    if (type === "slider" || type === "rank" || type === "rate") return true
    if (type === "form")
      return !!q?.form && q.form.fields.every((field) => !formFieldValidationError(field, formValues(i)[field.id]))
    if (textControl(type)) return (store.custom[i] ?? "").trim().length >= (q?.minLength ?? 1) || questionAttachmentAnswers(i).length > 0
    if ((store.answers[i]?.length ?? 0) > 0) return true
    return store.customOn[i] === true && ((store.custom[i] ?? "").trim().length > 0 || questionAttachmentAnswers(i).length > 0)
  }

  const finalizeRemaining = createMemo(() => {
    if (detached() || !questions().some((_, index) => !answered(index))) return
    return finalizeRemainingOption(controlOptions(question()))
  })

  const submitFinalizeRemaining = () => {
    if (sending()) return
    const option = finalizeRemaining()
    if (!option) return
    finalizeRemainingOverlay(
      questions().map((item, index) => ({
        options: controlOptions(item as QuestionV2Info),
        answered: answered(index),
      })),
    ).forEach((target, index) => {
      if (!target) return
      setStore("answers", index, [target.label])
      setStore("customOn", index, false)
    })
    setStore("editing", false)
    submit()
  }

  const firstInvalidFormTab = () =>
    questions().findIndex((item, index) => controlType(item as QuestionV2Info) === "form" && !answered(index))

  const formAdvanceBlocked = () =>
    controlType(question()) === "form" && !actionHasDismiss(currentSubmitAction()) && !answered(store.tab)

  const submitBlocked = () => last() && !actionHasDismiss(currentSubmitAction()) && firstInvalidFormTab() !== -1

  const rejected = (i: number) => answerFor(i).some((answer) => typeof answer === "string" && dangerAnswer(answer))

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      if (store.fullscreenVideo) return
      event.preventDefault()
      dismiss()
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const nextFromTextInput = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return false
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    event.preventDefault()
    next()
    return true
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()
    if (formAdvanceBlocked()) return

    if (store.tab >= total() - 1) {
      if (!actionHasDismiss(currentSubmitAction())) {
        const invalidFormTab = firstInvalidFormTab()
        if (invalidFormTab !== -1) {
          setStore("tab", invalidFormTab)
          setStore("editing", false)
          focus(pickFocus(invalidFormTab))
          return
        }
      }
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const setTextAnswer = (value: string) => {
    setStore("custom", store.tab, value)
  }

  const setSlider = (value: string) => {
    setStore("sliders", store.tab, Number(value))
  }

  const moveRank = (index: number, step: number) => {
    const list = rankingValue(store.tab)
    const target = index + step
    if (target < 0 || target >= list.length) return
    const next = [...list]
    const item = next[index]
    const other = next[target]
    if (!item || !other) return
    next[index] = other
    next[target] = item
    setStore("rankings", store.tab, next)
  }

  const setRating = (option: QuestionOption, value: string) => {
    const key = optionKey(option)
    setStore("ratings", store.tab, (current = {}) => ({ ...current, [key]: Number(value) }))
  }

  const setReviewFeedback = (value: string) => {
    setStore("custom", store.tab, value)
  }

  const toggleFullscreen = () => {
    setStore("fullscreen", (value) => !value)
    requestAnimationFrame(() => {
      measure()
      revealActiveProgress()
    })
  }

  const collapse = () => {
    setStore("fullscreen", false)
    setStore("collapsed", true)
  }

  const expand = () => {
    setStore("collapsed", false)
    requestAnimationFrame(() => {
      measure()
      revealActiveProgress()
    })
  }

  const currentForm = createMemo(() => (currentType() === "form" ? question()?.form : undefined))
  const formSubmitLabel = createMemo(() =>
    last() && currentType() === "form" ? currentForm()?.submitLabel : undefined,
  )
  const canDockQuestion = createMemo(() => (currentType() === "form" ? props.dock : undefined))
  const headerMenuItems = createMemo(() => [
    { id: "docs", label: "Docs öffnen", onSelect: () => platform.openLink("https://opencode.ai/docs") },
    ...(questionDetails() ? [{ id: "details", label: "Mehr Details", onSelect: showQuestionDetails }] : []),
    {
      id: "fullscreen",
      label: store.fullscreen ? "Vollbild verlassen" : "Im Vollbild öffnen",
      onSelect: toggleFullscreen,
    },
    ...(props.collapsible ? [{ id: "collapse", label: "Nach unten einklappen", onSelect: collapse }] : []),
  ])
  const videoRefs = new Map<string, HTMLVideoElement>()

  const formFieldById = (id: string | undefined) => currentForm()?.fields.find((field) => field.id === id)

  const formDirectMediaSrc = (source: string) => {
    if (/^(https?|data|blob):/i.test(source)) return source
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file://") && !/^[A-Za-z]:[\\/]/.test(source))
      return undefined
  }

  const formMediaRequestPath = (source: string) => {
    if (formDirectMediaSrc(source)) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file://") && !/^[A-Za-z]:[\\/]/.test(source))
      return undefined
    const url = new URL("/app/media", sdk().url)
    url.searchParams.set("path", source)
    url.searchParams.set("directory", sdk().directory)
    return `${url.pathname}${url.search}`
  }

  const MediaSource = (props: {
    source?: string
    fallback: JSX.Element
    children: (src: () => string) => JSX.Element
  }) => {
    const [url, setUrl] = createSignal<string>()
    const source = createMemo(() => props.source?.trim() ?? "")

    createEffect(() => {
      const current = source()
      let objectUrl: string | undefined
      const controller = new AbortController()
      if (!current) {
        setUrl(undefined)
        return
      }
      const direct = formDirectMediaSrc(current)
      if (direct) {
        setUrl(direct)
        return
      }
      const requestPath = formMediaRequestPath(current)
      if (!requestPath) {
        setUrl(undefined)
        return
      }
      setUrl(undefined)
      void appFetch(requestPath, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await responseError(response))
          objectUrl = URL.createObjectURL(await response.blob())
          setUrl(objectUrl)
        })
        .catch(() => {
          if (!controller.signal.aborted) setUrl(undefined)
        })
      onCleanup(() => {
        controller.abort()
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      })
    })

    return (
      <Show when={url()} fallback={props.fallback}>
        {(src) => props.children(src)}
      </Show>
    )
  }

  const bodySelection = (block: QuestionMediaChecklistBlock) =>
    mediaChecklistSelection(block, store.body[store.tab]?.[block.id])

  const toggleBodyItem = (block: QuestionMediaChecklistBlock, item: QuestionMediaItem) => {
    const current = bodySelection(block)
    const selected = current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]
    setStore("body", store.tab, (blocks = {}) => ({ ...blocks, [block.id]: selected }))
  }

  const openBodyMedia = (item: QuestionMediaItem, src: string) => {
    dialog.show(() => (
      <Dialog title={item.label} class="w-[min(96vw,1280px)]">
        <div data-component="question-media-overlay" data-media={item.mediaType} class="flex max-h-[82vh] items-center justify-center overflow-auto bg-black/90 p-4">
          <Show
            when={item.mediaType === "image"}
            fallback={<video src={src} controls autoplay class="max-h-[78vh] max-w-full" aria-label={item.label} />}
          >
            <img src={src} alt={item.label} class="max-h-[78vh] max-w-full object-contain" />
          </Show>
        </div>
      </Dialog>
    ))
  }

  const renderBodyMedia = (item: QuestionMediaItem) => {
    if (item.mediaType === "file") {
      return (
        <div data-slot="question-body-file">
          <Icon name="open-file" size="small" />
          <code>{item.src}</code>
        </div>
      )
    }
    return (
      <MediaSource
        source={item.src}
        fallback={<div data-slot="question-body-media-empty">Vorschau nicht verfügbar</div>}
      >
        {(src) => (
          <>
            <Switch>
              <Match when={item.mediaType === "image"}>
                <img data-slot="question-body-image" src={src()} alt={item.label} loading="lazy" />
              </Match>
              <Match when={item.mediaType === "audio"}>
                <audio data-slot="question-body-audio" src={src()} controls preload="metadata" aria-label={item.label} />
              </Match>
              <Match when={item.mediaType === "video"}>
                <video data-slot="question-body-video" src={src()} controls preload="metadata" aria-label={item.label} />
              </Match>
            </Switch>
            <Show when={item.mediaType === "image" || item.mediaType === "video"}>
              <button
                type="button"
                data-slot="question-body-media-expand"
                aria-label={`${item.label} vergrößert öffnen`}
                onClick={() => openBodyMedia(item, src())}
              >
                Vergrößern
              </button>
            </Show>
          </>
        )}
      </MediaSource>
    )
  }

  const renderQuestionBody = () => (
    <Show when={question()?.body?.length}>
      <section data-slot="question-structured-body">
        <For each={question()?.body ?? []}>
          {(block) => (
            <Switch>
              <Match when={block.type === "markdown" && block}>
                {(markdown) => (
                  <div data-slot="question-body-markdown">
                    <Markdown text={markdown().content} cacheKey={`question:${props.request.id}:${store.tab}:body:${markdown().id}`} />
                  </div>
                )}
              </Match>
              <Match when={block.type === "action_link" && block}>
                {(action) => (
                  <div data-slot="question-body-action">
                    <Button
                      variant="secondary"
                      size="large"
                      disabled={sending() || !safeQuestionActionHref(action().href)}
                      onClick={() => {
                        const href = safeQuestionActionHref(action().href)
                        if (href) platform.openLink(href)
                      }}
                    >
                      {action().label}
                    </Button>
                    <Show when={action().description}>
                      {(description) => <span data-slot="question-body-action-description">{description()}</span>}
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={block.type === "media_checklist" && block}>
                {(checklist) => (
                  <section data-slot="question-media-checklist" aria-label={checklist().label ?? "Medienauswahl"}>
                    <Show when={checklist().label}>
                      {(label) => <div data-slot="question-media-checklist-title">{label()}</div>}
                    </Show>
                    <Show when={checklist().description}>
                      {(description) => <div data-slot="question-media-checklist-description">{description()}</div>}
                    </Show>
                    <div data-slot="question-media-items">
                      <For each={checklist().items}>
                        {(item) => {
                          const inputID = `question-media-${props.request.id}-${store.tab}-${checklist().id}-${item.id}`
                          const checked = () => bodySelection(checklist()).includes(item.id)
                          return (
                            <article data-slot="question-media-item" data-checked={checked()} data-media={item.mediaType}>
                              <div data-slot="question-body-media-preview">{renderBodyMedia(item)}</div>
                              <label data-slot="question-media-item-choice" for={inputID}>
                                <input
                                  id={inputID}
                                  type="checkbox"
                                  checked={checked()}
                                  disabled={sending()}
                                  onChange={() => toggleBodyItem(checklist(), item)}
                                />
                                <span data-slot="question-media-item-copy">
                                  <span data-slot="question-media-item-label">{item.label}</span>
                                  <Show when={item.description}>
                                    {(description) => <span data-slot="question-media-item-description">{description()}</span>}
                                  </Show>
                                </span>
                              </label>
                            </article>
                          )
                        }}
                      </For>
                    </div>
                  </section>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </section>
    </Show>
  )

  const clickFormButton = (form: QuestionFormSpec, field: QuestionFormField) => {
    const values = formValues(store.tab)
    const action = matchingClickAction(form, field, values)
    if (!action) {
      runLocalFormActions(form, "click", field.id, values, undefined)
      return
    }
    void submitFormAction(form, values, action, false, field.id)
  }

  const formMediaSrc = (value: string | undefined) => {
    const source = value?.trim()
    if (!source) return undefined
    return formDirectMediaSrc(source) ?? formMediaRequestPath(source)
  }

  const formatSeconds = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return "0.00s"
    return `${value.toFixed(2)}s`
  }

  const setNumericFormField = (field: QuestionFormField, value: string) => {
    if (!value.trim()) {
      setFormField(field, "")
      return
    }
    const number = Number(value)
    setFormField(field, Number.isFinite(number) ? number : value)
  }

  const setRangeSide = (field: QuestionFormField, side: "start" | "end", value: string | number) => {
    const number = typeof value === "number" ? value : Number(value)
    setFormField(field, {
      ...formValueRange(formValue(field)),
      [side]: Number.isFinite(number) ? Number(number.toFixed(2)) : undefined,
    })
  }

  const setVideoFieldState = (field: QuestionFormField, patch: Partial<{ current: number; duration: number; paused: boolean }>) => {
    const key = formInputKey(field)
    setStore("video", key, (current = { current: 0, duration: 0, paused: true }) => ({ ...current, ...patch }))
  }

  const videoState = (field: QuestionFormField) => store.video[formInputKey(field)] ?? { current: 0, duration: 0, paused: true }

  const setVideoMarker = (field: QuestionFormField, side: "start" | "end") => {
    const current = videoRefs.get(formInputKey(field))?.currentTime ?? videoState(field).current
    runLocalFormActions(currentForm(), side === "start" ? "markStart" : "markEnd", field.id, formValues(store.tab), Number(current.toFixed(2)))
  }

  const seekVideo = (field: QuestionFormField, value: string) => {
    const time = Number(value)
    if (!Number.isFinite(time)) return
    const video = videoRefs.get(formInputKey(field))
    if (video) video.currentTime = time
    setVideoFieldState(field, { current: time })
  }

  const renderTextAreaField = (field: QuestionFormField) => {
    return (
      <>
        <textarea
          data-slot="question-form-input"
          data-kind={field.type}
          rows={formNumber(field.rows, 4)}
          required={field.required}
          minLength={formNumber(field.minLength)}
          maxLength={formNumber(field.maxLength)}
          placeholder={field.placeholder}
          value={formValueString(formValue(field))}
          disabled={sending()}
          onPaste={(event) => void handleQuestionPaste(event, store.tab, field.id)}
          onInput={(event) => setFormField(field, event.currentTarget.value)}
        />
        {renderQuestionAttachments(store.tab, field.id)}
      </>
    )
  }

  const RichTextField = (props: { field: QuestionFormField }) => {
    let input: HTMLDivElement | undefined
    createEffect(() => {
      const value = formValueString(formValue(props.field))
      if (input && input.innerHTML !== value) input.innerHTML = value
    })

    return (
      <>
        <div data-slot="question-form-toolbar">
          <For each={props.field.toolbar?.length ? props.field.toolbar : defaultRichTextToolbar}>
            {(action) => (
              <button
                type="button"
                disabled={sending()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyRichTextAction(props.field, action, input)}
              >
                {richTextActionLabel(action)}
              </button>
            )}
          </For>
        </div>
        <div
          ref={(el) => (input = el)}
          data-slot="question-form-input"
          data-kind="rich_text"
          role="textbox"
          aria-multiline="true"
          tabIndex={0}
          contentEditable={!sending()}
          data-placeholder={props.field.placeholder}
          onInput={(event) => setFormField(props.field, sanitizeRichTextHtml(event.currentTarget.innerHTML))}
          onPaste={(event) => {
            if (event.clipboardData && (clipboardFiles(event.clipboardData).length > 0 || (!event.clipboardData.getData("text/plain") && platform.readClipboardImage))) {
              void handleQuestionPaste(event, store.tab, props.field.id)
              return
            }
            event.preventDefault()
            document.execCommand(
              "insertHTML",
              false,
              richTextInitialHtml(event.clipboardData?.getData("text/plain") ?? ""),
            )
            if (input) setFormField(props.field, sanitizeRichTextHtml(input.innerHTML))
          }}
        />
        {renderQuestionAttachments(store.tab, props.field.id)}
      </>
    )
  }

  const renderListField = (field: QuestionFormField) => {
    let pickerInput: HTMLInputElement | undefined
    const picker = field.type === "file_picker" || field.type === "folder_picker"
    return (
    <div data-slot="question-form-list-field" data-picker={picker || undefined}>
      <div data-slot="question-form-chips">
        <For each={formValueList(formValue(field))}>
          {(item) => (
            <span data-slot="question-form-chip">
              <span>{item}</span>
              <button
                type="button"
                disabled={sending()}
                aria-label={`Remove ${item}`}
                onClick={() => removeFormListValue(field, item)}
              >
                <Icon name="close-small" size="small" />
              </button>
            </span>
          )}
        </For>
      </div>
      <Show when={field.type === "file_picker"}>
        <input
          ref={(el) => {
            pickerInput = el
          }}
          data-slot="question-form-native-picker"
          type="file"
          multiple={field.multiple !== false}
          accept={field.type === "file_picker" ? field.accept : undefined}
          onChange={(event) => {
            addPickedFiles(field, event.currentTarget.files)
            event.currentTarget.value = ""
          }}
        />
      </Show>
      <div data-slot="question-form-list-input-row">
        <input
          data-slot="question-form-input"
          type={field.type === "recipient_list" ? "email" : "text"}
          placeholder={
            field.placeholder ?? (field.type === "recipient_list" ? "name@example.com" : field.type === "folder_picker" ? "C:\\path\\to\\folder" : "C:\\path\\to\\file")
          }
          value={store.formInputs[formInputKey(field)] ?? ""}
          disabled={sending()}
          autocomplete="off"
          aria-autocomplete={field.type === "recipient_list" && field.autocomplete ? "list" : undefined}
          aria-expanded={field.type === "recipient_list" ? formSuggestionState(field).items.length > 0 : undefined}
          aria-controls={field.type === "recipient_list" ? `${formInputKey(field)}:suggestions` : undefined}
          onKeyDown={(event) => handleFormListKeyDown(event, field)}
          onInput={(event) => setFormListInput(field, event.currentTarget.value)}
        />
        <Show when={picker}>
          <button type="button" disabled={sending()} onClick={() => field.type === "folder_picker" ? void browseFolders(field) : pickerInput?.click()}>
            Browse
          </button>
        </Show>
        <button type="button" disabled={sending()} onClick={() => addFormListValue(field)}>
          Add
        </button>
      </div>
      <Show when={field.type === "recipient_list" && formSuggestionState(field).items.length > 0}>
        <div id={`${formInputKey(field)}:suggestions`} data-slot="question-form-suggestions" role="listbox">
          <For each={formSuggestionState(field).items}>
            {(suggestion, index) => (
              <button
                type="button"
                role="option"
                data-slot="question-form-suggestion"
                data-active={index() === formSuggestionState(field).active}
                aria-selected={index() === formSuggestionState(field).active}
                disabled={sending()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseFormSuggestion(field, suggestion)}
              >
                <span data-slot="question-form-suggestion-name">{suggestion.name ?? suggestion.email}</span>
                <Show when={suggestion.name}>
                  <span data-slot="question-form-suggestion-email">{suggestion.email}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={field.accept}>{(accept) => <div data-slot="question-form-help">Accepted: {accept()}</div>}</Show>
    </div>
    )
  }

  const renderRangeField = (field: QuestionFormField) => {
    const range = formValueRange(formValue(field))
    const min = formNumber(field.min, 0) ?? 0
    const max = formNumber(field.max)
    const step = formNumber(field.step, field.type === "duration_range" ? 0.01 : 1)
    const sliderReady = max !== undefined && Number.isFinite(max) && max > min
    return (
      <div data-slot="question-form-range">
        <div data-slot="question-form-range-inputs">
          <label>
            <span>{field.startLabel ?? "Von"}</span>
            <input
              data-slot="question-form-input"
              type="number"
              required={field.required}
              min={formNumber(field.min)}
              max={formNumber(field.max)}
              step={step}
              value={range.start ?? ""}
              disabled={sending()}
              onInput={(event) => setRangeSide(field, "start", event.currentTarget.value)}
            />
          </label>
          <label>
            <span>{field.endLabel ?? "Bis"}</span>
            <input
              data-slot="question-form-input"
              type="number"
              required={field.required}
              min={formNumber(field.min)}
              max={formNumber(field.max)}
              step={step}
              value={range.end ?? ""}
              disabled={sending()}
              onInput={(event) => setRangeSide(field, "end", event.currentTarget.value)}
            />
          </label>
        </div>
        <Show when={sliderReady}>
          <div data-slot="question-form-range-sliders">
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={range.start ?? min}
              disabled={sending()}
              aria-label={`${field.label ?? field.id} start`}
              onInput={(event) => setRangeSide(field, "start", event.currentTarget.value)}
            />
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={range.end ?? max}
              disabled={sending()}
              aria-label={`${field.label ?? field.id} end`}
              onInput={(event) => setRangeSide(field, "end", event.currentTarget.value)}
            />
          </div>
        </Show>
      </div>
    )
  }

  const renderImagePreviewField = (field: QuestionFormField) => (
    <div data-slot="question-form-media-preview" data-media="image">
      <MediaSource
        source={String(surfaceTargetValue(currentForm()?.effects, `ui.${field.id}.src`, formSurfaceContext()) ?? field.src ?? formValueString(formValue(field)))}
        fallback={<div data-slot="question-form-media-empty">No image selected</div>}
      >
        {(src) => <img data-slot="question-form-image" src={src()} alt={field.label ?? "Preview"} loading="lazy" style={surfaceStyle(currentForm()?.effects, field.id, formSurfaceContext())} />}
      </MediaSource>
    </div>
  )

  const renderVideoPreviewField = (field: QuestionFormField) => {
    const state = () => videoState(field)
    const markerEnabled = () =>
      matchingSurfaceActions(currentForm()?.actions, "markStart", field.id, formValues(store.tab)).length > 0 ||
      matchingSurfaceActions(currentForm()?.actions, "markEnd", field.id, formValues(store.tab)).length > 0
    createEffect(() => {
      const video = videoRefs.get(formInputKey(field))
      const next = Number(surfaceTargetValue(currentForm()?.effects, `ui.${field.id}.media.currentTime`, formSurfaceContext()))
      if (video && Number.isFinite(next) && Math.abs(video.currentTime - next) > 0.01) video.currentTime = next
    })
    return (
      <div data-slot="question-form-media-preview" data-media="video">
        <MediaSource
          source={String(surfaceTargetValue(currentForm()?.effects, `ui.${field.id}.src`, formSurfaceContext()) ?? field.src ?? formValueString(formValue(field)))}
          fallback={<div data-slot="question-form-media-empty">No video selected</div>}
        >
          {(src) => (
            <video
              ref={(el) => {
                videoRefs.set(formInputKey(field), el)
              }}
              data-slot="question-form-video"
              controls
              preload="metadata"
              src={src()}
              poster={formMediaSrc(String(surfaceTargetValue(currentForm()?.effects, `ui.${field.id}.poster`, formSurfaceContext()) ?? field.poster ?? ""))}
              style={surfaceStyle(currentForm()?.effects, field.id, formSurfaceContext())}
              onLoadedMetadata={(event) =>
                setVideoFieldState(field, {
                  current: event.currentTarget.currentTime,
                  duration: event.currentTarget.duration,
                  paused: event.currentTarget.paused,
                })
              }
              onTimeUpdate={(event) => setVideoFieldState(field, { current: event.currentTarget.currentTime })}
              onPlay={() => setVideoFieldState(field, { paused: false })}
              onPause={() => setVideoFieldState(field, { paused: true })}
            />
          )}
        </MediaSource>
        <button
          type="button"
          data-slot="question-form-video-fullscreen"
          onClick={(event) => {
            const video = videoRefs.get(formInputKey(field))
            if (!video) return
            setFullscreenVideoTrigger(event.currentTarget)
            setStore("fullscreenVideo", video.currentSrc || video.src)
          }}
        >
          Vollbild öffnen
        </button>
        <div data-slot="question-form-video-controls">
          <span data-slot="question-form-video-time">
            {formatSeconds(state().current)} / {formatSeconds(state().duration)}
          </span>
          <input
            type="range"
            min={0}
            max={state().duration || 0}
            step={0.01}
            value={state().current}
            disabled={sending() || !state().duration}
            aria-label="Video timeline"
            onInput={(event) => seekVideo(field, event.currentTarget.value)}
          />
          <Show when={markerEnabled()}>
            <div data-slot="question-form-marker-actions">
              <button type="button" disabled={sending()} onClick={() => setVideoMarker(field, "start")}>
                Start hier
              </button>
              <button type="button" disabled={sending()} onClick={() => setVideoMarker(field, "end")}>
                Ende hier
              </button>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  const renderFormField = (form: QuestionFormSpec, fieldID: string | undefined): JSX.Element => {
    const field = form.fields.find((item) => item.id === fieldID)
    if (!field || field.type === "hidden") return null
    if (field.type === "display" || field.type === "image_preview" || field.type === "video_preview") {
      const display = () => (field.type === "display" ? displayFieldContent(field) : field.description)
      return (
        <div data-slot="question-form-display" data-field-type={field.type} title={formTooltip(field.tooltip)}>
          <Show when={field.label}>
            {(label) => (
              <div data-slot="question-form-label" title={formTooltip(field.tooltip)}>
                {label()}
              </div>
            )}
          </Show>
          <Show when={field.type === "image_preview"}>{renderImagePreviewField(field)}</Show>
          <Show when={field.type === "video_preview"}>{renderVideoPreviewField(field)}</Show>
          <Show when={display()}>
            {(content) =>
              field.type === "display" ? (
                <div data-slot="question-form-display-content">
                  <Markdown text={content()} cacheKey={`question:${props.request.id}:${store.tab}:display:${field.id}`} />
                </div>
              ) : (
                <div data-slot="question-form-help">{content()}</div>
              )
            }
          </Show>
        </div>
      )
    }
    return (
      <div
        data-slot="question-form-field"
        data-field-type={field.type}
        data-field-layout={formFieldLayout(field)}
        title={formTooltip(field.tooltip)}
      >
        <Show when={field.type !== "button" && field.label}>
          {(label) => (
            <span data-slot="question-form-label" title={formTooltip(field.tooltip)}>
              {label()}
              <Show when={field.required}>
                <span data-slot="question-form-required">*</span>
              </Show>
            </span>
          )}
        </Show>
        <div data-slot="question-form-control">
          <Switch>
            <Match when={formListField(field)}>
              {renderListField(field)}
            </Match>
            <Match when={field.type === "number_range" || field.type === "duration_range"}>{renderRangeField(field)}</Match>
            <Match when={field.type === "textarea"}>{renderTextAreaField(field)}</Match>
            <Match when={field.type === "rich_text"}>{<RichTextField field={field} />}</Match>
            <Match when={field.type === "checkbox"}>
              <input
                data-slot="question-form-checkbox"
                type="checkbox"
                checked={formValue(field) === true}
                disabled={sending()}
                onChange={(event) => setFormField(field, event.currentTarget.checked)}
              />
            </Match>
            <Match when={field.type === "select"}>
              <select
                data-slot="question-form-input"
                required={field.required}
                value={formValueString(formValue(field))}
                disabled={sending()}
                onChange={(event) => setFormField(field, event.currentTarget.value)}
              >
                <For each={field.options ?? []}>
                  {(option) => (
                    <option value={optionKey(option)} title={formTooltip(option.tooltip)}>
                      {option.label}
                    </option>
                  )}
                </For>
              </select>
            </Match>
            <Match when={field.type === "button"}>
              <button
                type="button"
                data-slot="question-form-button"
                disabled={sending()}
                title={formTooltip(field.tooltip)}
                onClick={() => clickFormButton(form, field)}
              >
                {field.label ?? field.id}
              </button>
            </Match>
            <Match when={true}>
              <input
                data-slot="question-form-input"
                type={field.type === "email" ? "email" : field.type === "number" ? "number" : "text"}
                required={field.required}
                min={formNumber(field.min)}
                max={formNumber(field.max)}
                step={formNumber(field.step)}
                minLength={formNumber(field.minLength)}
                maxLength={formNumber(field.maxLength)}
                placeholder={field.placeholder}
                value={formValueString(formValue(field))}
                disabled={sending()}
                onPaste={(event) => {
                  if (formFreeTextField(field)) void handleQuestionPaste(event, store.tab, field.id)
                }}
                onInput={(event) =>
                  field.type === "number"
                    ? setNumericFormField(field, event.currentTarget.value)
                    : setFormField(field, event.currentTarget.value)
                }
              />
              <Show when={formFreeTextField(field)}>{renderQuestionAttachments(store.tab, field.id)}</Show>
            </Match>
          </Switch>
        </div>
        <Show when={field.description || formFieldValidationError(field, formValue(field))}>
          <div data-slot="question-form-messages">
            <Show when={field.description}>
              {(description) => <span data-slot="question-form-help">{description()}</span>}
            </Show>
            <Show when={formFieldValidationError(field, formValue(field))}>
              {(error) => <div data-slot="question-form-error">{error()}</div>}
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  const renderFormNode = (form: QuestionFormSpec, node: QuestionFormLayoutNode): JSX.Element => {
    if (node.when && String(formValues(store.tab)[node.when.field] ?? "") !== node.when.equals) return <></>
    if (node.type === "field") return renderFormField(form, node.field)
    if (isFormExpectation(node)) return <></>
    const embeddedReview = embeddedFormReview(node.text)
    if (node.type === "text" && !embeddedReview && !(node.sections?.length || node.markdown || node.content)) {
      return <div data-slot="question-form-static" title={formTooltip(node.tooltip)}>{node.text}</div>
    }
    if (node.type === "text" || node.type === "review") {
      return (
        <div data-slot="question-form-review" title={formTooltip(node.tooltip)}>
          <Show when={node.title ?? (embeddedReview || isFormExpectationText(node) ? undefined : node.text)}>
            {(title) => (
              <div data-slot="question-form-section-title" title={formTooltip(node.tooltip)}>
                {title()}
              </div>
            )}
          </Show>
          <ExplorableReview
            markdown={embeddedReview?.markdown ?? node.markdown}
            content={embeddedReview?.content ?? node.content}
            sections={embeddedReview?.sections ?? node.sections}
            variant={embeddedReview?.variant ?? node.variant}
            cacheKey={`question:${props.request.id}:${store.tab}:form:${node.id ?? "review"}`}
          />
        </div>
      )
    }
    return (
      <div
        data-slot="question-form-stack"
        data-direction={node.type === "hstack" ? "horizontal" : "vertical"}
        title={formTooltip(node.tooltip)}
        style={formStackStyle(node)}
      >
        <Show when={node.title}>
          {(title) => (
            <div data-slot="question-form-section-title" title={formTooltip(node.tooltip)}>
              {title()}
            </div>
          )}
        </Show>
        <For each={node.children ?? []}>
          {(child) => (
            <Show when={!child.when || String(formValues(store.tab)[child.when.field] ?? "") === child.when.equals}>
              <div data-slot="question-form-node" style={formChildStyle(node, child)}>
                {renderFormNode(form, child)}
              </div>
            </Show>
          )}
        </For>
      </div>
    )
  }

  const renderForm = (form: QuestionFormSpec) => (
    <div data-slot="question-form" title={formTooltip(form.tooltip)}>
      <Show when={form.title}>{(title) => <div data-slot="question-form-title" title={formTooltip(form.tooltip)}>{title()}</div>}</Show>
      <Show when={form.description}>
        {(description) => <div data-slot="question-form-description">{description()}</div>}
      </Show>
      {renderFormNode(form, form.layout ?? defaultFormLayout(form))}
    </div>
  )

  const renderDetailView = (detail: QuestionDetailReview) => (
    <section data-slot="question-detail-panel" data-level={detail.level} data-mode="drilldown">
      <div data-slot="question-detail-panel-header">
        <button type="button" data-slot="question-detail-back" onClick={closeDetails}>
          {language.t("ui.common.back")}
        </button>
        <div data-slot="question-detail-panel-title">{detail.title}</div>
      </div>
      <ExplorableReview
        markdown={detail.markdown}
        content={detail.content}
        sections={detail.sections}
        variant={detail.variant}
        cacheKey={activeDetailCacheKey()}
      />
    </section>
  )

  return (
    <Show
      when={!store.collapsed}
      fallback={
        <div
          data-component="question-collapsed-bar"
          class="flex min-h-11 items-center gap-2 rounded-lg border border-border-weak-base bg-background-stronger px-2 py-1.5"
          role="group"
          aria-label={questionAriaLabel(summary(), expectation())}
        >
          <QuestionDockMenu
            dock={canDockQuestion()}
            items={[
              { id: "docs", label: "Docs öffnen", onSelect: () => platform.openLink("https://opencode.ai/docs") },
              { id: "expand", label: "Surface aufklappen", onSelect: expand },
            ]}
          />
          <div class="min-w-0 flex-1" />
          <div data-slot="question-progress" class="shrink-0" ref={(el) => (progressRef = el)}>
            <For each={questions()}>
              {(_, i) => (
                <button
                  type="button"
                  data-slot="question-progress-segment"
                  data-active={i() === store.tab}
                  data-answered={answered(i())}
                  data-rejected={rejected(i())}
                  disabled={sending()}
                  onClick={() => jump(i())}
                  aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                />
              )}
            </For>
          </div>
          <button
            type="button"
            data-slot="question-expand-toggle"
            aria-label="Surface aufklappen"
            title="Surface aufklappen"
            onClick={expand}
          >
            <Icon name="arrow-up" size="small" />
          </button>
        </div>
      }
    >
      <DockPrompt
      kind="question"
      fullscreen={store.fullscreen}
      fill={props.fill ?? fillAvailableHeight()}
      ref={(el) => (root = el)}
      onKeyDown={nav}
      header={
        <>
          <div data-slot="question-header-main">
            <QuestionDockMenu dock={canDockQuestion()} items={headerMenuItems()} />
            <div data-slot="question-header-title" data-progress-title={!detached()}>
              {summary()}
            </div>
            <div data-slot="question-header-controls">
              <div data-slot="question-progress" ref={(el) => (progressRef = el)}>
                <For each={questions()}>
                  {(_, i) => (
                    <button
                      type="button"
                      data-slot="question-progress-segment"
                      data-active={i() === store.tab}
                      data-answered={answered(i())}
                      data-rejected={rejected(i())}
                      disabled={sending()}
                      onClick={() => jump(i())}
                      aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                    />
                  )}
                </For>
              </div>
              <Show when={props.collapsible}>
                <button
                  type="button"
                  data-slot="question-collapse-toggle"
                  aria-label="Surface nach unten einklappen"
                  title="Surface nach unten einklappen"
                  onClick={collapse}
                >
                  <Icon name="chevron-down" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <Show when={expectation()}>
            {(text) => <OnDemandExpectation text={text()} actionNeeded slot="question-expectation" />}
          </Show>
        </>
      }
      footer={
        <>
          <Button
            variant="ghost"
            size="large"
            disabled={sending()}
            onClick={dismiss}
            aria-keyshortcuts="Escape"
          >
            {language.t("ui.common.dismiss")}
          </Button>
          <div data-slot="question-footer-meta" aria-live="polite">
            <Show when={statusText()}>{(text) => <span data-slot="question-submit-status">{text()}</span>}</Show>
          </div>
          <div data-slot="question-footer-actions">
            <Show when={finalizeRemaining()}>
              {(option) => (
                <Button
                  variant="secondary"
                  size="large"
                  data-slot="question-finalize-remaining"
                  disabled={sending()}
                  onClick={submitFinalizeRemaining}
                  title={option().description}
                >
                  {option().label} · {language.t("session.question.finalizeRemaining")}
                </Button>
              )}
            </Show>
            <Show when={store.tab > 0}>
              <Button variant="secondary" size="large" disabled={sending()} onClick={back}>
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Button
              variant={last() ? "primary" : "secondary"}
              size="large"
              disabled={sending() || formAdvanceBlocked() || submitBlocked()}
              onClick={next}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              {last()
                ? (finalReviewAction()?.label ?? formSubmitLabel() ?? language.t("ui.common.submit"))
                : language.t("ui.common.next")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={activeDetailReview()} fallback={
        <>
          <Show when={implementationCompleteFollowup()}>
            <div data-slot="question-followup-complete-card" role="status">
              <span data-slot="question-followup-complete-icon" aria-hidden="true">
                <Icon name="check-small" size="small" />
              </span>
              <span data-slot="question-followup-complete-copy">
                <span data-slot="question-followup-complete-title">
                  {language.t("session.question.followupComplete.title")}
                </span>
                <span data-slot="question-followup-complete-description">
                  {language.t("session.question.followupComplete.description")}
                </span>
              </span>
            </div>
          </Show>
          <Show when={showQuestionText()}>
            <div data-slot="question-text">
              <Markdown
                text={question()?.question ?? ""}
                cacheKey={`question:${props.request.id}:${store.tab}:prompt`}
              />
            </div>
          </Show>
          <Show when={inlineContext()}>{(context) => <div data-slot="question-context">{context()}</div>}</Show>
          {renderQuestionBody()}
          <Show when={reviewControl(currentType())}>
            <div data-slot="question-review" data-final-plan={!!finalReviewAction()}>
              <Show when={currentType() === "show_diff" ? undefined : question()?.filePath}>
                {(filePath) => <div data-slot="question-review-meta">{filePath()}</div>}
              </Show>
              <Show
                when={currentType() === "show_diff"}
                fallback={
                  <ExplorableReview
                    markdown={question()?.markdown}
                    content={question()?.content}
                    sections={question()?.sections}
                    variant={reviewVariant(currentType())}
                    cacheKey={`question:${props.request.id}:${store.tab}`}
                  />
                }
              >
                <Show when={question()?.markdown ?? question()?.content}>
                  {(content) => <pre data-slot="question-review-content">{content()}</pre>}
                </Show>
                <OnDemandDiff filePath={question()?.filePath} before={question()?.before} after={question()?.after} />
              </Show>
            </div>
          </Show>
          <Switch
            fallback={
              <>
                <Show when={!compactReviewActions() && (choiceControl(currentType()) || reviewControl(currentType()))}>
                  <Show
                    when={multi()}
                    fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}
                  >
                    <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
                  </Show>
                </Show>
                <div
                  data-slot="question-options"
                  data-compact-actions={compactReviewActions()}
                  data-option-count={options().length}
                  role={
                    options().length > 0 &&
                    !finalReviewAction() &&
                    (choiceControl(currentType()) || reviewControl(currentType()))
                      ? multi()
                        ? "group"
                        : "radiogroup"
                      : undefined
                  }
                  aria-label={question()?.question ?? question()?.header ?? "Options"}
                >
                  <Show when={!finalReviewAction()}>
                    <For each={options()}>
                      {(opt, i) => (
                        <Option
                          multi={multi()}
                          picked={picked(opt.label)}
                          compact={compactReviewActions()}
                          label={opt.label}
                          description={opt.description}
                          tooltip={opt.tooltip}
                          pros={opt.pros}
                          cons={opt.cons}
                          details={opt.details}
                          detailsActive={optionDetailsOpen(opt)}
                          disabled={sending()}
                          danger={dangerAnswer(opt.label)}
                          ref={(el) => (optsRef[i()] = el)}
                          onFocus={() => setStore("focus", i())}
                          onClick={() => selectOption(i())}
                          onDetails={() => showOptionDetails(opt)}
                        />
                      )}
                    </For>
                  </Show>

                  <Show when={customAllowed()}>
                    <Show
                      when={store.editing}
                      fallback={
                        <button
                          type="button"
                          ref={customRef}
                          data-slot="question-option"
                          data-custom="true"
                          data-picked={on()}
                          role={multi() ? "checkbox" : "radio"}
                          aria-checked={on()}
                          disabled={sending()}
                          onFocus={() => setStore("focus", options().length)}
                          onClick={customOpen}
                        >
                          <Mark multi={multi()} picked={on()} danger={dangerAnswer(input())} onClick={toggleCustomMark} />
                          <span data-slot="question-option-main">
                            <span data-slot="option-label">{customLabel()}</span>
                            <span data-slot="option-description">{input() || customPlaceholder()}</span>
                          </span>
                        </button>
                      }
                    >
                      <form
                        data-slot="question-option"
                        data-custom="true"
                        data-picked={on()}
                        role={multi() ? "checkbox" : "radio"}
                        aria-checked={on()}
                        onMouseDown={(e) => {
                          if (sending()) {
                            e.preventDefault()
                            return
                          }
                          if (e.target instanceof HTMLTextAreaElement) return
                          const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
                          if (input instanceof HTMLTextAreaElement) input.focus()
                        }}
                        onSubmit={(e) => {
                          e.preventDefault()
                          commitCustom()
                        }}
                      >
                        <Mark multi={multi()} picked={on()} danger={dangerAnswer(input())} onClick={toggleCustomMark} />
                        <span data-slot="question-option-main">
                          <span data-slot="option-label">{customLabel()}</span>
                          <textarea
                            ref={focusCustom}
                            data-slot="question-custom-input"
                            placeholder={customPlaceholder()}
                            value={input()}
                            rows={1}
                            disabled={sending()}
                            onPaste={(e) => void handleQuestionPaste(e, store.tab)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.preventDefault()
                                setStore("editing", false)
                                focus(options().length)
                                return
                              }
                              if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                              if (e.key !== "Enter" || e.shiftKey) return
                              nextFromTextInput(e)
                            }}
                            onInput={(e) => {
                              customUpdate(e.currentTarget.value)
                              resizeInput(e.currentTarget)
                            }}
                          />
                          {renderQuestionAttachments(store.tab)}
                        </span>
                      </form>
                    </Show>
                  </Show>
                  <Show
                    when={(reviewControl(currentType()) || currentType() === "show_options" || hasValueBearingBody(question())) && question()?.allowFeedback}
                  >
                    <textarea
                      data-slot="question-free-input"
                      aria-label="Optional feedback"
                      placeholder={question()?.placeholder ?? "Optional feedback..."}
                      value={input()}
                      rows={3}
                      disabled={sending()}
                      ref={(el) => queueMicrotask(() => resizeInput(el))}
                      onPaste={(e) => void handleQuestionPaste(e, store.tab)}
                      onKeyDown={nextFromTextInput}
                      onInput={(e) => {
                        setReviewFeedback(e.currentTarget.value)
                        resizeInput(e.currentTarget)
                      }}
                    />
                    {renderQuestionAttachments(store.tab)}
                  </Show>
                </div>
              </>
            }
          >
            <Match when={textControl(currentType())}>
              <div data-slot="question-options">
                <textarea
                  data-slot="question-free-input"
                  data-kind={currentType()}
                  placeholder={question()?.placeholder ?? customPlaceholder()}
                  value={input()}
                  rows={currentType() === "ask_code" ? 8 : 4}
                  disabled={sending()}
                  onPaste={(e) => {
                    if (currentType() !== "ask_code") void handleQuestionPaste(e, store.tab)
                  }}
                  onKeyDown={(e) => {
                    if (currentType() !== "ask_code") nextFromTextInput(e)
                  }}
                  onInput={(e) => setTextAnswer(e.currentTarget.value)}
                />
                <Show when={currentType() !== "ask_code"}>{renderQuestionAttachments(store.tab)}</Show>
              </div>
            </Match>
            <Match when={currentForm()}>{(form) => renderForm(form())}</Match>
            <Match when={currentType() === "slider"}>
              <div data-slot="question-options">
                <label data-slot="question-range">
                  <input
                    type="range"
                    min={question()?.min ?? 0}
                    max={question()?.max ?? 100}
                    step={question()?.step ?? 1}
                    value={sliderValue(store.tab)}
                    disabled={sending()}
                    onInput={(e) => setSlider(e.currentTarget.value)}
                  />
                  <span data-slot="question-range-value">{sliderValue(store.tab)}</span>
                </label>
              </div>
            </Match>
            <Match when={currentType() === "rank"}>
              <div data-slot="question-options">
                <For each={rankingValue(store.tab)}>
                  {(label, i) => (
                    <div data-slot="question-rank-item">
                      <span data-slot="question-rank-number">{i() + 1}</span>
                      <span data-slot="option-label">{label}</span>
                      <span data-slot="question-rank-actions">
                        <button type="button" disabled={sending() || i() === 0} onClick={() => moveRank(i(), -1)}>
                          Up
                        </button>
                        <button
                          type="button"
                          disabled={sending() || i() === rankingValue(store.tab).length - 1}
                          onClick={() => moveRank(i(), 1)}
                        >
                          Down
                        </button>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Match>
            <Match when={currentType() === "rate"}>
              <div data-slot="question-options">
                <For each={options()}>
                  {(opt) => (
                    <label data-slot="question-rate-item">
                      <span data-slot="option-label">{opt.label}</span>
                      <input
                        type="range"
                        min={question()?.min ?? 1}
                        max={question()?.max ?? 5}
                        step={question()?.step ?? 1}
                        value={ratingValue(store.tab, opt)}
                        disabled={sending()}
                        onInput={(e) => setRating(opt, e.currentTarget.value)}
                      />
                      <span data-slot="question-range-value">{ratingValue(store.tab, opt)}</span>
                    </label>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </>
      }>
        {(detail) => renderDetailView(detail())}
      </Show>
      </DockPrompt>
      <Show when={store.fullscreenVideo}>
        {(src) => (
          <Portal mount={document.body}>
            <div
              ref={(element) => {
                setFullscreenVideoDialog(element)
                requestAnimationFrame(() => element.focus())
              }}
              data-slot="question-video-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label="Video im Vollbild"
              tabindex="-1"
              style={{
                position: "fixed",
                inset: "0",
                "z-index": "10000",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                background: "rgba(0, 0, 0, 0.96)",
              }}
            >
              <button
                type="button"
                data-slot="question-video-fullscreen-close"
                aria-label="Vollbild schließen"
                style={{
                  position: "absolute",
                  top: "1rem",
                  right: fullscreenCloseButtonRight({
                    windowsDesktop: platform.platform === "desktop" && platform.os === "windows",
                    zoom: platform.webviewZoom?.() ?? 1,
                  }),
                  "z-index": "1",
                }}
                onClick={closeFullscreenVideo}
              >
                Schließen
              </button>
              <video
                data-slot="question-video-fullscreen-player"
                src={src()}
                controls
                autoplay
                playsinline
                style={{ width: "100vw", height: "100vh", "object-fit": "contain" }}
              />
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  )
}
