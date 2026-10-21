import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { ConfigModelChain } from "@opencode-ai/core/config/model-chain"
import { SessionTerminal } from "@opencode-ai/core/session/terminal"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schedule, Schema, Option } from "effect"
import { completionRegistry } from "@/plugin/completion"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "./status"
import { Config } from "@/config/config"
import { Todo } from "./todo"
import { HeadlessAI } from "@/headless-ai"
import { Session } from "./session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"

export const DEFAULT_PROMPT = `Evaluate whether the agent has completed all requested work.
Compare the latest admitted user task with the last assistant response and the todo list. A short response or JSON is complete when the user requested exactly that output. Respond with exactly one word:
- DONE: if all requested work is complete and the response reports the result
- INCOMPLETE: if there are pending or in-progress todos, work was left unfinished, or the response only announces a plan, investigation, or future action

Latest admitted user task:
{userTask}

Todos:
{todos}

Last assistant response:
{lastMessage}

Artifacts:
{artifacts}`

export const MODEL_EVALUATION_ATTEMPT_TIMEOUT = "15 seconds"
export const MODEL_EVALUATION_TIMEOUT = "50 seconds"
export const IDLE_GUARD_TIMEOUT = "55 seconds"

export type Status = "done" | "incomplete" | "unknown"

// Completion needs evidence, not the legacy message IDs or provider metadata.
export type CompletionMessage = {
  info: { role: "assistant" | "user"; finish?: string; error?: unknown }
  parts: readonly {
    type: string
    text?: string
    tool?: string
    state?: { status: string; metadata?: Record<string, unknown> }
  }[]
}

/**
 * Where the completion verdict comes from. `target` wins over the deprecated
 * `model`/`variant` pair; an unresolvable target must surface as an `unknown`
 * verdict instead of silently degrading to the mechanical todo fallback.
 */
export type Target =
  | { kind: "model"; modelID: string; variant?: string }
  | { kind: "chain"; chainID: string; steps: AIChain.AIChainStep[] }

export function completionTarget(cfg: {
  session?: { turn_completion?: { target?: string; model?: string; variant?: string } }
  model_chains?: Parameters<typeof ConfigModelChain.selectedSteps>[0]["chains"]
}): Target | undefined {
  const tc = cfg.session?.turn_completion
  if (!tc) return undefined
  const raw = tc.target?.trim()
  if (raw) {
    if (raw.startsWith("chain:")) {
      const chainID = raw.slice("chain:".length).trim()
      const steps = ConfigModelChain.selectedSteps({ chains: cfg.model_chains, chainID: chainID || undefined })
      return { kind: "chain", chainID, steps: steps ?? [] }
    }
    const ref = (raw.startsWith("model:") ? raw.slice("model:".length) : raw).trim()
    if (ref) return { kind: "model", modelID: ref }
  }
  const model = tc.model?.trim()
  if (model) {
    const variant = tc.variant?.trim()
    return { kind: "model", modelID: model, ...(variant ? { variant } : {}) }
  }
  return undefined
}

export interface Interface {
  readonly resolve: (
    sessionID: SessionID,
    input?: { agent?: string; status?: Status; messages?: CompletionMessage[] },
  ) => Effect.Effect<Status | undefined>
  readonly evaluate: (sessionID: SessionID, input?: { agent?: string }) => Effect.Effect<void>
  readonly record: (sessionID: SessionID, status: Status) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TurnCompletion") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const todo = yield* Todo.Service
    const config = yield* Config.Service
    const headlessAI = yield* HeadlessAI.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service

    const publish = Effect.fn("TurnCompletion.publish")(function* (sessionID: SessionID, status: Status) {
      yield* events.publish(SessionStatus.Event.TurnCompleted, { sessionID, status })
    })

    const resolve = Effect.fn("TurnCompletion.resolve")(function* (
      sessionID: SessionID,
      input?: { agent?: string; status?: Status; messages?: CompletionMessage[] },
    ) {
      const cfg = yield* config.get()
      const pluginMessages =
        input?.messages ??
        (yield* session
          .messages({ sessionID, limit: 200 })
          .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))))
      const sessionInfo = yield* session.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (sessionInfo?.directory) {
        const required = yield* Effect.promise(() =>
          completionRegistry.check(sessionInfo.directory, {
            sessionID,
            messages: pluginMessages.map((message) => ({
              role: message.info.role,
              text: messageText(message),
              tools: message.parts.flatMap((part) =>
                part.type === "tool" && part.tool && part.state ? [{ name: part.tool, status: part.state.status }] : [],
              ),
            })),
          }),
        )
        if (required) return required
      }
      if (input?.status) return input.status
      if (!cfg.session?.turn_completion?.enabled) return

      const messages = pluginMessages.slice(-8)
      const todos = yield* todo.get(sessionID)
      const history = historyStatus(pluginMessages, input?.agent)
      if (history) return history
      const review = reviewReport(pluginMessages)
      if (review && todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return "incomplete"
      if (review && isReportOnlyReviewTask(pluginMessages)) return "done"
      if (!review && hasSubstantialFinalReport(messages)) return "done"
      const artifacts = artifactText(sessionInfo?.metadata)
      const tc = cfg.session.turn_completion
      const target = completionTarget(cfg)
      // Without a configured target the mechanical todo fallback stays the
      // deterministic verdict; with one, an unavailable target must be visible.
      if (!target) return mechanicalStatus(todos)
      // A chain reference that matches no configured chain is a permanent
      // configuration error: report unknown immediately instead of retrying or
      // silently falling through to the default model.
      if (target.kind === "chain" && target.steps.length === 0) return "unknown"
      const fallback = deterministicFallback(messages, todos)
      const selected = input?.agent ? yield* agents.get(input.agent) : undefined
      const prompt =
        selected?.completion?.mode === "custom"
          ? (selected.completion.prompt ?? DEFAULT_PROMPT)
          : (tc.prompt ?? DEFAULT_PROMPT)
      return yield* evaluateWithModel({
        sessionID,
        todos,
        prompt,
        target,
        headlessAI,
        messages,
        userTask: latestUserTask(pluginMessages),
        artifacts,
      }).pipe(
        Effect.timeout(MODEL_EVALUATION_ATTEMPT_TIMEOUT),
        Effect.retry({
          schedule: Schedule.exponential("1 second").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(2))),
        }),
        Effect.timeoutOrElse({
          duration: MODEL_EVALUATION_TIMEOUT,
          orElse: () => Effect.succeed(fallback ?? ("unknown" as Status)),
        }),
        Effect.catchCause(() => Effect.succeed(fallback ?? ("unknown" as Status))),
      )
    })

    const record = Effect.fn("TurnCompletion.record")(function* (sessionID: SessionID, status: Status) {
      const resolved = yield* resolve(sessionID, { status })
      if (resolved) yield* publish(sessionID, resolved)
    })

    const evaluate = Effect.fn("TurnCompletion.evaluate")(function* (sessionID: SessionID, input?: { agent?: string }) {
      const status = yield* resolve(sessionID, input)
      if (status) yield* publish(sessionID, status)
    })

    return Service.of({ resolve, evaluate, record })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Todo.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(HeadlessAI.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Agent.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Todo.node,
  Config.node,
  HeadlessAI.node,
  Session.node,
  Agent.node,
])

export * as TurnCompletion from "./turn-completion"

function mechanicalStatus(todos: Todo.Info[]): Status {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled") ? "done" : "incomplete"
}

function todoText(todos: Todo.Info[]) {
  return todos.map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}`).join("\n")
}

function messageText(message: CompletionMessage | undefined) {
  if (!message) return ""
  return message.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function latestUserTask(messages: CompletionMessage[]) {
  // A later admitted prompt belongs to the next answer. Continuations retain
  // their original user task even when it falls outside the eight-message tail.
  const lastAssistant = messages.findLastIndex((message) => message.info.role === "assistant")
  const task = messages
    .slice(0, lastAssistant < 0 ? messages.length : lastAssistant)
    .findLast((message) => message.info.role === "user")
  const text = messageText(task)
  if (text.length <= 12_000) return text
  return `${text.slice(0, 8_000)}\n[${text.length - 12_000} characters omitted from the middle of the user task]\n${text.slice(-4_000)}`
}

function artifactText(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.["opencode.plan_document"]
  if (!value || typeof value !== "object" || Array.isArray(value)) return "- plan: absent"
  const plan = value as Record<string, unknown>
  const revision = typeof plan.revision === "number" ? plan.revision : 0
  const markdown = typeof plan.markdown === "string" ? plan.markdown : ""
  return `- plan: present; revision=${revision}; status=${markdown.trim() ? "nonempty" : "empty"}`
}

export function historyStatus(messages: CompletionMessage[], agent?: string): Status | undefined {
  const lastAssistant = messages.toReversed().find((message) => message.info.role === "assistant")
  if (lastAssistant?.info.role !== "assistant") return undefined
  if (lastAssistant.info.error || lastAssistant.info.finish === "error") return "incomplete"
  if (lastAssistant.info.finish && lastAssistant.info.finish !== "stop" && lastAssistant.info.finish !== "tool-calls")
    return "incomplete"
  if (SessionTerminal.assistantResult(lastAssistant) === "incomplete") return "incomplete"
  if (lastAssistant.parts.some(isInterruptedTool)) return "incomplete"
  if (isReportOnlyReviewTask(messages)) {
    if (lastAssistant.info.finish !== "stop") return "incomplete"
    if (lastAssistant.parts.some((part) => part.type === "tool" && part.state?.status === "error")) return "incomplete"
    return reviewReport(messages) ? undefined : "incomplete"
  }
  if (explicitlyIncompleteReport(messageText(lastAssistant))) return "incomplete"
}

function isReportOnlyReviewTask(messages: CompletionMessage[]) {
  // Restrict the exception to the admitted report contract, before quoted evidence/schema.
  const header = latestUserTask(messages).split(/\nSchema:/i, 1)[0] ?? ""
  return (
    /\b(?:strikt|strict(?:ly)?)\s+report-only\b/i.test(header) &&
    /\b(?:antworte|respond|return)[^\n]{0,100}\b(?:ausschlie(?:ß|ss)lich|only|exactly)[^\n]{0,50}\bjson\b/i.test(header)
  )
}

const ReviewReport = Schema.Struct({
  findings: Schema.Array(Schema.Struct({
    title: Schema.NonEmptyString,
    userQuestion: Schema.NonEmptyString,
    track: Schema.NonEmptyString,
    targetProject: Schema.NonEmptyString,
    targetProjectPath: Schema.NonEmptyString,
    targetType: Schema.Literals(["skill", "rule", "memory", "code", "process", "git-history"]),
    evidence: Schema.NonEmptyString,
    practicalImpact: Schema.NonEmptyString,
    risk: Schema.Literals(["low", "medium", "high"]),
    suggestedFix: Schema.NonEmptyString,
    changeOptions: Schema.Array(Schema.Struct({ label: Schema.NonEmptyString, description: Schema.NonEmptyString })),
    testRequirement: Schema.NonEmptyString,
    confidence: Schema.Number,
  })),
  notes: Schema.Array(Schema.String),
  rejected: Schema.optional(Schema.Array(Schema.Struct({ title: Schema.NonEmptyString, reason: Schema.NonEmptyString }))),
})

function reviewReport(messages: CompletionMessage[]) {
  const last = messages.toReversed().find((message) => message.info.role === "assistant")
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(messageText(last))
  if (Option.isNone(parsed)) return
  const decoded = Schema.decodeUnknownOption(ReviewReport, { onExcessProperty: "error" })(parsed.value)
  if (Option.isNone(decoded)) return
  const report = decoded.value
  // Test requirements and review questions describe findings. Actual promises remain open;
  // inspect each leaf separately so a word in one field cannot match another field's result.
  const ownPromise = (text: string) =>
    /(?:^|[.!?]\s+)(?:ich|wir|i|we)\s+(?:werde[n]?|will|must|need|still)\b/i.test(text) ||
    (/\b(?:ich|wir|i|we)\b/i.test(text) && explicitlyIncompleteReport(text))
  if (report.notes.some((text) => ownPromise(text) || explicitlyIncompleteReport(text))) return
  if (report.findings.some((finding) =>
    !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1 ||
    Object.values(finding).some((value) => typeof value === "string" && ownPromise(value)) ||
    finding.changeOptions.some((option) => ownPromise(option.label) || ownPromise(option.description))
  )) return
  if (report.rejected?.some((finding) => ownPromise(finding.title) || ownPromise(finding.reason))) return
  return report
}

function explicitlyIncompleteReport(text: string) {
  const value = text.toLowerCase()
  // Direct announcements stay open even after another part of the work was
  // declared finished. Questions and descriptions of completed tests do not
  // start with this intent, and negated actions do not promise more work.
  if (
    [
      /(?:^|[.!?:]\s+|[—–]\s+)(?:ich|wir)\s+(?:pr(?:ü|ue)fe[n]?|untersuche[n]?|verifiziere[n]?|repariere[n]?|sammle[n]?|beginne[n]?|starte[n]?|fange[n]?|gleiche[n]?)\b/g,
      /(?:^|[.!?:]\s+)(?:die|den|das|der|eure|deine|unsere|diese[nrms]?)\b[^.!?\n]{0,100}\b(?:schreibe[n]?|lege[n]?)\s+(?:ich|wir)\b/g,
    ].some((pattern) =>
      Array.from(value.matchAll(pattern)).some((match) => {
        const clause = value.slice(match.index + match[0].length).split(/[.!?;,\n]/, 1)[0]
        if (/^\s*(?:(?:jetzt|nun|heute|hier|gerade|auch|aber)\s+)*(?:nicht|nichts|keine[nrms]?)\b/.test(clause))
          return false
        // "why it no longer works" negates the inspected condition, while
        // "I won't check the fix again" negates the announced action itself.
        return (
          /\b(?:warum|ob|dass|wie|weshalb)\b/.test(clause) ||
          !/\bnicht(?:\s+(?:mehr|erneut|nochmals|wieder))?\s*$/.test(clause)
        )
      }),
    )
  )
    return true
  // A negated statement that explicitly says no work remains ("keine offenen
  // Punkte", "no open items") is a final report, not a progress announcement:
  // it must not match the announcement patterns below.
  const negatedOpenWork =
    /(?:keine[\s\S]{0,40}offen|no[\s\S]{0,40}open[\s\S]{0,40}(?:items|work|points|todos)|nichts[\s\S]{0,40}offen|alles[\s\S]{0,40}(?:erledigt|fertig|abgeschlossen))/.test(
      value,
    )
  if (negatedOpenWork) return false
  return [
    /(?:could not|couldn't|was unable to)[\s\S]{0,160}(?:complete|finish|implement|apply|run|execute|test|verify)/,
    /(?:implementation|fix|change|visual[ -]?qa|review)[\s\S]{0,160}(?:must|needs to)[\s\S]{0,80}(?:next|new) session/,
    /(?:not|wasn't|isn't) (?:completed|finished|implemented|applied|tested|verified)/,
    /konnte[\s\S]{0,160}nicht[\s\S]{0,160}(?:zu ende bringen|abschlie(?:ß|ss)en|fertigstellen|anwenden|ausf(?:ü|ue)hren|testen|verifizieren|erledigen)/,
    /(?:umsetzung|implementierung|fix|(?:ä|ae)nderung|visual[ -]?qa|review)[\s\S]{0,160}(?:muss|steht)[\s\S]{0,100}(?:neue[nr]? session|noch aus)/,
    /(?:wurde|wurden)[\s\S]{0,120}nicht[\s\S]{0,120}(?:angewendet|umgesetzt|implementiert|ausgef(?:ü|ue)hrt|getestet|verifiziert|erledigt)/,
    // A diagnostic announcement that only promises the fix, test evidence, or
    // a follow-up report must not terminalize the turn while implementation
    // work is still open, even when the text is long enough to pass the
    // substantial-report length gate.
    /(?:fixe|repariere|untersuche|pr(?:ü|ue)fe|baue|sichere|melde mich)[\s\S]{0,200}(?:regressionstest|test-?beleg|ergebnis|nachweis|korrektur|behebung|runtime-?nachweis)/,
    /(?:ich|wir)[\s\S]{0,120}(?:pr(?:ü|ue)fe|untersuche|gleiche ab|baue|sichere)[\s\S]{0,200}(?:verlauf|runner-?timeout|completion-?logik|rest-?fehler|korrektur)/,
    // A progress announcement that reports intermediate evidence ("X green",
    // "tests pass") while naming still-open implementation work must not
    // terminalize either: length alone is not a completion proof. The
    // mechanical todo verdict below stays authoritative for open work.
    // "betroffen" and "offene Layer" describe verified code, not unfinished work.
    /(?:gr(?:ü|ue)n|bestanden|pass(?:ed|es)?|erledigt|fertig)[\s\S]{0,200}(?:ich arbeite|als n(?:ä|ae)chstes|jetzt noch|stehen noch aus|bleiben|\boffene[nrms]?\s+(?:[a-zäöüß\d]+-)*(?:arbeit|aufgaben?|punkte[n]?|todos?|(?:regressions?|abnahme|akzeptanz|unit|integrations)?tests?|checks?|abnahme|umsetzung|implementierung|review|regressionen?|(?:laufzeit)?nachweis(?:e[n]?)?|verifikation|pr(?:ü|ue)fung(?:en)?|belege?)\b|\b(?:arbeit|aufgaben?|punkte[n]?|todos?|(?:regressions?|abnahme|akzeptanz|unit|integrations)?tests?|checks?|abnahme|umsetzung|implementierung|review|regressionen?|(?:laufzeit)?nachweis(?:e[n]?)?|verifikation|pr(?:ü|ue)fung(?:en)?|belege?)\b\s+(?:(?:ist|sind|bleibt|bleiben|steht|stehen)\s+)?(?:(?:noch|weiterhin|derzeit)\s+)?offen\b|\boffen\s+(?:ist|sind|bleibt|bleiben|steht|stehen)\s+(?:(?:noch|weiterhin|derzeit)\s+)?(?:(?:die|der|das|unsere|ein(?:e[nrms]?)?)\s+)?(?:[a-zäöüß\d]+-)*(?:arbeit|aufgaben?|punkte[n]?|todos?|(?:regressions?|abnahme|akzeptanz|unit|integrations)?tests?|checks?|abnahme|umsetzung|implementierung|review|regressionen?|(?:laufzeit)?nachweis(?:e[n]?)?|verifikation|pr(?:ü|ue)fung(?:en)?|belege?)\b|weiter\b|danach|anschlie(?:ß|ss)end)/,
    /(?:ich arbeite|arbeite (?:jetzt|weiter)|setze fort|mache weiter)[\s\S]{0,200}(?:review|test|fix|budget|quota|regression|nachweis|beleg|rest|fehler)/,
  ].some((pattern) => pattern.test(value))
}

const SUBSTANTIAL_FINAL_REPORT_CHARS = 200

function deterministicFallback(messages: CompletionMessage[], todos: Todo.Info[]): Status | undefined {
  const lastAssistant = messages.toReversed().find((message) => message.info.role === "assistant")
  if (!lastAssistant || lastAssistant.info.role !== "assistant") return
  const result = SessionTerminal.assistantResult(lastAssistant)
  if (!result) return
  if (result === "done" && todos.some((todo) => todo.status === "pending" || todo.status === "in_progress"))
    return "incomplete"
  return result
}

export function hasSubstantialFinalReport(messages: CompletionMessage[]) {
  const lastAssistant = messages.toReversed().find((message) => message.info.role === "assistant")
  if (!lastAssistant || lastAssistant.info.role !== "assistant") return false
  if (lastAssistant.info.finish !== "stop" || lastAssistant.info.error) return false
  if (lastAssistant.parts.some(isInterruptedTool)) return false
  if (explicitlyIncompleteReport(messageText(lastAssistant))) return false
  return messageText(lastAssistant).length >= SUBSTANTIAL_FINAL_REPORT_CHARS
}

function isInterruptedTool(part: CompletionMessage["parts"][number]) {
  return part.type === "tool" && part.state?.status === "error" && part.state.metadata?.interrupted === true
}

const evaluateWithModel = Effect.fn("TurnCompletion.evaluateWithModel")(function* (input: {
  sessionID: SessionID
  todos: Todo.Info[]
  prompt: string
  target: Target
  headlessAI: HeadlessAI.Interface
  messages: CompletionMessage[]
  userTask: string
  artifacts: string
}) {
  const lastAssistant = input.messages.toReversed().find((message) => message.info.role === "assistant")
  // Older custom templates contain only todos. Keep their instructions and
  // append missing task/answer evidence rather than evaluating without context.
  const template = `${input.prompt}${input.prompt.includes("{userTask}") ? "" : "\n\nLatest admitted user task:\n{userTask}"}${input.prompt.includes("{lastMessage}") ? "" : "\n\nLast assistant response:\n{lastMessage}"}`
  const evidence: Record<string, string> = {
    "{userTask}": input.userTask || "(not available)",
    "{todos}": todoText(input.todos),
    "{lastMessage}": messageText(lastAssistant),
    "{artifacts}": input.artifacts,
    "{planRevision}": input.artifacts.match(/revision=(\d+)/)?.[1] ?? "0",
    "{planStatus}": input.artifacts.includes("status=nonempty") ? "nonempty" : "absent",
  }
  // Substitute once: task/answer text can itself contain literal template keys.
  const prompt = template.replace(
    /\{(?:userTask|todos|lastMessage|artifacts|planRevision|planStatus)\}/g,
    (key) => evidence[key]!,
  )

  const request: Parameters<HeadlessAI.Interface["text"]>[0] =
    input.target.kind === "chain"
      ? {
          chain: input.target.steps,
          generation: ModelRequest.helperGeneration({ temperature: 0 }),
          messages: [{ role: "user", content: prompt }],
        }
      : {
          model: input.target.modelID,
          variant: input.target.variant,
          generation: ModelRequest.helperGeneration({ temperature: 0 }),
          messages: [{ role: "user", content: prompt }],
        }

  const result = yield* input.headlessAI.text(request)

  const status = normalizeStatus(result.text)
  if (status) return status
  return yield* Effect.fail(new Error("Turn completion evaluator returned neither DONE nor INCOMPLETE"))
})

function normalizeStatus(text: string): Status | undefined {
  const first = text
    .trim()
    .toUpperCase()
    .split(/[^A-Z]+/)
    .find(Boolean)
  if (first === "DONE") return "done"
  if (first === "INCOMPLETE") return "incomplete"
  return undefined
}
