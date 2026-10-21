export * as SurfaceTool from "./surface"

import { createHash, randomUUID } from "node:crypto"
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { PermissionV2 } from "../permission"
import { Control } from "../control"
import { ControlSurface } from "../control-surface"
import { Surface } from "../surface"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "surface"

export const description = `Create one durable OpenCode Surface for questions, choices, reviews, and host controls.

Modes: "blocking" pauses tool completion until the user replies (questions); "interactive" runs non-blocking controls and host actions; "passive" is non-blocking read-only information. Interactive/passive payloads use Control.PartData and stay pending until dismissed; never wrap them in a \`surface\` field.

Blocking payloads are inline \`{ "mode": "blocking", "questions": [...] }\` (optional ignored top-level "title"; \`phase\` only as \`"implementation_complete_followup"\`) or source-backed \`{ "mode": "blocking", "sourceFile": { path, sha256, count } }\` for large validated local reviews (content-addressed \`<sha256>.json\` below the managed question-payloads state directory; the tool validates path, hash, count, and schema, then writes a hash-bound response file).

Blocking contract:
- Never put \`actions\` on a blocking tool input or question; explicit form events belong only in \`question.form.actions\`. Interactive Control actions follow Control.PartData; passive surfaces cannot declare actions.
- No legacy \`context\`, \`content\`, or \`markdown\` question fields; put visible copy in \`body\` blocks (\`markdown\`, \`action_link\`, \`media_checklist\`). Keep \`question\` short plain text.
- \`options\` must be objects \`{ id, label, description }\`; string arrays or a \`choices\` field fail. Mark a recommended option first with "(Recommended)" at the end of the label. \`allowOther\`/\`custom\` add the free-text option automatically.
- The runtime shows one pending question per session; bundle related choices into one call.
- The host renders the expectation line; set \`showExpectation: false\` only when the question body is already the concise prompt.
- Agent handoffs are not Surface actions: use \`switch_agent\` with the exact target agent and follow-up prompt.

Pick the smallest fitting control: omit \`type\` or use \`pick_one\`/\`pick_many\` (or \`multiple: true\`); otherwise \`confirm\`, \`thumbs\`, \`show_options\`, \`show_plan\`, \`show_diff\`, \`review_section\`, \`ask_text\`, \`ask_code\`, \`ask_file\`, \`ask_image\`, \`slider\`, \`rank\`, \`rate\`, or \`form\`. For richer reviews use \`accordion\`, \`details\`, \`tabs\`, \`object_tree\`, or \`table\` with nested \`sections\`. Forms pass a versioned \`form\` spec with stack layout nodes and fields; \`form.effects\` drive local preview changes, \`form.actions\` explicit events, and \`mode: "interactive"\` completes host-action forms without another assistant turn. \`action_link\` accepts only \`http:\`, \`https:\`, and \`obsidian:\` hrefs.

Value-bearing bodies return a JSON first answer string (\`opencode.question.answer\` / \`opencode.form.answer\`). Detailed control, field, media, and answer contracts live in the input schema annotations and the on-demand-ui skill.`

export const SourceFile = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute content-addressed payload path" }),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
    description: "Lowercase SHA-256 of the complete payload bytes",
  }),
  count: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(128)).annotate({
    description: "Expected number of questions and stable keys",
  }),
}).annotate({ identifier: "SurfaceTool.SourceFile" })
export type SourceFile = typeof SourceFile.Type

export const SourceInput = Schema.Struct({
  mode: Schema.Literal("blocking"),
  sourceFile: SourceFile,
  phase: Surface.Phase.pipe(Schema.optional),
  title: Schema.String.pipe(Schema.optional).annotate({
    description: "Accepted for forward compatibility; ignored for source-backed question payloads",
  }),
}).annotate({ identifier: "SurfaceTool.SourceInput" })
export type SourceInput = typeof SourceInput.Type

export const BlockingInput = Schema.Struct({
  mode: Schema.Literal("blocking"),
  questions: Schema.Array(Surface.AuthoringInfo).annotate({ description: "Questions to ask" }),
  phase: Surface.Phase.pipe(Schema.optional),
  title: Schema.String.pipe(Schema.optional).annotate({
    description: "Accepted for forward compatibility; the blocking runtime does not render it yet",
  }),
}).annotate({ identifier: "SurfaceTool.BlockingInput" })
export type BlockingInput = typeof BlockingInput.Type

export const ControlInput = Schema.Struct({
  mode: Schema.Literals(["interactive", "passive"]),
  ...Control.PartData.fields,
}).annotate({ identifier: "SurfaceTool.ControlInput" })
export type ControlInput = typeof ControlInput.Type

export const Input = Schema.Union([BlockingInput, SourceInput, ControlInput]).annotate({ identifier: "SurfaceTool.Input" })
export type Input = typeof Input.Type

export const BlockingOutput = Schema.Struct({
  mode: Schema.Literal("blocking"),
  answers: Schema.Array(Surface.Answer),
  keys: Schema.Array(Schema.String).pipe(Schema.optional),
  responseFile: Schema.String.pipe(Schema.optional),
})
export const ControlOutput = Schema.Struct({
  mode: Schema.Literals(["interactive", "passive"]),
  requestID: Surface.ID,
  revision: Schema.Int,
  controlID: Schema.String,
})
export const Output = Schema.Union([BlockingOutput, ControlOutput])
export type Output = typeof Output.Type

const QuestionSourcePayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("opencode.question-payload"),
  binding: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).pipe(Schema.optional),
  keys: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/))),
  questions: Schema.Array(Surface.AuthoringInfo),
})

const questionSourceLimit = 2 * 1024 * 1024
const blockingInputKeys = new Set(["mode", "questions", "phase", "title"])
const sourceInputKeys = new Set(["mode", "sourceFile", "phase", "title"])
const sourceFileKeys = new Set(["path", "sha256", "count"])
const sourcePayloadKeys = new Set(["version", "kind", "binding", "keys", "questions"])
const correctiveInput =
  'The surface tool is available, but this payload is invalid. Correct it and retry once with the canonical shape { "mode": "blocking", "questions": [{ "question": "...", "options": [{ "label": "...", "description": "..." }], "allowOther": true }] }. Do not render the choices as a text fallback. Omit phase unless it is exactly "implementation_complete_followup".'
const correctiveRuntime =
  "The surface tool is available, but the host could not open this request. Report this runtime conflict accurately; do not claim the native UI is unavailable and do not render the choices as a text fallback."

const answerText = (answer: Surface.Answer) =>
  answer
    .map((item) => {
      if (typeof item === "string") return item
      return `[file: ${item.filename ?? "attachment"} (${item.mime}) ${item.url}]`
    })
    .join(", ")

const answerContent = (answer: Surface.Answer) =>
  answer.flatMap((item) => {
    if (typeof item === "string") return []
    const data = answerFileData(item.url)
    return data ? [{ type: "file" as const, data, mime: item.mime, name: item.filename }] : []
  })

const answerFileData = (url: string) => {
  try {
    const file = fileURLToPath(url)
    if (!questionAnswerFileAllowed(file)) return
    return readFileSync(file).toString("base64")
  } catch {
    return
  }
}

const questionAnswerFileAllowed = (file: string) =>
  FSUtil.contains(`${Global.Path.state}${sep}question-attachments`, file) || file.includes(`${sep}clipboard-attachments${sep}`)

export const toModelOutput = (input: Input, output: typeof Output.Encoded) => {
  if (output.mode !== "blocking")
    return `Opened ${output.mode} Surface ${output.controlID} (${output.requestID}, revision ${output.revision}).`
  const formatted =
    "questions" in input
      ? input.questions
          .map(
            (question, index) =>
              `"${question.question}"="${output.answers[index]?.length ? answerText(output.answers[index]) : "Unanswered"}"`,
          )
          .join(", ")
      : output.answers
          .map(
            (answer, index) =>
              `"${output.keys?.[index] ?? `#${index + 1}`}"="${answer.length ? answerText(answer) : "Unanswered"}"`,
          )
          .join(", ")
  return `User has answered your questions: ${formatted}.${output.responseFile ? ` Durable response: ${output.responseFile}.` : ""} You can now continue with the user's answers in mind.`
}

export const toModelContent = (input: Input, output: typeof Output.Encoded) => [
  { type: "text" as const, text: toModelOutput(input, output) },
  ...(output.mode === "blocking" ? output.answers.flatMap(answerContent) : []),
]

const readQuestionSource = Effect.fn("SurfaceTool.readQuestionSource")(function* (source: SourceFile) {
  const loaded = yield* Effect.try({
    try: () => {
      if (!isAbsolute(source.path)) throw new Error("Question source path must be absolute")
      const expected = `${source.sha256}.json`
      const root = resolve(Global.Path.state, "question-payloads")
      const lexical = resolve(source.path)
      if (relative(root, lexical) !== expected)
        throw new Error(`Question source must be the managed content-addressed file ${expected}`)
      const realRoot = realpathSync(root)
      const info = lstatSync(lexical)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Question source is not a regular managed file")
      if (info.size > questionSourceLimit) throw new Error(`Question source exceeds ${questionSourceLimit} bytes`)
      const file = realpathSync(lexical)
      if (relative(realRoot, file) !== expected)
        throw new Error("Question source canonical path is outside the managed state directory")
      const bytes = readFileSync(file)
      if (bytes.length > questionSourceLimit) throw new Error(`Question source exceeds ${questionSourceLimit} bytes`)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (sha256 !== source.sha256) throw new Error("Question source SHA-256 does not match")
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return { file, root: realRoot, sha256, text }
    },
    catch: (cause) =>
      new ToolFailure({
        message: `Unable to load question source: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  const raw = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(loaded.text).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid question source payload: ${error.message}` })),
  )
  const diagnostic = validateQuestionSourcePayload(raw)
  if (diagnostic) return yield* new ToolFailure({ message: `Invalid question source payload: ${diagnostic}` })
  const payload = yield* Schema.decodeUnknownEffect(QuestionSourcePayload)(raw).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid question source payload: ${error.message}` })),
  )
  if (payload.questions.length !== source.count)
    return yield* new ToolFailure({
      message: `Question source count mismatch: expected ${source.count}, received ${payload.questions.length}`,
    })
  if (payload.keys.length !== source.count)
    return yield* new ToolFailure({
      message: `Question source key count mismatch: expected ${source.count}, received ${payload.keys.length}`,
    })
  if (new Set(payload.keys).size !== payload.keys.length)
    return yield* new ToolFailure({ message: "Question source keys must be unique" })
  return {
    questions: payload.questions,
    source: { file: loaded.file, root: loaded.root, sha256: loaded.sha256, keys: payload.keys },
  }
})

const writeQuestionResponse = Effect.fn("SurfaceTool.writeQuestionResponse")(function* (
  source: {
    readonly file: string
    readonly root: string
    readonly sha256: string
    readonly keys: ReadonlyArray<string>
  },
  answers: ReadonlyArray<Surface.Answer>,
) {
  if (answers.length !== source.keys.length)
    return yield* new ToolFailure({
      message: `Question response count mismatch: expected ${source.keys.length}, received ${answers.length}`,
    })
  const response = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        kind: "opencode.question-response",
        sourceSha256: source.sha256,
        keys: source.keys,
        answers,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  return yield* Effect.try({
    try: () => {
      const target = join(source.root, `${source.sha256}.response.json`)
      if (existsSync(target)) {
        assertQuestionResponse(target, source.root, response)
        return target
      }
      const temporary = join(source.root, `.${source.sha256}.${randomUUID()}.tmp`)
      writeFileSync(temporary, response, { flag: "wx" })
      try {
        linkSync(temporary, target)
      } catch (cause) {
        if (!existsSync(target)) throw cause
        assertQuestionResponse(target, source.root, response)
      } finally {
        rmSync(temporary, { force: true })
      }
      return target
    },
    catch: (cause) =>
      new ToolFailure({
        message: `Unable to persist question response: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
})

function assertQuestionResponse(target: string, root: string, expected: Buffer) {
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Question response target is not a regular managed file")
  const real = realpathSync(target)
  if (relative(root, real) !== relative(root, target))
    throw new Error("Question response canonical path is outside the managed state directory")
  if (!readFileSync(real).equals(expected))
    throw new Error("A different response already exists for this question source")
}

export function validateInput(input: unknown) {
  if (!isRecord(input)) return
  if (input.phase !== undefined && input.phase !== "implementation_complete_followup")
    return correction(
      `Invalid field ["phase"]. Expected "implementation_complete_followup" or omission, got ${JSON.stringify(input.phase)}.`,
    )
  if (input.mode === "interactive" || input.mode === "passive") {
    const diagnostic = ControlSurface.validatePartData(input)[0]
    if (diagnostic) return correction(`${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
    if (input.mode === "passive" && hasActions(input)) return correction("Passive surfaces cannot declare actions.")
    return
  }
  if (input.title !== undefined && typeof input.title !== "string")
    return correction(`Invalid field ["title"]. Expected a string or omission, got ${JSON.stringify(input.title)}.`)
  if (!("sourceFile" in input)) {
    const root = unknownField(input, blockingInputKeys, "")
    if (root) return correction(root)
    const diagnostic = Surface.validateToolInput({
      questions: input.questions,
      ...(input.phase ? { phase: input.phase } : {}),
    })
    return diagnostic ? correction(diagnostic) : undefined
  }
  const root = unknownField(input, sourceInputKeys, "")
  if (root) return correction(root)
  if (!isRecord(input.sourceFile)) return correction('Invalid field ["sourceFile"]. Expected an object.')
  const diagnostic = unknownField(input.sourceFile, sourceFileKeys, '["sourceFile"]')
  return diagnostic ? correction(diagnostic) : undefined
}

function validateQuestionSourcePayload(input: unknown) {
  if (!isRecord(input)) return correction("Expected a JSON object.")
  const root = unknownField(input, sourcePayloadKeys, "")
  if (root) return correction(root)
  const diagnostic = Surface.validateToolInput({ questions: input.questions })
  return diagnostic ? correction(diagnostic) : undefined
}

function correction(diagnostic: string) {
  return `${diagnostic}\n\n${correctiveInput}`
}

function conflict(error: Surface.ConflictError) {
  return new ToolFailure({ message: `Surface runtime conflict: ${error.reason}. ${correctiveRuntime}` })
}

function unknownField(input: Record<string, unknown>, allowed: Set<string>, path: string) {
  const key = Object.keys(input).find((candidate) => !allowed.has(candidate))
  if (!key) return
  const location = `${path}[${JSON.stringify(key)}]`
  if (key === "actions" && path === "")
    return `Unexpected field ${location}. Blocking Surface inputs cannot declare actions. Use question.form.actions for form events, or use mode "interactive" with the Control.PartData action contract.`
  if (key === "surface" && path === "")
    return `Unexpected field ${location}. Interactive and passive Control.PartData fields belong directly on the Surface tool input; blocking inputs use questions or sourceFile.`
  return `Unexpected field ${location}. Allowed fields: ${Array.from(allowed).sort().join(", ")}.`
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const surface = yield* Surface.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          validateInput,
          toModelOutput: ({ input, output }) => toModelContent(input, output),
          execute: (input, context) =>
            permission
              .assert({
                action: "surface",
                resources: [input.mode],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: surface" })),
                Effect.andThen(
                  Effect.gen(function* () {
                    if (input.mode !== "blocking") {
                      yield* Effect.forEach(
                        Surface.actionMetadata(controlData(input)).flatMap((action) => action.permissions),
                        (required) =>
                          permission
                            .assert({
                              action: required.action,
                              resources: required.resources,
                              sessionID: context.sessionID,
                              agent: context.agent,
                              source: {
                                type: "tool",
                                messageID: context.assistantMessageID,
                                callID: context.toolCallID,
                              },
                            })
                            .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${required.action}` }))),
                        { discard: true },
                      )
                      const request = yield* surface
                        .present({
                          sessionID: context.sessionID,
                          mode: input.mode,
                          surface: controlData(input),
                          tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                        })
                        .pipe(Effect.mapError(conflict))
                      return {
                        mode: request.mode,
                        requestID: Surface.ID.make(request.id),
                        revision: request.revision,
                        controlID: request.surface.controlID,
                      }
                    }
                    const resolved =
                      "questions" in input
                        ? { questions: input.questions }
                        : yield* readQuestionSource(input.sourceFile)
                    const answers = yield* surface
                      .askDurable({
                        sessionID: context.sessionID,
                        questions: resolved.questions,
                        phase: input.phase,
                        tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                      })
                      .pipe(
                        Effect.catchTag("QuestionV2.ConflictError", (error) => Effect.fail(conflict(error))),
                        Effect.catchTag("QuestionV2.RejectedError", Effect.die),
                      )
                    if (!("source" in resolved))
                      return { mode: "blocking" as const, answers: answers.map((answer) => [...answer]) }
                    const responseFile = yield* writeQuestionResponse(resolved.source, answers)
                    return {
                      mode: "blocking" as const,
                      answers: answers.map((answer) => [...answer]),
                      keys: [...resolved.source.keys],
                      responseFile,
                    }
                  }),
                ),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export function isBlockingInput(input: unknown): input is BlockingInput | SourceInput {
  return isRecord(input) && input.mode === "blocking"
}

function controlData(input: ControlInput): Control.PartData {
  const { mode: _, ...surface } = input
  return surface
}

function hasActions(input: Record<string, unknown>) {
  if (Array.isArray(input.actions) && input.actions.length > 0) return true
  if (!Array.isArray(input.controls)) return false
  return input.controls.some(
    (control) =>
      isRecord(control) &&
      isRecord(control.form) &&
      Array.isArray(control.form.actions) &&
      control.form.actions.length > 0,
  )
}
