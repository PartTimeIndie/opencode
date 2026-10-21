export * as QuestionV2 from "./question"

import { and, asc, desc, eq, inArray, isNull, lt, lte, max, or, sql } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "./event"
import { Identifier } from "./id/id"
import { SessionFailure } from "./session/failure"
import { NonNegativeInt, withStatics } from "./schema"
import { SessionSchema } from "./session/schema"
import { Control } from "./control"
import { ControlSurface } from "./control-surface"
import { Database } from "./database/database"
import { Location } from "./location"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "./session/sql"
import { QuestionTable } from "./question/sql"
import { SurfaceActionInvocationTable, SurfaceToolTable } from "./surface-tool.sql"
import { QuestionTransaction } from "./question/transaction"
import { QuestionWakeup } from "./question/wakeup"

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionV2.ID"),
  withStatics((schema) => ({ ascending: (id?: string) => schema.make(Identifier.ascending("question", id)) })),
)
export type ID = typeof ID.Type

export const Option = Schema.Struct({
  id: Schema.String.pipe(Schema.optional).annotate({ description: "Stable option identifier" }),
  label: Schema.String.annotate({ description: "Display text (1-5 words, concise)" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Explanation of choice" }),
  pros: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Advantages for structured option review" }),
  cons: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Disadvantages for structured option review" }),
  details: Schema.Unknown.pipe(Schema.optional).annotate({ description: "Additional structured-review details" }),
  finalizeRemaining: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Offer this option as a request-wide footer button that answers every remaining open question with it and submits immediately",
  }),
}).annotate({ identifier: "QuestionV2.Option" })
export type Option = typeof Option.Type

export interface Section {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly children?: ReadonlyArray<Section>
  readonly meta?: unknown
}
export const Section: Schema.Codec<Section> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Section> => Section)).pipe(Schema.optional).annotate({
    description: "Nested sections enabling tree/accordion drill-down exploration",
  }),
  meta: Schema.Unknown.pipe(Schema.optional).annotate({
    description: "Generic structured payload, e.g. table { columns: string[], rows: string[][] }",
  }),
}).annotate({ identifier: "QuestionV2.Section" })

export const Phase = Schema.Literal("implementation_complete_followup").annotate({
  identifier: "QuestionV2.Phase",
  description:
    'The only valid phase is "implementation_complete_followup". Omit phase for planning, clarification, review, and ordinary blocking questions.',
})
export type Phase = typeof Phase.Type

export const Mode = Schema.Literals(["blocking", "interactive", "passive"]).annotate({ identifier: "Surface.Mode" })
export type Mode = typeof Mode.Type

export const ActionPermission = Schema.Struct({
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "Surface.ActionPermission" })
export type ActionPermission = typeof ActionPermission.Type

export const ActionMetadata = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  permissions: Schema.Array(ActionPermission),
}).annotate({ identifier: "Surface.ActionMetadata" })
export type ActionMetadata = typeof ActionMetadata.Type

const sharedBase = {
  type: Control.Type.pipe(Schema.optional).annotate({ description: "Question control type" }),
  question: Schema.String.annotate({ description: "Short plain-text prompt" }),
  header: Schema.String.pipe(Schema.optional).annotate({ description: "Very short label (max 30 chars)" }),
  showExpectation: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Render the host-owned expectation line (default: true)",
  }),
  body: Schema.Array(Control.BodyBlock).pipe(Schema.optional).annotate({
    description: "Structured visible content rendered before the answer controls",
  }),
  options: Schema.Array(Option).pipe(Schema.optional).annotate({ description: "Available choices" }),
  recommended: Schema.String.pipe(Schema.optional).annotate({ description: "Recommended option id or label" }),
  recommendedOptions: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Recommended option ids or labels",
  }),
  multiple: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Allow selecting multiple choices" }),
  allowOther: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Allow typing a custom answer" }),
  allowFeedback: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Allow free-text feedback" }),
  min: Schema.Number.pipe(Schema.optional).annotate({ description: "Minimum count or numeric value" }),
  max: Schema.Number.pipe(Schema.optional).annotate({ description: "Maximum count or numeric value" }),
  step: Schema.Number.pipe(Schema.optional).annotate({ description: "Numeric step size" }),
  defaultValue: Schema.Number.pipe(Schema.optional).annotate({ description: "Default numeric value" }),
  minLength: Schema.Number.pipe(Schema.optional).annotate({ description: "Minimum free-text length" }),
  maxLength: Schema.Number.pipe(Schema.optional).annotate({ description: "Maximum free-text length" }),
  placeholder: Schema.String.pipe(Schema.optional).annotate({ description: "Free-text placeholder" }),
  language: Schema.String.pipe(Schema.optional).annotate({ description: "Code input language hint" }),
  sections: Schema.Array(Section).pipe(Schema.optional).annotate({ description: "Plan or document sections for review" }),
  before: Schema.String.pipe(Schema.optional).annotate({ description: "Original content for diff review" }),
  after: Schema.String.pipe(Schema.optional).annotate({ description: "Modified content for diff review" }),
  filePath: Schema.String.pipe(Schema.optional).annotate({ description: "File path for diff/code context" }),
  emojis: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Emoji reaction options" }),
  form: Control.FormDefinition.pipe(Schema.optional).annotate({
    description: "Versioned form spec for stack-based multi-field input UIs",
  }),
}

const legacyVisibleContent = {
  context: Schema.String.pipe(Schema.optional).annotate({ description: "Legacy persisted context" }),
  content: Schema.String.pipe(Schema.optional).annotate({ description: "Legacy persisted review content" }),
  markdown: Schema.String.pipe(Schema.optional).annotate({ description: "Legacy persisted markdown document" }),
}

const base = { ...sharedBase, ...legacyVisibleContent }

export const AuthoringInfo = Schema.Struct({
  ...sharedBase,
  custom: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionV2.AuthoringInfo" })
export type AuthoringInfo = typeof AuthoringInfo.Type

export const Info = Schema.Struct({
  ...base,
  custom: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionV2.Info" })
export type Info = typeof Info.Type

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionV2.Prompt" })
export type Prompt = typeof Prompt.Type

export const ToolInput = Schema.Struct({
  questions: Schema.Array(AuthoringInfo).annotate({ description: "Questions to ask" }),
  phase: Phase.pipe(Schema.optional).annotate({
    description:
      'Set to "implementation_complete_followup" only after implementation is complete and these questions are optional follow-ups',
  }),
}).annotate({ identifier: "QuestionV2.ToolInput" })
export type ToolInput = typeof ToolInput.Type

export const Tool = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  confirmationToken: Schema.String.pipe(Schema.optional),
  purpose: Schema.Literal("daily_review_implementation").pipe(Schema.optional),
  authorizationScope: Schema.Literal("accepted-items-in-plan-snapshot").pipe(Schema.optional),
  planDocument: Schema.Struct({
    revision: NonNegativeInt,
    updatedAt: Schema.Finite,
    // Optional while reading legacy handoff requests. New Daily Review
    // handoffs always write both fields and implementation rejects omissions.
    sha256: Schema.String.pipe(Schema.optional),
    markdown: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  messageID: Schema.String,
  callID: Schema.String,
}).annotate({ identifier: "QuestionV2.Tool" })
export type Tool = typeof Tool.Type

const request = {
  id: ID,
  sessionID: SessionSchema.ID,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  actions: Schema.Array(ActionMetadata),
  tool: Tool.pipe(Schema.optional),
}

export const BlockingRequest = Schema.Struct({
  ...request,
  mode: Schema.Literal("blocking"),
  questions: Schema.Array(Info).annotate({ description: "Questions to ask" }),
  phase: Phase.pipe(Schema.optional).annotate({
    description: "Presentation phase for the request, such as optional post-implementation follow-up questions",
  }),
  detached: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Legacy non-blocking Question request retained for durable read compatibility",
  }),
}).annotate({ identifier: "Surface.BlockingRequest" })
export type BlockingRequest = typeof BlockingRequest.Type

export const ControlRequest = Schema.Struct({
  ...request,
  mode: Schema.Literals(["interactive", "passive"]),
  surface: Control.PartData,
}).annotate({ identifier: "Surface.ControlRequest" })
export type ControlRequest = typeof ControlRequest.Type

export const Request = Schema.Union([BlockingRequest, ControlRequest]).annotate({ identifier: "Surface.Request" })
export type Request = typeof Request.Type

export const PersistentToolID = Schema.String.check(Schema.isStartsWith("sft")).pipe(
  Schema.brand("Surface.PersistentToolID"),
  withStatics((schema) => ({ ascending: (id?: string) => schema.make(Identifier.ascending("surfaceTool", id)) })),
)
export type PersistentToolID = typeof PersistentToolID.Type

export const PersistentToolScope = Schema.Literals(["project", "global"]).annotate({
  identifier: "Surface.PersistentToolScope",
})
export type PersistentToolScope = typeof PersistentToolScope.Type

export const PersistentToolState = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  values: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Surface.PersistentToolState" })
export type PersistentToolState = typeof PersistentToolState.Type

export const PersistentTool = Schema.Struct({
  id: PersistentToolID,
  scope: PersistentToolScope,
  projectID: Schema.String.pipe(Schema.optional),
  directory: Schema.String,
  origin: Schema.Struct({
    requestID: ID,
    sessionID: SessionSchema.ID,
    revision: Schema.Int,
  }).pipe(Schema.optional),
  mode: Schema.Literals(["interactive", "passive"]),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  actions: Schema.Array(ActionMetadata),
  surface: Control.PartData,
  state: PersistentToolState,
  hidden: Schema.Boolean,
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "Surface.PersistentTool" })
export type PersistentTool = typeof PersistentTool.Type

export const ActionInvocation = Schema.Struct({
  id: Schema.String,
  target: Schema.Struct({
    kind: Schema.Literals(["request", "tool"]),
    id: Schema.String,
    revision: Schema.Int,
  }),
  actionID: Schema.String,
  source: Schema.String.pipe(Schema.optional),
  state: Schema.Literals(["pending", "completed", "failed"]),
  result: Schema.Unknown.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
  executionKey: Schema.String.pipe(Schema.optional).annotate({
    description: "Set once the non-idempotent effect slot for this intent has been claimed",
  }),
  effectStartedAt: Schema.Int.pipe(Schema.optional).annotate({
    description: "Point of no return: the host side effect may have started at this time",
  }),
  errorClass: Schema.Literals(["preflight", "unknown"]).pipe(Schema.optional).annotate({
    description: "preflight failures are safe to correct and retry; unknown means the outcome cannot be proven",
  }),
  payloadHash: Schema.String.pipe(Schema.optional).annotate({
    description: "Canonical hash of the invocation payload without the transport invocation id",
  }),
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "Surface.ActionInvocation" })
export type ActionInvocation = typeof ActionInvocation.Type

export const AnswerFile = Schema.Struct({
  type: Schema.Literal("file"),
  mime: Schema.String,
  url: Schema.String.check(Schema.isStartsWith("file://")),
  filename: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "QuestionV2.AnswerFile" })
export type AnswerFile = typeof AnswerFile.Type

export const AnswerItem = Schema.Union([Schema.String, AnswerFile]).annotate({ identifier: "QuestionV2.AnswerItem" })
export type AnswerItem = typeof AnswerItem.Type

export const Answer = Schema.Array(AnswerItem).annotate({ identifier: "QuestionV2.Answer" })
export type Answer = typeof Answer.Type

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionV2.Reply" })
export type Reply = typeof Reply.Type

const Requested = EventV2.define({
  type: "surface.asked",
  schema: {
    id: ID,
    sessionID: SessionSchema.ID,
    mode: Mode,
    revision: Schema.Int,
    actions: Schema.Array(ActionMetadata),
    tool: Tool.pipe(Schema.optional),
    questions: Schema.Array(Info).pipe(Schema.optional),
    phase: Phase.pipe(Schema.optional),
    detached: Schema.Boolean.pipe(Schema.optional),
    surface: Control.PartData.pipe(Schema.optional),
  },
})

export const Event = {
  Requested,
  Replied: EventV2.define({
    type: "surface.replied",
    schema: {
      sessionID: SessionSchema.ID,
      requestID: ID,
      answers: Schema.Array(Answer),
    },
  }),
  Dismissed: EventV2.define({
    type: "surface.dismissed",
    schema: {
      sessionID: SessionSchema.ID,
      requestID: ID,
    },
  }),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {
  override get message() {
    return `Surface request not found: ${this.requestID}`
  }
}

export class PersistentToolNotFoundError extends Schema.TaggedErrorClass<PersistentToolNotFoundError>()(
  "Surface.PersistentToolNotFoundError",
  { toolID: PersistentToolID },
) {
  override get message() {
    return `Persistent Surface tool not found: ${this.toolID}`
  }
}

export class ActionInvocationNotFoundError extends Schema.TaggedErrorClass<ActionInvocationNotFoundError>()(
  "Surface.ActionInvocationNotFoundError",
  { invocationID: Schema.String },
) {
  override get message() {
    return `Surface action invocation not found: ${this.invocationID}`
  }
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("QuestionV2.ConflictError", {
  requestID: ID,
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

const toolInputKeys = new Set(["questions", "phase"])
const questionKeys = new Set([...Object.keys(sharedBase), "custom"])
const optionKeys = new Set(["id", "label", "description", "tooltip", "pros", "cons", "details", "finalizeRemaining"])
const bodyKeys = {
  markdown: new Set(["id", "type", "content"]),
  action_link: new Set(["id", "type", "label", "href", "description"]),
  media_checklist: new Set(["id", "type", "label", "description", "items"]),
}
const mediaItemKeys = new Set(["id", "label", "mediaType", "src", "description", "defaultChecked"])
const stableID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const manualExpectation = /^\s*Erwartet:\s*/im
// Choice controls without host-rendered defaults. `confirm`, `thumbs`, and the review controls
// fall back to host-owned buttons when no options are authored; these controls render an empty
// answer area and can never be settled by the user.
const choiceControlsRequiringOptions = new Set(["pick_one", "pick_many", "show_options"])

export function validateToolInput(input: unknown) {
  if (!isRecord(input)) return "Expected a JSON object."
  const root = unknownField(input, toolInputKeys, "")
  if (root) return root
  if (!Array.isArray(input.questions)) return 'Invalid field ["questions"]. Expected an array.'

  for (const [questionIndex, question] of input.questions.entries()) {
    if (!isRecord(question)) return `Invalid question at ["questions"][${questionIndex}]. Expected an object.`
    const questionPath = `["questions"][${questionIndex}]`
    const questionField = unknownField(question, questionKeys, questionPath)
    if (questionField) return questionField
    if (typeof question.question !== "string" || !question.question.trim())
      return `Invalid field ${questionPath}["question"]. A non-empty plain-text prompt is required.`
    const answerable = answerabilityDiagnostic(question, questionPath)
    if (answerable) return answerable
    if (question.form) {
      const diagnostic = ControlSurface.validateFormDefinition(question.form)[0]
      if (diagnostic) return `${diagnostic.code} at ${questionPath}.${diagnostic.path}: ${diagnostic.message}`
    }
    const bodyError = validateBody(question.body, `${questionPath}["body"]`)
    if (bodyError) return bodyError
    if (hasValueBody(question.body)) {
      if (!Array.isArray(question.options) || question.options.length === 0)
        return `Invalid field ${questionPath}["options"]. A value-bearing body requires answer options with stable ids.`
      const ids = question.options.map((option) => (isRecord(option) ? option.id : undefined))
      const invalid = ids.findIndex((id) => typeof id !== "string" || !stableID.test(id))
      if (invalid !== -1)
        return `Invalid field ${questionPath}["options"][${invalid}]["id"]. Value-bearing questions require a stable option id.`
      if (new Set(ids).size !== ids.length)
        return `Invalid field ${questionPath}["options"]. Option ids must be unique for structured answers.`
      const labels = question.options.map((option) => (isRecord(option) ? option.label : undefined))
      if (new Set(labels).size !== labels.length)
        return `Invalid field ${questionPath}["options"]. Option labels must be unique because the UI maps selections to stable ids.`
    }
    if (!Array.isArray(question.options)) continue

    for (const [optionIndex, option] of question.options.entries()) {
      const optionPath = `${questionPath}["options"][${optionIndex}]`
      if (!isRecord(option)) return `Invalid option at ${optionPath}. Use an object like { "label": "Yes" }, not a string or primitive.`
      const optionField = unknownField(option, optionKeys, optionPath)
      if (optionField) return optionField
      if (typeof option.label !== "string" || !option.label.trim()) return `Invalid field ${optionPath}["label"]. A non-empty label is required.`
    }
  }
}

export function decodeAuthoringInfo(input: unknown) {
  const error = validateToolInput({ questions: [input] })
  if (error) throw new Error(error)
  return Schema.decodeUnknownSync(AuthoringInfo)(input)
}

// Rejects blocking questions that render an empty answer area. Choice controls without
// host-rendered defaults need explicit options (or emojis for emoji_react); without them the
// popup can never be settled and the turn loops through rejected questions.
export function answerabilityDiagnostic(question: unknown, questionPath: string) {
  if (!isRecord(question)) return
  // The persisted/UI contract defaults an omitted type to pick_one. Validate that
  // effective control type here too, otherwise an empty legacy-shaped question
  // reaches the renderer with no answer control at all.
  const type = question.type ?? "pick_one"
  if (typeof type !== "string") return
  if (type === "emoji_react") {
    const emojis = Array.isArray(question.emojis) ? question.emojis.length : 0
    const options = Array.isArray(question.options) ? question.options.length : 0
    if (emojis === 0 && options === 0)
      return `Invalid field ${questionPath}["emojis"]. An emoji_react question requires "emojis" or "options" to react to.`
    return
  }
  if (!choiceControlsRequiringOptions.has(type)) return
  const selectable = selectableOptions(question)
  if (selectable.length === 0)
    return `Invalid field ${questionPath}["options"]. A "${type}" question requires a non-empty options array such as [{ "label": "Yes" }, { "label": "No" }]; the host renders no defaults for it. Use a control with host-owned buttons (confirm, thumbs, review_section) or ask_text for free text instead.`
}

// Footer finalize buttons (finalizeRemaining) render outside the option list, so they
// cannot satisfy the selectable option requirement of choice controls.
function selectableOptions(question: Record<string, unknown>) {
  const options = Array.isArray(question.options) ? question.options : []
  return options.filter((option) => !isRecord(option) || option.finalizeRemaining !== true)
}

export const decodePersistedInfo = Schema.decodeUnknownSync(Info)

function validateBody(input: unknown, path: string) {
  if (input === undefined) return
  if (!Array.isArray(input)) return `Invalid field ${path}. Expected an array of body blocks.`
  if (input.length === 0) return `Invalid field ${path}. Body must contain at least one block.`
  const ids = new Set<string>()
  for (const [index, block] of input.entries()) {
    const blockPath = `${path}[${index}]`
    if (!isRecord(block)) return `Invalid body block at ${blockPath}. Expected an object.`
    if (block.type !== "markdown" && block.type !== "action_link" && block.type !== "media_checklist")
      return `Invalid field ${blockPath}["type"]. Expected markdown, action_link, or media_checklist.`
    const field = unknownField(block, bodyKeys[block.type], blockPath)
    if (field) return field
    if (typeof block.id !== "string" || !stableID.test(block.id))
      return `Invalid field ${blockPath}["id"]. A stable non-empty block id is required.`
    if (ids.has(block.id)) return `Invalid field ${blockPath}["id"]. Body block ids must be unique.`
    ids.add(block.id)
    if (block.type === "markdown") {
      if (typeof block.content !== "string" || !block.content.trim())
        return `Invalid field ${blockPath}["content"]. Markdown content must not be empty.`
      if (manualExpectation.test(block.content))
        return `Invalid field ${blockPath}["content"]. The expectation line is host-owned and must not be authored in Markdown.`
      continue
    }
    if (block.type === "action_link") {
      if (typeof block.label !== "string" || !block.label.trim())
        return `Invalid field ${blockPath}["label"]. Action label must not be empty.`
      if (typeof block.href !== "string" || !allowedActionHref(block.href))
        return `Invalid field ${blockPath}["href"]. Only http:, https:, and obsidian: links are allowed.`
      continue
    }
    if (!Array.isArray(block.items) || block.items.length === 0)
      return `Invalid field ${blockPath}["items"]. A media checklist needs at least one item.`
    const itemIDs = new Set<string>()
    for (const [itemIndex, item] of block.items.entries()) {
      const itemPath = `${blockPath}["items"][${itemIndex}]`
      if (!isRecord(item)) return `Invalid media item at ${itemPath}. Expected an object.`
      const itemField = unknownField(item, mediaItemKeys, itemPath)
      if (itemField) return itemField
      if (typeof item.id !== "string" || !stableID.test(item.id))
        return `Invalid field ${itemPath}["id"]. A stable non-empty media item id is required.`
      if (itemIDs.has(item.id)) return `Invalid field ${itemPath}["id"]. Media item ids must be unique within their block.`
      itemIDs.add(item.id)
      if (typeof item.label !== "string" || !item.label.trim())
        return `Invalid field ${itemPath}["label"]. Media item label must not be empty.`
      if (!(["image", "audio", "video", "file"] as unknown[]).includes(item.mediaType))
        return `Invalid field ${itemPath}["mediaType"]. Expected image, audio, video, or file.`
      if (typeof item.src !== "string" || !allowedMediaSource(item.src))
        return `Invalid field ${itemPath}["src"]. Media source must be a non-empty safe URL or local path.`
      if (item.defaultChecked !== undefined && typeof item.defaultChecked !== "boolean")
        return `Invalid field ${itemPath}["defaultChecked"]. Expected a boolean.`
    }
  }
}

function hasValueBody(input: unknown) {
  return Array.isArray(input) && input.some((block) => isRecord(block) && block.type === "media_checklist")
}

function allowedActionHref(value: string) {
  try {
    return ["http:", "https:", "obsidian:"].includes(new URL(value.trim()).protocol)
  } catch {
    return false
  }
}

function allowedMediaSource(value: string) {
  const source = value.trim()
  if (!source) return false
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) return true
  try {
    return ["http:", "https:", "file:", "data:", "blob:"].includes(new URL(source).protocol)
  } catch {
    return !/^[a-z][a-z0-9+.-]*:/i.test(source)
  }
}

function unknownField(input: Record<string, unknown>, allowed: Set<string>, path: string) {
  const key = Object.keys(input).find((key) => !allowed.has(key))
  if (!key) return
  const location = `${path}[${JSON.stringify(key)}]`
  if (key === "choices") return `Unexpected field ${location}. Use "options": [{ "label": "..." }] instead; "choices" is not part of the question schema.`
  if (key === "actions")
    return `Unexpected field ${location}. Blocking questions cannot declare actions. Put explicit form events in "form.actions" or use an interactive Control surface.`
  if (key === "context" || key === "content" || key === "markdown")
    return `Unexpected field ${location}. "${key}" is legacy persisted content and is not accepted for authoring. Put structured visible copy in "body" blocks.`
  return `Unexpected field ${location}. Allowed fields: ${Array.from(allowed).sort().join(", ")}.`
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly phase?: Phase
  readonly tool?: Tool
  readonly allowConcurrent?: boolean
}

export interface PresentInput {
  readonly sessionID: SessionSchema.ID
  readonly mode: "interactive" | "passive"
  readonly surface: Control.PartData
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly sessionID?: SessionSchema.ID
  readonly answers: ReadonlyArray<Answer>
}

export interface SettlementTarget {
  readonly detached: boolean
  readonly activityID?: string
}

export interface CreatePersistentToolInput {
  readonly requestID: ID
  readonly sessionID: SessionSchema.ID
  readonly expectedRevision: number
  readonly scope: PersistentToolScope
}

export interface UpdatePersistentToolStateInput {
  readonly toolID: PersistentToolID
  readonly expectedRevision: number
  readonly values: Readonly<Record<string, unknown>>
}

export interface BeginActionInvocationInput {
  readonly id: string
  readonly target: ActionInvocation["target"]
  readonly actionID: string
  readonly source?: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface BeginActionEffectInput {
  readonly invocationID: string
  readonly executionKey: string
}

export interface ActionInvocationClaim {
  readonly invocation: ActionInvocation
  readonly claimed: boolean
}

export interface SessionActionInvocation {
  readonly invocation: ActionInvocation
  readonly request?: Request
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError | ConflictError>
  readonly askDurable: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError | ConflictError>
  readonly askDetached: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError | ConflictError>
  readonly open: (input: AskInput) => Effect.Effect<Request, ConflictError>
  readonly present: (input: PresentInput) => Effect.Effect<ControlRequest, ConflictError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly reject: (requestID: ID, sessionID?: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError | ConflictError>
  readonly dismissSession: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly dismissFollowups: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly settlementTarget: (
    requestID: ID,
    sessionID?: SessionSchema.ID,
  ) => Effect.Effect<SettlementTarget | undefined>
  readonly get: (requestID: ID, sessionID?: SessionSchema.ID) => Effect.Effect<Request | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly createPersistentTool: (
    input: CreatePersistentToolInput,
  ) => Effect.Effect<PersistentTool, NotFoundError | ConflictError>
  readonly listPersistentTools: (includeHidden?: boolean) => Effect.Effect<ReadonlyArray<PersistentTool>>
  readonly updatePersistentToolState: (
    input: UpdatePersistentToolStateInput,
  ) => Effect.Effect<PersistentTool, PersistentToolNotFoundError | ConflictError>
  readonly setPersistentToolHidden: (
    toolID: PersistentToolID,
    hidden: boolean,
  ) => Effect.Effect<PersistentTool, PersistentToolNotFoundError>
  readonly removePersistentTool: (toolID: PersistentToolID) => Effect.Effect<void, PersistentToolNotFoundError>
  readonly beginActionInvocation: (
    input: BeginActionInvocationInput,
  ) => Effect.Effect<ActionInvocationClaim, ActionInvocationNotFoundError | ConflictError>
  readonly beginActionEffect: (
    input: BeginActionEffectInput,
  ) => Effect.Effect<ActionInvocationClaim, ActionInvocationNotFoundError | ConflictError>
  readonly completeActionInvocation: (
    id: string,
    result?: unknown,
  ) => Effect.Effect<ActionInvocation, ActionInvocationNotFoundError>
  readonly getActionInvocation: (id: string) => Effect.Effect<ActionInvocation, ActionInvocationNotFoundError>
  readonly failActionInvocation: (
    id: string,
    error: string,
    errorClass?: "preflight" | "unknown",
  ) => Effect.Effect<ActionInvocation, ActionInvocationNotFoundError>
  readonly actionInvocations: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionActionInvocation>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

type DatabaseService = Database.Interface["db"]
type Transaction = Parameters<Parameters<DatabaseService["transaction"]>[0]>[0]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const locationOption = yield* Effect.serviceOption(Location.Service)
    const location = locationOption._tag === "Some" ? locationOption.value : undefined

    const inLocation = () =>
      location
        ? and(
            process.platform === "win32"
              ? sql`lower(replace(${SessionTable.directory}, char(92), '/')) = ${location.directory.replaceAll("\\", "/").toLowerCase()}`
              : eq(SessionTable.directory, location.directory),
            location.workspaceID ? eq(SessionTable.workspace_id, location.workspaceID) : isNull(SessionTable.workspace_id),
          )
        : undefined

    const publish = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
      events.publish(definition, data, { isolateListeners: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("QuestionV2: lifecycle event delivery failed after durable commit", {
            type: definition.type,
            cause,
          }),
        ),
      )

    const failOrphanedTool = (request: Request) => {
      const tool = request.tool
      if (!tool) return Effect.void
      return DateTime.now.pipe(
        Effect.flatMap((timestamp) =>
          publish(SessionEvent.Tool.Failed, {
            sessionID: request.sessionID,
            timestamp,
            assistantMessageID: SessionMessage.ID.make(tool.messageID),
            callID: tool.callID,
            error: { type: "unknown", message: "Tool execution interrupted" },
            interruption: { source: "recovery", reason: "stale-lease" },
            failure: SessionFailure.fromInterruptReason("stale-lease"),
            provider: { executed: false },
          }),
        ),
      )
    }

    const find = Effect.fn("QuestionV2.find")(function* (
      source: Transaction,
      requestID: ID,
      sessionID?: SessionSchema.ID,
    ) {
      return yield* source
        .select({ question: QuestionTable })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(
          and(
            eq(QuestionTable.id, requestID),
            ...(sessionID ? [eq(QuestionTable.session_id, sessionID)] : []),
            ...(inLocation() ? [inLocation()!] : []),
          ),
        )
        .get()
    })

    const get = Effect.fn("QuestionV2.get")(function* (requestID: ID, sessionID?: SessionSchema.ID) {
      const found = yield* db
        .select({ request: QuestionTable.request })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(
          and(
            eq(QuestionTable.id, requestID),
            ...(sessionID ? [eq(QuestionTable.session_id, sessionID)] : []),
            ...(inLocation() ? [inLocation()!] : []),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return found?.request
    })

    const promote = Effect.fn("QuestionV2.promote")(function* (
      tx: Transaction,
      sessionID: SessionSchema.ID,
    ) {
      const current = yield* tx
        .select({ id: QuestionTable.id })
        .from(QuestionTable)
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            eq(QuestionTable.state, "active"),
            eq(QuestionTable.allow_concurrent, false),
          ),
        )
        .get()
      if (current) return
      const next = yield* tx
        .select()
        .from(QuestionTable)
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            eq(QuestionTable.state, "queued"),
            eq(QuestionTable.allow_concurrent, false),
          ),
        )
        .orderBy(asc(QuestionTable.seq))
        .get()
      if (!next) return
      return yield* tx
        .update(QuestionTable)
        .set({ state: "active", time_updated: yield* Clock.currentTimeMillis })
        .where(and(eq(QuestionTable.id, next.id), eq(QuestionTable.state, "queued")))
        .returning({ request: QuestionTable.request })
        .get()
        .pipe(Effect.map((row) => row?.request))
    })

    const legacyActivity = Effect.fn("QuestionV2.legacyActivity")(function* (input: {
      sessionID: SessionSchema.ID
      assistantMessageID: string | null
      timeCreated: number
    }) {
      const assistant = input.assistantMessageID
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, SessionMessage.ID.make(input.assistantMessageID)),
                eq(SessionMessageTable.session_id, input.sessionID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      if (!assistant) {
        const ambiguous = yield* db
          .select({ id: SessionActivityTable.id })
          .from(SessionActivityTable)
          .where(
            and(
              eq(SessionActivityTable.session_id, input.sessionID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              eq(SessionActivityTable.time_created, input.timeCreated),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (ambiguous) return
      }
      const candidates = yield* db
        .select({ id: SessionActivityTable.id })
        .from(SessionActivityTable)
        .where(
          and(
            eq(SessionActivityTable.session_id, input.sessionID),
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            ...(assistant
              ? [lte(SessionActivityTable.opened_seq, assistant.seq)]
              : [lt(SessionActivityTable.time_created, input.timeCreated)]),
          ),
        )
        .orderBy(desc(SessionActivityTable.time_created), desc(SessionActivityTable.id))
        .limit(2)
        .all()
        .pipe(Effect.orDie)
      if (candidates.length === 1) return candidates[0]!.id
    })

    const reconcileLegacyActivities = Effect.fn("QuestionV2.reconcileLegacyActivities")(function* () {
      const rows = yield* db
        .select({
          id: QuestionTable.id,
          sessionID: QuestionTable.session_id,
          assistantMessageID: QuestionTable.assistant_message_id,
          timeCreated: QuestionTable.time_created,
        })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(
          and(
            isNull(QuestionTable.activity_id),
            eq(QuestionTable.detached, false),
            inArray(QuestionTable.state, ["queued", "active"]),
            ...(inLocation() ? [inLocation()!] : []),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        rows,
        (row) =>
          legacyActivity(row).pipe(
            Effect.flatMap((activityID) =>
              activityID
                ? db
                    .update(QuestionTable)
                    .set({ activity_id: activityID })
                    .where(
                      and(
                        eq(QuestionTable.id, row.id),
                        isNull(QuestionTable.activity_id),
                        inArray(QuestionTable.state, ["queued", "active"]),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                : Effect.void,
            ),
          ),
        { discard: true },
      )
    })

    const reconcileOrphans = Effect.fn("QuestionV2.reconcileOrphans")(function* () {
      yield* reconcileLegacyActivities()
      const outcome = yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const repair = (
              yield* tx
                .select({
                  request: QuestionTable.request,
                  messageID: SessionMessageTable.id,
                  messageType: SessionMessageTable.type,
                  messageData: SessionMessageTable.data,
                })
                .from(QuestionTable)
                .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
                .innerJoin(
                  SessionMessageTable,
                  and(
                    eq(SessionMessageTable.session_id, QuestionTable.session_id),
                    eq(SessionMessageTable.id, QuestionTable.assistant_message_id),
                  ),
                )
                .where(and(eq(QuestionTable.state, "orphaned"), ...(inLocation() ? [inLocation()!] : [])))
                .all()
            ).flatMap((row) => {
              const decoded = Schema.decodeUnknownOption(SessionMessage.Message)({
                ...row.messageData,
                id: row.messageID,
                type: row.messageType,
              })
              const message = decoded._tag === "Some" ? decoded.value : undefined
              const binding = row.request.tool
              if (!message || message.type !== "assistant" || !binding) return []
              const tool = message.content.find(
                (item): item is SessionMessage.AssistantTool => item.type === "tool" && item.id === binding.callID,
              )
              if (!tool || (tool.state.status !== "pending" && tool.state.status !== "running")) return []
              return [row.request]
            })
            const rows = yield* tx
              .select({ question: QuestionTable, activityStatus: SessionActivityTable.status })
              .from(QuestionTable)
              .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
              .leftJoin(SessionActivityTable, eq(SessionActivityTable.id, QuestionTable.activity_id))
              .where(
                and(
                  inArray(QuestionTable.state, ["queued", "active"]),
                  eq(QuestionTable.detached, false),
                  ...(inLocation() ? [inLocation()!] : []),
                ),
              )
              .all()
            const stale = rows.filter(
              (row) =>
                row.question.activity_id === null ||
                row.activityStatus === null ||
                !["running", "recovering"].includes(row.activityStatus),
            )
            const rejected: Request[] = []
            const sessions = new Set<SessionSchema.ID>()
            for (const row of stale) {
              const updated = yield* tx
                .update(QuestionTable)
                .set({
                  state: "orphaned",
                  receipt: `qrc_${randomUUID()}`,
                  time_settled: yield* Clock.currentTimeMillis,
                  time_updated: yield* Clock.currentTimeMillis,
                })
                .where(and(eq(QuestionTable.id, row.question.id), inArray(QuestionTable.state, ["queued", "active"])))
                .returning({ request: QuestionTable.request, state: QuestionTable.state })
                .get()
              if (!updated) continue
              rejected.push(updated.request)
              if (row.question.state === "active" && !row.question.allow_concurrent)
                sessions.add(SessionSchema.ID.make(row.question.session_id))
            }
            const promoted: Request[] = []
            for (const sessionID of sessions) {
              const request = yield* promote(tx, sessionID)
              if (request) promoted.push(request)
            }
            return { rejected, promoted, repair }
          }),
      ).pipe(Effect.orDie)
      yield* Effect.forEach(
        outcome.rejected,
        (request) =>
          Effect.gen(function* () {
            yield* failOrphanedTool(request)
            yield* Effect.sync(() => QuestionWakeup.wake(request.id))
            yield* publish(Event.Dismissed, { sessionID: request.sessionID, requestID: request.id })
          }),
        { discard: true },
      )
      yield* Effect.forEach(outcome.repair, failOrphanedTool, { discard: true })
      yield* Effect.forEach(outcome.promoted, (request) => publish(Event.Requested, request), { discard: true })
    })

    const enqueue = Effect.fn("QuestionV2.enqueue")(function* (input: AskInput, detached: boolean) {
      const id = ID.ascending()
      for (const [index, question] of input.questions.entries()) {
        const diagnostic = answerabilityDiagnostic(question, `["questions"][${index}]`)
        if (diagnostic) return yield* new ConflictError({ requestID: id, reason: diagnostic })
      }
      const actions = blockingActionMetadata(input.questions)
      if (new Set(actions.map((action) => action.id)).size !== actions.length)
        return yield* new ConflictError({ requestID: id, reason: "Surface action ids must be unique" })
      const request: BlockingRequest = {
        id,
        sessionID: input.sessionID,
        mode: "blocking",
        revision: 1,
        actions,
        questions: input.questions,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(detached ? { detached: true } : {}),
      }
      const outcome = yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            if (input.tool) {
              const tool = input.tool
              const retry = yield* tx
                .select()
                .from(QuestionTable)
                .where(
                  and(
                    eq(QuestionTable.session_id, input.sessionID),
                    eq(QuestionTable.assistant_message_id, tool.messageID),
                    eq(QuestionTable.tool_call_id, tool.callID),
                  ),
                )
                .get()
              if (retry) {
                const expected = { ...request, id: retry.request.id }
                if (!isDeepStrictEqual(retry.request, expected))
                  return yield* new ConflictError({
                    requestID: retry.request.id,
                    reason: "The tool retry key is already bound to a different question payload",
                  })
                return { request: retry.request, asked: false }
              }
            }

            const activity = detached
              ? undefined
              : yield* tx
                  .select({ id: SessionActivityTable.id })
                  .from(SessionActivityTable)
                  .where(
                    and(
                      eq(SessionActivityTable.session_id, input.sessionID),
                      inArray(SessionActivityTable.status, ["running", "recovering"]),
                    ),
                  )
                  .orderBy(desc(SessionActivityTable.time_created), desc(SessionActivityTable.id))
                  .get()
            if (!detached && !activity)
              return yield* new ConflictError({
                requestID: id,
                reason: "A blocking question requires a live Session activity",
              })

            const sequence = yield* tx
              .select({ value: max(QuestionTable.seq) })
              .from(QuestionTable)
              .where(eq(QuestionTable.session_id, input.sessionID))
              .get()
            const active = input.allowConcurrent
              || sequence?.value === null
              || sequence?.value === undefined
              ? undefined
              : yield* tx
                  .select({ id: QuestionTable.id })
                  .from(QuestionTable)
                  .where(
                    and(
                      eq(QuestionTable.session_id, input.sessionID),
                      eq(QuestionTable.state, "active"),
                      eq(QuestionTable.allow_concurrent, false),
                    ),
                  )
                  .get()
            const state = input.allowConcurrent || !active ? "active" : "queued"
            const now = yield* Clock.currentTimeMillis
            yield* tx
              .insert(QuestionTable)
              .values({
                id,
                session_id: input.sessionID,
                seq: (sequence?.value ?? 0) + 1,
                state,
                request,
                mode: request.mode,
                revision: request.revision,
                action_metadata: request.actions,
                detached,
                allow_concurrent: input.allowConcurrent === true,
                activity_id: activity?.id,
                assistant_message_id: input.tool?.messageID,
                tool_call_id: input.tool?.callID,
                time_created: now,
                time_updated: now,
              })
              .run()
            return { request, asked: state === "active" }
          }),
      ).pipe(
        Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))),
      )
      if (outcome.asked) yield* publish(Event.Requested, outcome.request)
      return outcome.request
    })

    const present = Effect.fn("QuestionV2.present")(function* (input: PresentInput) {
      const id = ID.ascending()
      const actions = actionMetadata(input.surface)
      if (new Set(actions.map((action) => action.id)).size !== actions.length)
        return yield* new ConflictError({ requestID: id, reason: "Surface action ids must be unique" })
      const request: ControlRequest = {
        id,
        sessionID: input.sessionID,
        mode: input.mode,
        revision: 1,
        actions,
        surface: input.surface,
        ...(input.tool ? { tool: input.tool } : {}),
      }
      const outcome = yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            if (input.tool) {
              const retry = yield* tx
                .select()
                .from(QuestionTable)
                .where(
                  and(
                    eq(QuestionTable.session_id, input.sessionID),
                    eq(QuestionTable.assistant_message_id, input.tool.messageID),
                    eq(QuestionTable.tool_call_id, input.tool.callID),
                  ),
                )
                .get()
              if (retry) {
                const expected = { ...request, id: retry.request.id }
                if (!isDeepStrictEqual(retry.request, expected))
                  return yield* new ConflictError({
                    requestID: retry.request.id,
                    reason: "The tool retry key is already bound to a different surface payload",
                  })
                if (retry.request.mode === "blocking")
                  return yield* new ConflictError({
                    requestID: retry.request.id,
                    reason: "The tool retry key is already bound to a blocking surface",
                  })
                return { request: retry.request, requested: false }
              }
            }

            const sequence = yield* tx
              .select({ value: max(QuestionTable.seq) })
              .from(QuestionTable)
              .where(eq(QuestionTable.session_id, input.sessionID))
              .get()
            const now = yield* Clock.currentTimeMillis
            yield* tx
              .insert(QuestionTable)
              .values({
                id,
                session_id: input.sessionID,
                seq: (sequence?.value ?? 0) + 1,
                state: "active",
                request,
                mode: request.mode,
                revision: request.revision,
                action_metadata: request.actions,
                detached: true,
                allow_concurrent: true,
                assistant_message_id: input.tool?.messageID,
                tool_call_id: input.tool?.callID,
                time_created: now,
                time_updated: now,
              })
              .run()
            return { request, requested: true }
          }),
      ).pipe(Effect.catch((error) => (error instanceof ConflictError ? Effect.fail(error) : Effect.die(error))))
      if (outcome.requested) yield* publish(Event.Requested, outcome.request)
      return outcome.request
    })

    const settle = Effect.fn("QuestionV2.settle")(function* (input: {
      requestID: ID
      sessionID?: SessionSchema.ID
      answers?: ReadonlyArray<Answer>
      includeQueued?: boolean
    }) {
      yield* reconcileOrphans()
      const outcome = yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const found = yield* find(tx, input.requestID, input.sessionID)
            if (!found) return yield* new NotFoundError({ requestID: input.requestID })
            const row = found.question
            if (input.answers) {
              if (row.request.mode !== "blocking")
                return yield* new ConflictError({
                  requestID: input.requestID,
                  reason: "Only blocking surfaces accept answer replies",
                })
              if (input.answers.length !== row.request.questions.length)
                return yield* new ConflictError({
                  requestID: input.requestID,
                  reason: `Expected ${row.request.questions.length} answers but received ${input.answers.length}`,
                })
            }
            if (row.state === "replied") {
              if (input.answers && isDeepStrictEqual(row.answers, input.answers)) return { settled: false as const }
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: "The question already has a different durable receipt",
              })
            }
            if (row.state === "rejected" && input.answers === undefined) return { settled: false as const }
            if (row.state === "orphaned")
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: "The provider activity ended before this blocking question was answered",
              })
            if (row.state === "rejected")
              return yield* new ConflictError({ requestID: input.requestID, reason: "The question was already rejected" })
            if (row.state === "queued" && !input.includeQueued)
              return yield* new ConflictError({ requestID: input.requestID, reason: "The question is not active yet" })

            const state = input.answers ? "replied" : "rejected"
            const now = yield* Clock.currentTimeMillis
            const updated = yield* tx
              .update(QuestionTable)
              .set({
                state,
                answers: input.answers ? input.answers.map((answer) => [...answer]) : null,
                receipt: `qrc_${randomUUID()}`,
                time_settled: now,
                time_updated: now,
              })
              .where(and(eq(QuestionTable.id, input.requestID), inArray(QuestionTable.state, ["queued", "active"])))
              .returning({ request: QuestionTable.request })
              .get()
            if (!updated) return yield* new ConflictError({ requestID: input.requestID, reason: "The question changed while settling" })
            const promoted = row.state === "active" && !row.allow_concurrent ? yield* promote(tx, row.session_id) : undefined
            return { settled: true as const, request: updated.request, promoted }
          }),
      ).pipe(
        Effect.catch((error) =>
          error instanceof NotFoundError || error instanceof ConflictError ? Effect.fail(error) : Effect.die(error),
        ),
      )
      if (!outcome.settled) return false
      yield* Effect.sync(() => QuestionWakeup.wake(outcome.request.id))
      if (input.answers)
        yield* publish(Event.Replied, {
          sessionID: outcome.request.sessionID,
          requestID: outcome.request.id,
          answers: input.answers.map((answer) => [...answer]),
        })
      if (!input.answers)
        yield* publish(Event.Dismissed, { sessionID: outcome.request.sessionID, requestID: outcome.request.id })
      if (outcome.promoted) yield* publish(Event.Requested, outcome.promoted)
      return true
    })

    const awaitSettlement = Effect.fn("QuestionV2.awaitSettlement")(function* (requestID: ID) {
      for (;;) {
        const outcome = yield* QuestionWakeup.wait(requestID, (wakeup) =>
          Effect.gen(function* () {
            const found = yield* db
              .select({ question: QuestionTable })
              .from(QuestionTable)
              .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
              .where(and(eq(QuestionTable.id, requestID), ...(inLocation() ? [inLocation()!] : [])))
              .get()
              .pipe(Effect.orDie)
            if (!found || found.question.state === "rejected" || found.question.state === "orphaned") {
              yield* Effect.sync(() => QuestionWakeup.wake(requestID))
              return yield* new RejectedError()
            }
            if (found.question.state === "replied") {
              yield* Effect.sync(() => QuestionWakeup.wake(requestID))
              return { settled: true as const, answers: found.question.answers ?? [] }
            }
            const timedOut = yield* Effect.raceFirst(
              wakeup.pipe(Effect.as(false)),
              Effect.sleep("1500 millis").pipe(Effect.as(true)),
            )
            if (timedOut) yield* reconcileOrphans()
            return { settled: false as const }
          }),
        )
        if (outcome.settled) return outcome.answers
      }
    })

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        enqueue(input, false).pipe(
          Effect.flatMap((request) =>
            restore(awaitSettlement(request.id)).pipe(
              Effect.onInterrupt(() =>
                settle({ requestID: request.id, sessionID: request.sessionID, includeQueued: true }).pipe(Effect.ignore),
              ),
            ),
          ),
        ),
      ),
    )

    const askDurable = Effect.fn("QuestionV2.askDurable")((input: AskInput) =>
      Effect.uninterruptible(
        enqueue(input, false).pipe(Effect.flatMap((request) => awaitSettlement(request.id))),
      ),
    )

    const askDetached = Effect.fn("QuestionV2.askDetached")((input: AskInput) =>
      Effect.uninterruptible(
        enqueue(input, true).pipe(Effect.flatMap((request) => awaitSettlement(request.id))),
      ),
    )

    const open = Effect.fn("QuestionV2.open")((input: AskInput) => enqueue(input, true))

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) => settle(input).pipe(Effect.asVoid))

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID, sessionID?: SessionSchema.ID) =>
      settle({ requestID, sessionID }),
    )

    const dismiss = Effect.fn("QuestionV2.dismiss")(function* (
      sessionID: SessionSchema.ID,
      followupsOnly: boolean,
    ) {
      const outcome = yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select({ question: QuestionTable })
              .from(QuestionTable)
              .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
              .where(
                and(
                  eq(QuestionTable.session_id, sessionID),
                  inArray(QuestionTable.state, ["queued", "active"]),
                  ...(inLocation() ? [inLocation()!] : []),
                ),
              )
              .orderBy(asc(QuestionTable.seq))
              .all()
            const selected = rows
              .map((row) => row.question)
              .filter(
                (row) =>
                  (!followupsOnly && row.request.mode === "blocking") ||
                  (followupsOnly &&
                    row.request.mode === "blocking" &&
                    row.detached &&
                    row.request.phase === "implementation_complete_followup"),
              )
            const now = yield* Clock.currentTimeMillis
            const rejected: Request[] = []
            for (const row of selected) {
              const updated = yield* tx
                .update(QuestionTable)
                .set({ state: "rejected", receipt: `qrc_${randomUUID()}`, time_settled: now, time_updated: now })
                .where(and(eq(QuestionTable.id, row.id), inArray(QuestionTable.state, ["queued", "active"])))
                .returning({ request: QuestionTable.request })
                .get()
              if (updated) rejected.push(updated.request)
            }
            const promoted =
              followupsOnly && selected.some((row) => row.state === "active" && !row.allow_concurrent)
                ? yield* promote(tx, sessionID)
                : undefined
            return { rejected, promoted }
          }),
      ).pipe(Effect.orDie)
      yield* Effect.forEach(
        outcome.rejected,
        (request) =>
          Effect.sync(() => QuestionWakeup.wake(request.id)).pipe(
            Effect.andThen(publish(Event.Dismissed, { sessionID: request.sessionID, requestID: request.id })),
          ),
        { discard: true },
      )
      if (outcome.promoted) yield* publish(Event.Requested, outcome.promoted)
    })

    const dismissSession = Effect.fn("QuestionV2.dismissSession")((sessionID: SessionSchema.ID) =>
      dismiss(sessionID, false),
    )
    const dismissFollowups = Effect.fn("QuestionV2.dismissFollowups")((sessionID: SessionSchema.ID) =>
      dismiss(sessionID, true),
    )

    const settlementTarget = Effect.fn("QuestionV2.settlementTarget")(function* (
      requestID: ID,
      sessionID?: SessionSchema.ID,
    ) {
      const found = yield* db
        .select({
          detached: QuestionTable.detached,
          activityID: QuestionTable.activity_id,
          assistantMessageID: QuestionTable.assistant_message_id,
          sessionID: QuestionTable.session_id,
          timeCreated: QuestionTable.time_created,
        })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(
          and(
            eq(QuestionTable.id, requestID),
            ...(sessionID ? [eq(QuestionTable.session_id, sessionID)] : []),
            ...(inLocation() ? [inLocation()!] : []),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!found) return
      if (found.detached || found.activityID !== null)
        return {
          detached: found.detached,
          ...(found.activityID === null ? {} : { activityID: found.activityID }),
        }

      const activityID = yield* legacyActivity(found)
      return {
        detached: found.detached,
        ...(activityID ? { activityID } : {}),
      }
    })

    const list = Effect.fn("QuestionV2.list")(function* () {
      yield* reconcileOrphans()
      const rows = yield* db
        .select({ request: QuestionTable.request, sessionID: QuestionTable.session_id, seq: QuestionTable.seq })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(and(eq(QuestionTable.state, "active"), ...(inLocation() ? [inLocation()!] : [])))
        .orderBy(asc(QuestionTable.session_id), asc(QuestionTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => row.request)
    })

    const persistentTool = (row: typeof SurfaceToolTable.$inferSelect): PersistentTool => ({
      id: PersistentToolID.make(row.id),
      scope: row.scope,
      ...(row.project_id ? { projectID: row.project_id } : {}),
      directory: row.directory,
      ...(row.origin_request_id && row.origin_session_id && row.origin_revision
        ? {
            origin: {
              requestID: ID.make(row.origin_request_id),
              sessionID: SessionSchema.ID.make(row.origin_session_id),
              revision: row.origin_revision,
            },
          }
        : {}),
      mode: row.mode,
      revision: row.definition_revision,
      actions: row.action_metadata,
      surface: { ...row.surface, values: row.state_values },
      state: { version: 1, revision: row.state_revision, values: row.state_values },
      hidden: row.hidden,
      time: { created: row.time_created, updated: row.time_updated },
    })

    const inToolLocation = () =>
      location
        ? or(eq(SurfaceToolTable.scope, "global"), eq(SurfaceToolTable.project_id, location.project.id))
        : undefined

    const createPersistentTool = Effect.fn("Surface.createPersistentTool")(function* (
      input: CreatePersistentToolInput,
    ) {
      return yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const source = yield* tx
              .select({ question: QuestionTable, directory: SessionTable.directory, projectID: SessionTable.project_id })
              .from(QuestionTable)
              .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
              .where(
                and(
                  eq(QuestionTable.id, input.requestID),
                  eq(QuestionTable.session_id, input.sessionID),
                  ...(inLocation() ? [inLocation()!] : []),
                ),
              )
              .get()
            if (!source) return yield* new NotFoundError({ requestID: input.requestID })
            if (source.question.state !== "active")
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: "Only a pending Surface can become a persistent tool",
              })
            if (source.question.request.mode === "blocking")
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: "Blocking Surfaces cannot become persistent tools",
              })
            if (source.question.revision !== input.expectedRevision)
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: `Surface revision changed from ${input.expectedRevision} to ${source.question.revision}`,
              })
            if (
              input.scope === "global" &&
              (source.question.request.mode !== "passive" || source.question.action_metadata.length > 0)
            )
              return yield* new ConflictError({
                requestID: input.requestID,
                reason: "App-global tools must be passive and action-free",
              })

            const scopeKey = input.scope === "global" ? "global" : source.projectID
            const existing = yield* tx
              .select()
              .from(SurfaceToolTable)
              .where(
                and(
                  eq(SurfaceToolTable.origin_request_id, input.requestID),
                  eq(SurfaceToolTable.scope_key, scopeKey),
                ),
              )
              .get()
            if (existing) return persistentTool(existing)

            const now = yield* Clock.currentTimeMillis
            const request = source.question.request
            const row = yield* tx
              .insert(SurfaceToolTable)
              .values({
                id: PersistentToolID.ascending(),
                scope: input.scope,
                scope_key: scopeKey,
                project_id: input.scope === "project" ? source.projectID : null,
                directory: source.directory,
                origin_request_id: request.id,
                origin_session_id: request.sessionID,
                origin_revision: request.revision,
                mode: request.mode,
                definition_revision: request.revision,
                action_metadata: request.actions,
                surface: request.surface,
                state_version: 1,
                state_revision: 1,
                state_values: request.surface.values ?? {},
                hidden: false,
                time_created: now,
                time_updated: now,
              })
              .returning()
              .get()
            return persistentTool(row!)
          }),
      ).pipe(
        Effect.catch((error) =>
          error instanceof NotFoundError || error instanceof ConflictError ? Effect.fail(error) : Effect.die(error),
        ),
      )
    })

    const listPersistentTools = Effect.fn("Surface.listPersistentTools")(function* (includeHidden = false) {
      const rows = yield* db
        .select()
        .from(SurfaceToolTable)
        .where(
          and(
            ...(inToolLocation() ? [inToolLocation()!] : []),
            ...(includeHidden ? [] : [eq(SurfaceToolTable.hidden, false)]),
          ),
        )
        .orderBy(asc(SurfaceToolTable.time_created), asc(SurfaceToolTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(persistentTool)
    })

    const updatePersistentToolState = Effect.fn("Surface.updatePersistentToolState")(function* (
      input: UpdatePersistentToolStateInput,
    ) {
      const updated = yield* db
        .update(SurfaceToolTable)
        .set({
          state_values: { ...input.values },
          state_revision: input.expectedRevision + 1,
          time_updated: yield* Clock.currentTimeMillis,
        })
        .where(
          and(
            eq(SurfaceToolTable.id, input.toolID),
            eq(SurfaceToolTable.state_revision, input.expectedRevision),
            ...(inToolLocation() ? [inToolLocation()!] : []),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (updated) return persistentTool(updated)
      const found = yield* db
        .select({ revision: SurfaceToolTable.state_revision })
        .from(SurfaceToolTable)
        .where(and(eq(SurfaceToolTable.id, input.toolID), ...(inToolLocation() ? [inToolLocation()!] : [])))
        .get()
        .pipe(Effect.orDie)
      if (!found) return yield* new PersistentToolNotFoundError({ toolID: input.toolID })
      return yield* new ConflictError({
        requestID: ID.make("que_surface_tool_state"),
        reason: `Surface tool state revision changed from ${input.expectedRevision} to ${found.revision}`,
      })
    })

    const setPersistentToolHidden = Effect.fn("Surface.setPersistentToolHidden")(function* (
      toolID: PersistentToolID,
      hidden: boolean,
    ) {
      const updated = yield* db
        .update(SurfaceToolTable)
        .set({ hidden, time_updated: yield* Clock.currentTimeMillis })
        .where(and(eq(SurfaceToolTable.id, toolID), ...(inToolLocation() ? [inToolLocation()!] : [])))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* new PersistentToolNotFoundError({ toolID })
      return persistentTool(updated)
    })

    const removePersistentTool = Effect.fn("Surface.removePersistentTool")(function* (toolID: PersistentToolID) {
      const removed = yield* db
        .delete(SurfaceToolTable)
        .where(and(eq(SurfaceToolTable.id, toolID), ...(inToolLocation() ? [inToolLocation()!] : [])))
        .returning({ id: SurfaceToolTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!removed) return yield* new PersistentToolNotFoundError({ toolID })
    })

    const invocation = (row: typeof SurfaceActionInvocationTable.$inferSelect): ActionInvocation => ({
      id: row.id,
      target: { kind: row.target_kind, id: row.target_id, revision: row.target_revision },
      actionID: row.action_id,
      ...(row.source ? { source: row.source } : {}),
      state: row.state,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error ? { error: row.error } : {}),
      ...(row.execution_key ? { executionKey: row.execution_key } : {}),
      ...(row.effect_started_at ? { effectStartedAt: row.effect_started_at } : {}),
      ...(row.error_class ? { errorClass: row.error_class } : {}),
      payloadHash: row.payload_hash,
      time: { created: row.time_created, updated: row.time_updated },
    })

    const actionInvocations = Effect.fn("Surface.actionInvocations")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select({ invocation: SurfaceActionInvocationTable, request: QuestionTable.request })
        .from(SurfaceActionInvocationTable)
        .innerJoin(
          QuestionTable,
          and(
            eq(SurfaceActionInvocationTable.target_kind, "request"),
            eq(SurfaceActionInvocationTable.target_id, QuestionTable.id),
          ),
        )
        .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            ...(inLocation() ? [inLocation()!] : []),
          ),
        )
        .orderBy(asc(SurfaceActionInvocationTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ invocation: invocation(row.invocation), request: row.request }))
    })

    const beginActionInvocation = Effect.fn("Surface.beginActionInvocation")(function* (
      input: BeginActionInvocationInput,
    ) {
      return yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const hash = actionInvocationHash(input)
            const existing = yield* tx
              .select()
              .from(SurfaceActionInvocationTable)
              .where(eq(SurfaceActionInvocationTable.id, input.id))
              .get()
            if (existing) {
              if (existing.payload_hash !== hash)
                return yield* new ConflictError({
                  requestID: ID.make("que_surface_action"),
                  reason: "Surface action invocation id is already bound to a different payload",
                })
              return { invocation: invocation(existing), claimed: false }
            }

            const actions =
              input.target.kind === "request"
                ? yield* tx
                    .select({
                      revision: QuestionTable.revision,
                      actions: QuestionTable.action_metadata,
                      state: QuestionTable.state,
                    })
                    .from(QuestionTable)
                    .innerJoin(SessionTable, eq(SessionTable.id, QuestionTable.session_id))
                    .where(
                      and(
                        eq(QuestionTable.id, ID.make(input.target.id)),
                        ...(inLocation() ? [inLocation()!] : []),
                      ),
                    )
                    .get()
                : yield* tx
                    .select({
                      revision: SurfaceToolTable.definition_revision,
                      actions: SurfaceToolTable.action_metadata,
                      state: SurfaceToolTable.hidden,
                    })
                    .from(SurfaceToolTable)
                    .where(
                      and(
                        eq(SurfaceToolTable.id, PersistentToolID.make(input.target.id)),
                        ...(inToolLocation() ? [inToolLocation()!] : []),
                      ),
                    )
                    .get()
            if (!actions)
              return yield* new ActionInvocationNotFoundError({ invocationID: input.id })
            if (input.target.kind === "request" && actions.state !== "active")
              return yield* new ConflictError({
                requestID: ID.make(input.target.id),
                reason: "Surface action request is no longer pending",
              })
            if (actions.revision !== input.target.revision)
              return yield* new ConflictError({
                requestID: input.target.kind === "request" ? ID.make(input.target.id) : ID.make("que_surface_action"),
                reason: `Surface action revision changed from ${input.target.revision} to ${actions.revision}`,
              })
            if (!actions.actions.some((action) => action.id === input.actionID))
              return yield* new ConflictError({
                requestID: input.target.kind === "request" ? ID.make(input.target.id) : ID.make("que_surface_action"),
                reason: `Surface action is not authorized by revision ${actions.revision}`,
              })

            const now = yield* Clock.currentTimeMillis
            const created = yield* tx
              .insert(SurfaceActionInvocationTable)
              .values({
                id: input.id,
                target_kind: input.target.kind,
                target_id: input.target.id,
                target_revision: input.target.revision,
                action_id: input.actionID,
                source: input.source,
                payload_hash: hash,
                state: "pending",
                time_created: now,
                time_updated: now,
              })
              .returning()
              .get()
            return { invocation: invocation(created!), claimed: true }
          }),
      ).pipe(
        Effect.catch((error) =>
          error instanceof ConflictError || error instanceof ActionInvocationNotFoundError
            ? Effect.fail(error)
            : Effect.die(error),
        ),
      )
    })

    const completeActionInvocation = Effect.fn("Surface.completeActionInvocation")(function* (
      id: string,
      result?: unknown,
    ) {
      const updated = yield* db
        .update(SurfaceActionInvocationTable)
        .set({ state: "completed", result, time_updated: yield* Clock.currentTimeMillis })
        .where(and(eq(SurfaceActionInvocationTable.id, id), eq(SurfaceActionInvocationTable.state, "pending")))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (updated) return invocation(updated)
      const found = yield* db
        .select()
        .from(SurfaceActionInvocationTable)
        .where(eq(SurfaceActionInvocationTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!found) return yield* new ActionInvocationNotFoundError({ invocationID: id })
      return invocation(found)
    })

    // Claims the non-idempotent effect slot for a once intent. The partial
    // unique index on execution_key makes the claim atomic across processes:
    // the first invocation to bind the key wins, later invocations of the same
    // intent observe the winner instead of producing a second side effect.
    const beginActionEffect = Effect.fn("Surface.beginActionEffect")(function* (input: BeginActionEffectInput) {
      return yield* QuestionTransaction.run(
        db,
        (tx) =>
          Effect.gen(function* () {
            const invocationRow = yield* tx
              .select()
              .from(SurfaceActionInvocationTable)
              .where(eq(SurfaceActionInvocationTable.id, input.invocationID))
              .get()
              .pipe(Effect.orDie)
            if (!invocationRow)
              return yield* new ActionInvocationNotFoundError({ invocationID: input.invocationID })
            if (invocationRow.execution_key && invocationRow.execution_key !== input.executionKey)
              return yield* new ConflictError({
                requestID: ID.make("que_surface_action"),
                reason: "Surface action invocation is already bound to a different execution key",
              })

            const bound = yield* tx
              .select()
              .from(SurfaceActionInvocationTable)
              .where(eq(SurfaceActionInvocationTable.execution_key, input.executionKey))
              .get()
              .pipe(Effect.orDie)
            if (bound && bound.id !== invocationRow.id) {
              if (bound.payload_hash !== invocationRow.payload_hash)
                return yield* new ConflictError({
                  requestID: ID.make("que_surface_action"),
                  reason: "Surface action execution key is already bound to a different payload",
                })
              return { invocation: invocation(bound), claimed: false }
            }
            if (invocationRow.execution_key === input.executionKey) {
              // Same invocation retrying its own effect claim: the side effect
              // slot is already held, so the caller must not run it again.
              return { invocation: invocation(invocationRow), claimed: false }
            }

            const now = yield* Clock.currentTimeMillis
            const updated = yield* tx
              .update(SurfaceActionInvocationTable)
              .set({ execution_key: input.executionKey, effect_started_at: now, time_updated: now })
              .where(
                and(
                  eq(SurfaceActionInvocationTable.id, input.invocationID),
                  isNull(SurfaceActionInvocationTable.execution_key),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!updated) {
              const raced = yield* tx
                .select()
                .from(SurfaceActionInvocationTable)
                .where(eq(SurfaceActionInvocationTable.id, input.invocationID))
                .get()
                .pipe(Effect.orDie)
              if (!raced) return yield* new ActionInvocationNotFoundError({ invocationID: input.invocationID })
              return { invocation: invocation(raced), claimed: false }
            }
            return { invocation: invocation(updated), claimed: true }
          }),
      ).pipe(
        Effect.catch((error) =>
          error instanceof ConflictError || error instanceof ActionInvocationNotFoundError
            ? Effect.fail(error)
            : Effect.die(error),
        ),
      )
    })

    const getActionInvocation = Effect.fn("Surface.getActionInvocation")(function* (id: string) {
      const row = yield* db
        .select()
        .from(SurfaceActionInvocationTable)
        .where(eq(SurfaceActionInvocationTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new ActionInvocationNotFoundError({ invocationID: id })
      return invocation(row)
    })

    const failActionInvocation = Effect.fn("Surface.failActionInvocation")(function* (
      id: string,
      error: string,
      errorClass?: "preflight" | "unknown",
    ) {
      const updated = yield* db
        .update(SurfaceActionInvocationTable)
        .set({
          state: "failed",
          error,
          ...(errorClass ? { error_class: errorClass } : {}),
          time_updated: yield* Clock.currentTimeMillis,
        })
        .where(and(eq(SurfaceActionInvocationTable.id, id), eq(SurfaceActionInvocationTable.state, "pending")))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (updated) return invocation(updated)
      const found = yield* db
        .select()
        .from(SurfaceActionInvocationTable)
        .where(eq(SurfaceActionInvocationTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!found) return yield* new ActionInvocationNotFoundError({ invocationID: id })
      return invocation(found)
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== SessionEvent.PromptLifecycle.Admitted.type) return Effect.void
      if (!isRecord(event.data) || typeof event.data.sessionID !== "string") return Effect.void
      return dismissFollowups(SessionSchema.ID.make(event.data.sessionID))
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({
      ask,
      askDurable,
      askDetached,
      open,
      present,
      reply,
      reject,
      dismissSession,
      dismissFollowups,
      settlementTarget,
      get,
      list,
      createPersistentTool,
      listPersistentTools,
      updatePersistentToolState,
      setPersistentToolHidden,
      removePersistentTool,
      beginActionInvocation,
      beginActionEffect,
      completeActionInvocation,
      getActionInvocation,
      failActionInvocation,
      actionInvocations,
    })
  }),
)

export function actionMetadata(surface: Control.PartData) {
  return collectActionMetadata([
    { path: "actions", actions: surface.actions ?? [] },
    ...surface.controls.flatMap((control, index) =>
      control.form?.actions ? [{ path: `controls[${index}].form.actions`, actions: control.form.actions }] : [],
    ),
  ])
}

function blockingActionMetadata(questions: ReadonlyArray<Info>) {
  return collectActionMetadata(
    questions.flatMap((question, index) =>
      question.form?.actions ? [{ path: `questions[${index}].form.actions`, actions: question.form.actions }] : [],
    ),
  )
}

function collectActionMetadata(groups: ReadonlyArray<{ path: string; actions: ReadonlyArray<Control.SurfaceAction> }>) {
  return groups.flatMap((group) =>
    group.actions.map((action, index) => ({
      id: action.id,
      path: `${group.path}[${index}]`,
      permissions: action.steps.flatMap(actionPermissions),
    })),
  )
}

function actionPermissions(step: Control.SurfaceActionStep): ActionPermission[] {
  if (step.type === "configWrite") return [{ action: "edit", resources: [step.target.path] }]
  if (step.type === "livePublish") return [{ action: "surface.live.publish", resources: [step.topic ?? "*"] }]
  if (step.type === "command") return [{ action: "bash", resources: [[step.command, ...(step.arguments ?? [])].join(" ")] }]
  if (step.type === "gmail") return [{ action: "surface.gmail", resources: [step.mode] }]
  if (step.type === "switchAgentAndPrompt")
    return [
      { action: "session.switch_agent", resources: [step.agent] },
      ...(step.model.mode === "implementation-model"
        ? [{ action: "session.switch_model", resources: [step.model.ref] }]
        : []),
    ]
  return []
}

function actionInvocationHash(input: BeginActionInvocationInput) {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  // The id is transport identity, not payload identity: once executions must
  // bind later invocations of the same intent even when they arrive with a new
  // invocation id (fresh popup submit, lost response retry).
  const { id: _invocationID, ...payload } = input
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex")
}

export function actionInvocationPayloadHash(input: BeginActionInvocationInput) {
  return actionInvocationHash(input)
}

export const locationLayer = layer
