export * as Control from "./control"

import { Schema } from "effect"

export const Type = Schema.Literals([
  "pick_one",
  "pick_many",
  "confirm",
  "rank",
  "rate",
  "ask_text",
  "ask_code",
  "ask_file",
  "ask_image",
  "show_diff",
  "show_plan",
  "show_options",
  "review_section",
  "thumbs",
  "emoji_react",
  "slider",
  "form",
  "number_stepper",
  "duration",
  "range",
  "vector2",
  "vector3",
  "color",
  "easing",
  "curve",
  "timeline",
  "select",
  "segmented",
  "radio_group",
  "checkbox_group",
  "toggle",
  "loop_type",
  "blend_mode",
  "tabs",
  "accordion",
  "details",
  "table",
  "object_tree",
  "key_value_editor",
  "list_editor",
  "reorderable_list",
  "button",
  "button_group",
  "command_trigger",
  "reset",
  "apply",
  "revert",
  "open_browser",
  "capture_screenshot",
  "image_preview",
  "video_preview",
  "audio_preview",
  "file_picker",
  "folder_picker",
  "asset_picker",
  "sprite_selector",
  "scrubber",
]).annotate({ identifier: "Control.Type" })
export type Type = typeof Type.Type

export const Option = Schema.Struct({
  id: Schema.String.pipe(Schema.optional).annotate({ description: "Stable option identifier" }),
  label: Schema.String.annotate({ description: "Display label" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Short explanation" }),
  tooltip: Schema.String.pipe(Schema.optional).annotate({ description: "Hover tooltip text" }),
  pros: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Advantages" }),
  cons: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Disadvantages" }),
  details: Schema.Unknown.pipe(Schema.optional).annotate({ description: "Expandable option details" }),
}).annotate({ identifier: "Control.Option" })
export type Option = typeof Option.Type

export const BodyMarkdown = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable body block identifier" }),
  type: Schema.Literal("markdown"),
  content: Schema.String.annotate({ description: "Sanitized Markdown content rendered by the host" }),
}).annotate({ identifier: "Control.BodyMarkdown" })
export type BodyMarkdown = typeof BodyMarkdown.Type

export const BodyActionLink = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable body block identifier" }),
  type: Schema.Literal("action_link"),
  label: Schema.String.annotate({ description: "Visible secondary action label" }),
  href: Schema.String.annotate({ description: "User-clicked http, https, or obsidian URI" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Short action explanation" }),
}).annotate({ identifier: "Control.BodyActionLink" })
export type BodyActionLink = typeof BodyActionLink.Type

export const BodyMediaType = Schema.Literals(["image", "audio", "video", "file"]).annotate({
  identifier: "Control.BodyMediaType",
})
export type BodyMediaType = typeof BodyMediaType.Type

export const BodyMediaItem = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable media item identifier returned in answers" }),
  label: Schema.String.annotate({ description: "Visible media item label" }),
  mediaType: BodyMediaType,
  src: Schema.String.annotate({ description: "Media URL or local path" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Short media explanation" }),
  defaultChecked: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Whether the item is selected initially" }),
}).annotate({ identifier: "Control.BodyMediaItem" })
export type BodyMediaItem = typeof BodyMediaItem.Type

export const BodyMediaChecklist = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable value-bearing body block identifier" }),
  type: Schema.Literal("media_checklist"),
  label: Schema.String.pipe(Schema.optional).annotate({ description: "Visible checklist heading" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Short checklist explanation" }),
  items: Schema.Array(BodyMediaItem),
}).annotate({ identifier: "Control.BodyMediaChecklist" })
export type BodyMediaChecklist = typeof BodyMediaChecklist.Type

export const BodyBlock = Schema.Union([BodyMarkdown, BodyActionLink, BodyMediaChecklist]).annotate({
  identifier: "Control.BodyBlock",
})
export type BodyBlock = typeof BodyBlock.Type

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
}).annotate({ identifier: "Control.Section" })

export const FormRichTextAction = Schema.Literals([
  "bold",
  "italic",
  "underline",
  "link",
  "bullet_list",
  "numbered_list",
]).annotate({ identifier: "Control.FormRichTextAction" })
export type FormRichTextAction = typeof FormRichTextAction.Type

export const FormFieldType = Schema.Literals([
  "text",
  "email",
  "number",
  "number_range",
  "duration_range",
  "textarea",
  "rich_text",
  "recipient_list",
  "attachment_list",
  "file_picker",
  "folder_picker",
  "image_preview",
  "video_preview",
  "checkbox",
  "select",
  "button",
  "display",
  "hidden",
]).annotate({ identifier: "Control.FormFieldType" })
export type FormFieldType = typeof FormFieldType.Type

export const FormAutocomplete = Schema.Struct({
  provider: Schema.Literals(["gmail-recipients"]).annotate({ description: "Autocomplete source provider" }),
  minLength: Schema.Number.pipe(Schema.optional).annotate({ description: "Minimum query length before suggestions load" }),
}).annotate({ identifier: "Control.FormAutocomplete" })
export type FormAutocomplete = typeof FormAutocomplete.Type

export const SurfaceEffect = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable effect id" }),
  target: Schema.String.annotate({ description: "Local UI or value target path" }),
  value: Schema.String.annotate({ description: "Validated template expression" }),
}).annotate({ identifier: "Control.SurfaceEffect" })
export type SurfaceEffect = typeof SurfaceEffect.Type

export const SurfaceTrigger = Schema.Struct({
  event: Schema.Literals(["change", "submit", "click", "markStart", "markEnd"]).annotate({ description: "Action trigger event" }),
  source: Schema.String.pipe(Schema.optional).annotate({ description: "Field or control id that emits the event" }),
  when: Schema.Struct({
    field: Schema.String.annotate({ description: "Value field to compare before running the action" }),
    equals: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]).annotate({ description: "Required value" }),
  }).pipe(Schema.optional),
}).annotate({ identifier: "Control.SurfaceTrigger" })
export type SurfaceTrigger = typeof SurfaceTrigger.Type

export const ConfigFormat = Schema.Literals(["json", "jsonc", "yaml", "toml", "ts", "custom"]).annotate({
  identifier: "Control.ConfigFormat",
  description: "Config file format",
})
export type ConfigFormat = typeof ConfigFormat.Type

export const ConfigTarget = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative config path" }),
  format: ConfigFormat,
  pointer: Schema.String.pipe(Schema.optional).annotate({ description: "JSON pointer or equivalent value path" }),
  exportName: Schema.String.pipe(Schema.optional).annotate({ description: "Named export for TS/custom configs" }),
}).annotate({ identifier: "Control.ConfigTarget" })
export type ConfigTarget = typeof ConfigTarget.Type

export const SurfaceActionStep = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("setValue"),
    target: Schema.String.annotate({ description: "Value target path" }),
    value: Schema.String.annotate({ description: "Validated template expression" }),
  }),
  Schema.Struct({
    type: Schema.Literal("configWrite"),
    target: ConfigTarget,
    value: Schema.String.pipe(Schema.optional).annotate({ description: "Template expression; defaults to trigger source value" }),
    debounceMs: Schema.Number.pipe(Schema.optional).annotate({ description: "Write debounce in milliseconds" }),
  }),
  Schema.Struct({
    type: Schema.Literal("livePublish"),
    topic: Schema.String.pipe(Schema.optional).annotate({ description: "Runtime update topic" }),
    value: Schema.String.pipe(Schema.optional).annotate({ description: "Template expression; defaults to trigger source value" }),
    debounceMs: Schema.Number.pipe(Schema.optional).annotate({ description: "Publish debounce in milliseconds" }),
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: Schema.String.annotate({ description: "Executable command" }),
    arguments: Schema.Array(Schema.String).pipe(Schema.optional).annotate({ description: "Command arguments" }),
    directory: Schema.String.pipe(Schema.optional).annotate({ description: "Working directory" }),
  }),
  Schema.Struct({
    type: Schema.Literal("gmail"),
    mode: Schema.Literals(["send", "draft"]).annotate({ description: "Gmail delivery mode" }),
  }),
  Schema.Struct({
    type: Schema.Literal("gmx"),
    account: Schema.String.check(Schema.isNonEmpty()).annotate({ description: "Configured GMX account ID" }),
    mode: Schema.Literals(["send", "draft"]),
  }),
  Schema.Struct({
    type: Schema.Literal("mail_manager"),
    viewID: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
    mode: Schema.Literals(["apply", "wish"]),
  }),
  Schema.Struct({
    type: Schema.Literal("dismiss"),
  }),
  Schema.Struct({
    type: Schema.Literal("switchAgentAndPrompt"),
    agent: Schema.NonEmptyString,
    prompt: Schema.NonEmptyString,
    model: Schema.Union([
      Schema.Struct({ mode: Schema.Literal("planning-model") }),
      Schema.Struct({
        mode: Schema.Literal("implementation-model"),
        ref: Schema.NonEmptyString,
        variant: Schema.String.pipe(Schema.optional),
      }),
    ]),
  }),
]).annotate({ identifier: "Control.SurfaceActionStep" })
export type SurfaceActionStep = typeof SurfaceActionStep.Type

export const SurfaceAction = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable action id" }),
  trigger: SurfaceTrigger,
  steps: Schema.Array(SurfaceActionStep),
  execution: Schema.Struct({
    mode: Schema.Literals(["repeatable", "once"]).annotate({
      description: "repeatable runs once per deliberate click; once locks the side effect to the form revision",
    }),
    group: Schema.String.check(Schema.isNonEmpty()).pipe(Schema.optional).annotate({
      description: "Optional lock group so sibling actions of one form share a single execution slot; once only",
    }),
  }).pipe(Schema.optional).annotate({
    description: "Execution locking contract; omitted means repeatable. The host always treats mail delivery steps as once.",
  }),
}).annotate({ identifier: "Control.SurfaceAction" })
export type SurfaceAction = typeof SurfaceAction.Type

// Mail delivery is non-idempotent: sibling send/draft actions of one composer
// must share a single execution slot even when the form omits locking metadata.
export const executionModeForAction = (action: SurfaceAction, steps: ReadonlyArray<SurfaceActionStep>): "repeatable" | "once" =>
  steps.some((step) => step.type === "gmail" || step.type === "gmx" || step.type === "mail_manager") || action.execution?.mode === "once" ? "once" : "repeatable"

export const executionGroupForAction = (action: SurfaceAction, formID: string): string | undefined => {
  if (action.execution?.mode === "once" && action.execution.group) return action.execution.group
  if (action.steps.some((step) => step.type === "gmail" || step.type === "gmx" || step.type === "mail_manager")) return `${formID}:outbound`
  return
}

export const FormField = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable field id used as the answer value key" }),
  type: FormFieldType.annotate({ description: "Form field renderer type" }),
  label: Schema.String.pipe(Schema.optional).annotate({ description: "Visible field label" }),
  description: Schema.String.pipe(Schema.optional).annotate({ description: "Short field help" }),
  tooltip: Schema.String.pipe(Schema.optional).annotate({ description: "Hover tooltip text" }),
  placeholder: Schema.String.pipe(Schema.optional),
  required: Schema.Boolean.pipe(Schema.optional),
  defaultValue: Schema.Unknown.pipe(Schema.optional),
  rows: Schema.Number.pipe(Schema.optional),
  min: Schema.Number.pipe(Schema.optional),
  max: Schema.Number.pipe(Schema.optional),
  step: Schema.Number.pipe(Schema.optional),
  minLength: Schema.Number.pipe(Schema.optional),
  maxLength: Schema.Number.pipe(Schema.optional),
  src: Schema.String.pipe(Schema.optional).annotate({ description: "Preview media URL or local path for media preview fields" }),
  poster: Schema.String.pipe(Schema.optional).annotate({ description: "Optional poster image URL for video preview fields" }),
  startLabel: Schema.String.pipe(Schema.optional).annotate({ description: "Start label for range fields" }),
  endLabel: Schema.String.pipe(Schema.optional).annotate({ description: "End label for range fields" }),
  options: Schema.Array(Option).pipe(Schema.optional),
  toolbar: Schema.Array(FormRichTextAction).pipe(Schema.optional),
  accept: Schema.String.pipe(Schema.optional).annotate({ description: "Attachment/file accept hint" }),
  multiple: Schema.Boolean.pipe(Schema.optional),
  autocomplete: FormAutocomplete.pipe(Schema.optional).annotate({ description: "Optional host-backed autocomplete configuration" }),
}).annotate({ identifier: "Control.FormField" })
export type FormField = typeof FormField.Type

export interface FormLayoutNode {
  readonly id?: string
  readonly type: "hstack" | "vstack" | "field" | "text"
  readonly field?: string
  readonly when?: { readonly field: string; readonly equals: string }
  readonly text?: string
  readonly title?: string
  readonly tooltip?: string
  readonly width?: string
  readonly height?: string
  readonly gap?: string
  readonly children?: ReadonlyArray<FormLayoutNode>
}
export const FormLayoutNode: Schema.Codec<FormLayoutNode> = Schema.Struct({
  id: Schema.String.pipe(Schema.optional),
  type: Schema.Literals(["hstack", "vstack", "field", "text"]),
  field: Schema.String.pipe(Schema.optional).annotate({ description: "Field id rendered by this node" }),
  when: Schema.Struct({ field: Schema.String, equals: Schema.String }).pipe(Schema.optional),
  text: Schema.String.pipe(Schema.optional).annotate({ description: "Static helper text" }),
  title: Schema.String.pipe(Schema.optional),
  tooltip: Schema.String.pipe(Schema.optional).annotate({ description: "Hover tooltip text" }),
  width: Schema.String.pipe(Schema.optional).annotate({ description: "Child width: CSS size, %, auto, or fill" }),
  height: Schema.String.pipe(Schema.optional).annotate({ description: "Child height: CSS size, %, auto, or fill" }),
  gap: Schema.String.pipe(Schema.optional).annotate({ description: "CSS gap for stack children" }),
  children: Schema.Array(Schema.suspend((): Schema.Codec<FormLayoutNode> => FormLayoutNode)).pipe(Schema.optional),
}).annotate({ identifier: "Control.FormLayoutNode" })

export const FormDefinition = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.pipe(Schema.optional).annotate({ description: "Stable form id" }),
  title: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  tooltip: Schema.String.pipe(Schema.optional).annotate({ description: "Hover tooltip text" }),
  fields: Schema.Array(FormField),
  layout: FormLayoutNode.pipe(Schema.optional),
  submitLabel: Schema.String.pipe(Schema.optional),
  effects: Schema.Array(SurfaceEffect).pipe(Schema.optional).annotate({ description: "Pure local UI/value derivations" }),
  actions: Schema.Array(SurfaceAction).pipe(Schema.optional).annotate({ description: "Explicit local or host actions" }),
}).annotate({ identifier: "Control.FormDefinition" })
export type FormDefinition = typeof FormDefinition.Type

export const Definition = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable control id" }),
  type: Type.annotate({ description: "Control renderer type" }),
  label: Schema.String.annotate({ description: "Readable label" }),
  description: Schema.String.pipe(Schema.optional),
  tooltip: Schema.String.pipe(Schema.optional).annotate({ description: "Hover tooltip text" }),
  markdown: Schema.String.pipe(Schema.optional).annotate({ description: "Optional markdown help shown with the control" }),
  options: Schema.Array(Option).pipe(Schema.optional),
  recommended: Schema.String.pipe(Schema.optional),
  recommendedOptions: Schema.Array(Schema.String).pipe(Schema.optional),
  allowOther: Schema.Boolean.pipe(Schema.optional),
  allowFeedback: Schema.Boolean.pipe(Schema.optional),
  min: Schema.Number.pipe(Schema.optional),
  max: Schema.Number.pipe(Schema.optional),
  step: Schema.Number.pipe(Schema.optional),
  defaultValue: Schema.Unknown.pipe(Schema.optional),
  value: Schema.Unknown.pipe(Schema.optional),
  placeholder: Schema.String.pipe(Schema.optional),
  language: Schema.String.pipe(Schema.optional),
  content: Schema.String.pipe(Schema.optional),
  sections: Schema.Array(Section).pipe(Schema.optional),
  form: FormDefinition.pipe(Schema.optional),
  before: Schema.String.pipe(Schema.optional),
  after: Schema.String.pipe(Schema.optional),
  filePath: Schema.String.pipe(Schema.optional),
  emojis: Schema.Array(Schema.String).pipe(Schema.optional),
  src: Schema.String.pipe(Schema.optional).annotate({ description: "Preview media URL or local path" }),
  poster: Schema.String.pipe(Schema.optional).annotate({ description: "Optional poster media URL or local path" }),
}).annotate({ identifier: "Control.Definition" })
export type Definition = typeof Definition.Type

export const PartData = Schema.Struct({
  version: Schema.Literal(1),
  controlID: Schema.String.annotate({ description: "Stable group id" }),
  title: Schema.String.pipe(Schema.optional),
  markdown: Schema.String.pipe(Schema.optional),
  controls: Schema.Array(Definition),
  values: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  effects: Schema.Array(SurfaceEffect).pipe(Schema.optional).annotate({ description: "Pure local UI/value derivations" }),
  actions: Schema.Array(SurfaceAction).pipe(Schema.optional).annotate({ description: "Explicit local or host actions" }),
  dock: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Open this Control Panel docked instead of as the default popup" }),
}).annotate({ identifier: "Control.PartData" })
export type PartData = typeof PartData.Type
