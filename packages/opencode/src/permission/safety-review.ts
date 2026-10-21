export * as PermissionSafetyReview from "./safety-review"

import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { PermissionSafetyReviewIntent } from "@opencode-ai/core/permission/safety-review-intent"
import { Cause, Effect, Exit, Schema } from "effect"
import { HeadlessAI } from "@/headless-ai"
import type { ModelMessage } from "ai"

const Decision = Schema.Struct({ decision: Schema.Literals(["safe", "unsafe"]), reason: Schema.String })
const decisionSchema = Object.assign(Schema.toStandardSchemaV1(Decision), Schema.toStandardJSONSchemaV1(Decision))

type Attempt = { status: "safe" | "unsafe" | "transport_error"; model: string; reason?: string }

export function intent(messages: ReadonlyArray<ModelMessage>) {
  return PermissionSafetyReviewIntent.build({
    messages: messages.flatMap((message): PermissionSafetyReviewIntent.Message[] => {
      if (message.role !== "user" && message.role !== "assistant") return []
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n\n")
      const attachments =
        message.role === "user" && Array.isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === "file" ? [{ name: part.filename, mime: part.mediaType }] : [],
            )
          : undefined
      return text.trim() || attachments?.length ? [{ role: message.role, text, attachments }] : []
    }),
  })
}

export const review = Effect.fn("PermissionSafetyReview.review")(function* (input: {
  readonly accessControl?: ConfigAccessControl.Info | unknown
  readonly sessionID: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
  readonly source?: unknown
  readonly intent: PermissionSafetyReviewIntent.Envelope
  readonly tool?: { readonly name: string; readonly callID?: string; readonly input: unknown }
}) {
  const accessControl = ConfigAccessControl.fromUnknown(input.accessControl)
  const safety = accessControl?.mode === "approve_for_me" ? accessControl.safety_review : undefined
  if (!safety?.chain?.length && !safety?.model) return false
  const headlessAI = yield* HeadlessAI.Service

  const attempt = Effect.fnUntraced(function* (
    reviewer: ConfigAccessControl.SafetyReviewer,
    role: "primary" | "fallback",
    chain = role === "primary" ? safety.chain : undefined,
  ) {
    if (!chain?.length && !reviewer.model) return
    yield* Effect.logWarning("permission safety review starting", {
      model: chain?.map((step: { providerID: string; modelID: string }) => `${step.providerID}/${step.modelID}`) ?? reviewer.model,
      role,
      sessionID: input.sessionID,
      permission: input.permission,
      patterns: [...input.patterns],
      tool: input.tool?.name,
      callID: input.tool?.callID,
    })
    const result = yield* Effect.exit(
      headlessAI.object<{ decision: "safe" | "unsafe"; reason: string }>({
        model: reviewer.model,
        chain,
        schema: decisionSchema,
        system:
          (safety.prompt ?? ConfigAccessControl.DEFAULT_SAFETY_REVIEW_PROMPT) +
          '\n\nReturn ONLY a raw JSON object with exactly {"decision":"safe"|"unsafe","reason":"..."}. No markdown, no code fences.',
        messages: [{
          role: "user",
          content: JSON.stringify({
            sessionID: input.sessionID,
            permission: { action: input.permission, resources: [...input.patterns] },
            metadata: input.metadata,
            source: input.source,
            intent: input.intent,
            tool: input.tool,
          }, null, 2),
        }],
        generation: ModelRequest.helperGeneration(reviewer.generation),
        options: reviewer.options,
        variant: reviewer.variant,
        metadata: { kind: "permission.safety_review", sessionID: input.sessionID, permission: input.permission },
      }),
    )
    if (Exit.isFailure(result)) {
      yield* Effect.logWarning("permission safety review failed", {
        model: reviewer.model,
        role,
        sessionID: input.sessionID,
        permission: input.permission,
        error: String(Cause.squash(result.cause)),
      })
      return { status: "transport_error" as const, model: reviewer.model, reason: "Provider request failed" }
    }
    const decoded = result.value.object
    yield* Effect.logInfo("permission safety review decision", {
      model: reviewer.model,
      role,
      sessionID: input.sessionID,
      permission: input.permission,
      decision: decoded.decision,
      reason: decoded.reason,
    })
    return { status: decoded.decision, model: result.value.model, reason: decoded.reason } satisfies Attempt
  })

  const primary = yield* attempt(safety, "primary")
  if (primary?.status === "safe") return true
  const fallback = safety.fallback?.model ? yield* attempt(safety.fallback, "fallback") : undefined
  if (fallback?.status !== "safe") return false
  if (primary?.status !== "unsafe") return true
  return lowRisk(input.permission, input.patterns)
})

function lowRisk(permission: string, patterns: ReadonlyArray<string>) {
  if (["read", "grep", "glob", "list"].includes(permission)) return true
  if (permission !== "bash" || patterns.length !== 1) return false
  const command = patterns[0]?.toLowerCase() ?? ""
  if (/\b(remove-item|rm|rmdir|del|erase|git\s+push|git\s+add|git\s+commit|stop-process|start-process|set-service|sc\.exe|reg\.exe|chmod|chown|curl|invoke-webrequest)\b/.test(command)) return false
  return /(^|[;&|]\s*)(&\s*)?(get-content|get-command|where\.exe|git\s+(status|diff|log|show|rev-parse)|.*test.*\.ps1|.*invoke-.*tests.*\.ps1|.*ffprobe)/i.test(command)
}
