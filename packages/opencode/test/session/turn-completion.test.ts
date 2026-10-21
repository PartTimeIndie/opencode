import { describe, expect } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { completionRegistry } from "../../src/plugin/completion"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HeadlessAI } from "@/headless-ai"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TurnCompletion } from "../../src/session/turn-completion"
import { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const published: ("done" | "incomplete" | "unknown")[] = []
let messages: SessionV1.WithParts[] = []
let completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
let currentTodos: Todo.Info[] = []
const modelRequests: { model?: string; variant?: string }[] = []
const modelGenerations: { maxTokens?: number; temperature?: number }[] = []
const modelPrompts: string[] = []
let modelResponse = "DONE"
const modelResponses: string[] = []
let modelFailures = 0
let messageLimit = 0

const events = Layer.mock(EventV2Bridge.Service, {
  publish: (_definition, data) =>
    Effect.sync(() => {
      if (typeof data !== "object" || data === null || !("status" in data)) {
        return { id: EventV2.ID.create(), type: _definition.type, data }
      }
      if (data.status === "done" || data.status === "incomplete" || data.status === "unknown")
        published.push(data.status)
      return { id: EventV2.ID.create(), type: _definition.type, data }
    }),
})

const config = Layer.mock(Config.Service, {
  get: () => Effect.succeed(completionConfig),
})

const todos = Layer.mock(Todo.Service, {
  get: () => Effect.succeed(currentTodos),
})

const it = testEffect(
  TurnCompletion.layer.pipe(
    Layer.provide(events),
    Layer.provide(config),
    Layer.provide(todos),
    Layer.provide(
      Layer.mock(HeadlessAI.Service, {
        text: (input) =>
          Effect.suspend(() => {
            modelRequests.push({ model: input.model, variant: input.variant })
            modelGenerations.push({
              maxTokens: input.generation?.maxTokens,
              temperature: input.generation?.temperature,
            })
            if (typeof input.messages[0]?.content === "string") modelPrompts.push(input.messages[0].content)
            if (modelFailures > 0) {
              modelFailures--
              return Effect.fail(new Error("transient completion failure"))
            }
            return Effect.succeed({ text: modelResponses.shift() ?? modelResponse, model: input.model ?? "" })
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Session.Service, {
        messages: (input) =>
          Effect.sync(() => {
            messageLimit = input.limit ?? messages.length
            return messages.slice(-messageLimit)
          }),
        get: () => Effect.succeed({ directory: "/project", metadata: {} } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(Agent.Service, {
        get: (name) =>
          Effect.succeed({
            name,
            mode: "primary",
            permission: [],
            options: {},
            ...(name === "custom" ? { completion: { mode: "custom", prompt: "Judge this turn: {todos}" } } : {}),
          }),
      }),
    ),
  ),
)

const assistant = (
  sessionID: SessionID,
  input: {
    agent?: string
    error?: SessionV1.Assistant["error"]
    finish?: string
    text?: string
    tool?: "neutral_result"
  },
) =>
  ({
    info: {
      id: SessionV1.MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: SessionV1.MessageID.ascending(),
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      mode: "normal",
      agent: input.agent ?? "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: input.error,
      finish: input.finish,
    },
    parts: [
      ...(input.text
        ? ([
            {
              id: SessionV1.PartID.ascending(),
              sessionID,
              messageID: SessionV1.MessageID.ascending(),
              type: "text",
              text: input.text,
            },
          ] as const)
        : []),
      ...(input.tool
        ? [
            {
              id: SessionV1.PartID.ascending(),
              sessionID,
              messageID: SessionV1.MessageID.ascending(),
              type: "tool" as const,
              callID: "call_scheduled_job_result",
              tool: input.tool,
              state: {
                status: "completed" as const,
                input: { status: "success" },
                output: "Scheduled job result recorded.",
                title: "Scheduled job result",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
          ]
        : []),
    ],
  }) satisfies SessionV1.WithParts

const user = (sessionID: SessionID, text: string) =>
  ({
    info: {
      id: SessionV1.MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "daily-agent-review",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
    },
    parts: [
      {
        id: SessionV1.PartID.ascending(),
        sessionID,
        messageID: SessionV1.MessageID.ascending(),
        type: "text",
        text,
      },
    ],
  }) satisfies SessionV1.WithParts

describe("TurnCompletion", () => {
  for (const input of [
    { name: "unaffected restart", text: "Finaler Lauf auf dem Fix: 4/4 Passed, Exit-Code 0. Kein Service-Restart betroffen." },
    { name: "verified open layer", text: 'CRIKI_APPLY_VERIFICATION {"status":"applied","acceptancePassed":true,"summary":"PushInternal versteckt bei offener höherer Layer jetzt das oberste gleichliegende Element."}' },
    { name: "literal open layer", text: "4/4 Passed. Der Test deckt den Fall ab, in dem die höhere Layer offen ist." },
    { name: "open object after the check", text: "4/4 Passed. Ein offenes Menü bleibt im Akzeptanztest aktiv, während die gleichliegende Ansicht ausgeblendet wurde." },
  ]) {
    it.effect(`completes verified report with ${input.name} instead of reading an open-work substring`, () =>
      Effect.gen(function* () {
        completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
        currentTodos = [{ content: "Run the bound acceptance check", status: "completed", priority: "high" }]
        modelRequests.length = 0
        const supplied: TurnCompletion.CompletionMessage[] = [
          { info: { role: "user" }, parts: [{ type: "text", text: "Implement the bound stack fix and run its acceptance check." }] },
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: `${input.text}\n${"Die Implementierung und der kausale Vertragstest wurden im Zielpfad ausgeführt und dokumentiert. ".repeat(3)}` }] },
        ]
        expect(TurnCompletion.historyStatus(supplied)).toBeUndefined()
        expect(TurnCompletion.hasSubstantialFinalReport(supplied)).toBe(true)
        const completion = yield* TurnCompletion.Service
        expect(yield* completion.resolve(SessionID.make("ses_open_context"), { messages: supplied })).toBe("done")
        expect(modelRequests).toHaveLength(0)
      }),
    )
  }

  for (const text of [
    "4/4 Passed. Die Abnahme bleibt noch offen.",
    "4/4 Passed. Offene Tests müssen noch ausgeführt werden.",
    "4/4 Passed. Es gibt noch offene Aufgaben.",
    "4/4 Passed. Die geforderten Checks sind offen.",
    "4/4 Passed. Der Runtime-Nachweis ist noch offen.",
    "4/4 Passed. Die Verifikation ist noch offen.",
    "4/4 Passed. Die Prüfung ist weiterhin offen.",
    "4/4 Passed. Der Beleg ist noch offen.",
    "4/4 Passed. Offen sind noch die Tests.",
    "4/4 Passed. Offen ist die Abnahme.",
    "4/4 Passed. Noch offen ist der Runtime-Nachweis.",
    "4/4 Passed. Es gibt noch offene Runtime-Nachweise.",
    "4/4 Passed. Die Regressionstests sind noch offen.",
    "4/4 Passed. Offen ist noch der Laufzeitnachweis.",
    "4/4 Passed. Die Abnahmetests stehen noch offen.",
    "4/4 Passed. Ich prüfe jetzt noch die Abnahme. CRIKI_APPLY_VERIFICATION {\"status\":\"applied\",\"acceptancePassed\":true}",
  ]) {
    it.effect(`keeps actual open work incomplete after successful checks: ${text.slice(0, 60)}`, () =>
      Effect.gen(function* () {
        completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
        currentTodos = []
        modelRequests.length = 0
        const supplied: TurnCompletion.CompletionMessage[] = [
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: `${text} ${"Lokale Messwerte und Regressionsergebnisse sind dokumentiert. ".repeat(4)}` }] },
        ]
        expect(TurnCompletion.historyStatus(supplied)).toBe("incomplete")
        expect(TurnCompletion.hasSubstantialFinalReport(supplied)).toBe(false)
        const completion = yield* TurnCompletion.Service
        expect(yield* completion.resolve(SessionID.make("ses_real_open_work"), { messages: supplied })).toBe("incomplete")
        expect(modelRequests).toHaveLength(0)
      }),
    )
  }

  const reviewTask = "Du bist ein Reviewer. Dieser Nachtlauf ist strikt report-only. Fuehre keinen Fix aus. Antworte ausschliesslich als JSON ohne Markdown.\nSchema: findings, notes."
  const reviewFinding = {
    title: "Ein belegter Befund", userQuestion: "Soll die beschriebene Regel angepasst werden?", track: "code_review",
    targetProject: "fixture", targetProjectPath: "/fixture", targetType: "code", evidence: "Die Quelle wurde gelesen.",
    practicalImpact: "Die Regel wirkt im laufenden Fenster nicht.", risk: "low", suggestedFix: "Die Aktualisierung erweitern.",
    changeOptions: [], testRequirement: "Das Ergebnis nach der vorgeschlagenen Aenderung vergleichen.", confidence: 0.9,
  }
  for (const input of [
    { name: "review test requirement", field: "testRequirement", text: "Wiederholtest: pruefen, dass die Version aktualisiert wird; Exitcode und Ergebnis dokumentieren." },
    { name: "review and synthesis question", field: "userQuestion", text: "Darf eine Regelaenderung als erledigt gemeldet werden, wenn nicht getestet wurde, ob sie in schon offenen Unterhaltungen wirkt?" },
    { name: "PDF review test requirement", field: "testRequirement", text: "PDF-Testseite im Normalfall pruefen und im gestoerten Fall pruefen; Wartezeit messen und das Ergebnis festhalten." },
  ]) {
    it.effect(`completes a report-only JSON ${input.name} without mistaking a finding for work`, () => Effect.gen(function* () {
      currentTodos = []
      completionConfig = { session: { turn_completion: { enabled: true, model: "test/verdict" } } } as ConfigV1.Info
      modelRequests.length = 0
      const supplied: TurnCompletion.CompletionMessage[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: reviewTask }] },
        ...Array.from({ length: 12 }, (): TurnCompletion.CompletionMessage => ({ info: { role: "assistant", finish: "tool-calls" }, parts: [] })),
        { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: JSON.stringify({ findings: [{ ...reviewFinding, [input.field]: input.text }], notes: [] }) }] },
      ]
      const completion = yield* TurnCompletion.Service
      expect(yield* completion.resolve(SessionID.make(`ses_review_${input.field}`), { messages: supplied })).toBe("done")
      expect(modelRequests).toHaveLength(0)
    }))
  }
  for (const input of [
    { name: "pending todos", todos: "pending" },
    { name: "in-progress todos", todos: "in_progress" },
    { name: "prose before JSON", prefix: "Ich pruefe jetzt noch die Abnahme.\n" },
    { name: "prose after JSON", suffix: "\nIch pruefe jetzt noch die Abnahme." },
    { name: "two JSON objects", suffix: "\n{}" },
    { name: "unterminated JSON", truncate: true },
    { name: "missing finding fields", finding: { title: "Not a complete finding" } },
    { name: "unrelated JSON", report: { status: "done", message: "x".repeat(250) } },
    { name: "promised work in notes", notes: ["Ich pruefe jetzt noch den letzten Nachweis."] },
    { name: "promised work in a finding", finding: { ...reviewFinding, testRequirement: "Ich pruefe jetzt noch den letzten Nachweis." } },
    { name: "promised work in a change option", finding: { ...reviewFinding, changeOptions: [{ label: "Pruefung", description: "Ich pruefe jetzt noch die Abnahme." }] } },
    { name: "promised work in a rejected finding", report: { findings: [reviewFinding], notes: [], rejected: [{ title: "Andere Pruefung", reason: "Ich pruefe jetzt noch die Abnahme." }] } },
    { name: "extra promisedWork field", report: { findings: [reviewFinding], notes: [], promisedWork: "Ich pruefe jetzt noch den Nachweis." } },
    { name: "provider error", error: true },
    { name: "provider length finish", finish: "length" },
    { name: "missing provider finish", missingFinish: true },
    { name: "unfinished tool-calls finish", finish: "tool-calls" },
    { name: "interrupted tool", toolError: true },
    { name: "implementation instead of review", task: "Implementiere den Fix und pruefe das Ergebnis. Antworte als JSON." },
  ]) {
    it.effect(`keeps report-only JSON incomplete for ${input.name}`, () => Effect.gen(function* () {
      currentTodos = input.todos ? [{ content: "Finish the admitted work", status: input.todos as "pending" | "in_progress", priority: "high" }] : []
      completionConfig = { session: { turn_completion: { enabled: true, model: "test/verdict" } } } as ConfigV1.Info
      const body = JSON.stringify(input.report ?? { findings: [input.finding ?? reviewFinding], notes: input.notes ?? [] })
      modelResponse = input.task ? "INCOMPLETE" : "DONE"
      modelRequests.length = 0
      const supplied: TurnCompletion.CompletionMessage[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: input.task ?? reviewTask }] },
        { info: { role: "assistant", finish: input.missingFinish ? undefined : input.finish ?? "stop", ...(input.error ? { error: new Error("Provider failed") } : {}) }, parts: [
          { type: "text", text: `${input.prefix ?? ""}${input.truncate ? body.slice(0, -1) : body}${input.suffix ?? ""}` },
          ...(input.toolError ? [{ type: "tool", tool: "edit", state: { status: "error", metadata: { interrupted: true } } }] : []),
        ] },
      ]
      const completion = yield* TurnCompletion.Service
      expect(yield* completion.resolve(SessionID.make("ses_review_negative"), { messages: supplied })).toBe("incomplete")
      if (input.task) expect(modelRequests).toHaveLength(1)
      modelResponse = "DONE"
    }))
  }
  for (const input of [
    { name: "default", turns: 0 },
    { name: "long history", turns: 12 },
    { name: "custom agent", turns: 0, agent: "custom" },
    { name: "custom template", turns: 0, prompt: "Judge {userTask} against {lastMessage}. {todos}" },
    { name: "legacy template", turns: 0, prompt: "Judge this turn: {todos}" },
  ]) {
    it.effect(`supplies the admitted JSON task and answer to the ${input.name} evaluator`, () =>
      Effect.gen(function* () {
        const sessionID = SessionID.make(`ses_context_${input.name.replaceAll(" ", "_")}`)
        const task = 'Return exactly {"findings":[],"notes":["night-output-probe-ok"]}. Do not use tools or add prose.'
        const answer = '{"findings":[],"notes":["night-output-probe-ok"]}'
        completionConfig = {
          session: { turn_completion: { enabled: true, model: "test/verdict", prompt: input.prompt } },
        } as ConfigV1.Info
        currentTodos = []
        modelResponse = "DONE"
        modelPrompts.length = 0
        const supplied: TurnCompletion.CompletionMessage[] = [
          { info: { role: "user" }, parts: [{ type: "text", text: "Superseded earlier task" }] },
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "Earlier answer" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: task }] },
          ...Array.from({ length: input.turns }, (): TurnCompletion.CompletionMessage => ({
            info: { role: "assistant", finish: "tool-calls" },
            parts: [],
          })),
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: answer }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "Later task awaiting its own answer" }] },
        ]
        const completion = yield* TurnCompletion.Service
        expect(yield* completion.resolve(sessionID, { messages: supplied, agent: input.agent })).toBe("done")
        expect(modelPrompts).toHaveLength(1)
        expect(modelPrompts[0]).toContain(task)
        expect(modelPrompts[0]).toContain(answer)
        expect(modelPrompts[0]).not.toContain("Superseded earlier task")
        expect(modelPrompts[0]).not.toContain("Later task awaiting its own answer")
        expect(modelPrompts[0]).not.toContain("{userTask}")
      }),
    )
  }

  it.effect("bounds a large admitted task while retaining its opening and exact final JSON instruction", () =>
    Effect.gen(function* () {
      completionConfig = { session: { turn_completion: { enabled: true, model: "test/verdict" } } } as ConfigV1.Info
      currentTodos = []
      modelResponse = "DONE"
      modelPrompts.length = 0
      const completion = yield* TurnCompletion.Service
      yield* completion.resolve(SessionID.make("ses_large_context"), {
        messages: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "TASK START\n" + "x".repeat(100_000) + '\nReturn exactly {"ok":true}.' }],
          },
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: '{"ok":true}' }] },
        ],
      })
      expect(modelPrompts[0]).toContain("TASK START")
      expect(modelPrompts[0]).toContain('Return exactly {"ok":true}.')
      expect(modelPrompts[0]!.length).toBeLessThan(14_000)
      expect(modelPrompts[0]).toContain("characters omitted")
    }),
  )

  it.effect("preserves literal evaluator placeholders inside the task and current answer", () =>
    Effect.gen(function* () {
      completionConfig = { session: { turn_completion: { enabled: true, model: "test/verdict" } } } as ConfigV1.Info
      currentTodos = []
      modelResponse = "DONE"
      modelPrompts.length = 0
      const task = 'Return exactly {"value":"{todos} {lastMessage} {artifacts} {planStatus}"}.'
      const answer = '{"value":"{todos} {lastMessage} {artifacts} {planStatus}"}'
      const completion = yield* TurnCompletion.Service
      yield* completion.resolve(SessionID.make("ses_literal_context"), {
        messages: [
          { info: { role: "user" }, parts: [{ type: "text", text: task }] },
          { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: answer }] },
        ],
      })
      expect(modelPrompts[0]).toContain(task)
      expect(modelPrompts[0]).toContain(answer)
    }),
  )

  for (const text of [
    "Die Änderung ist fertig. Soll ich prüfen, ob weitere Probleme auftreten?",
    "Alles ist erledigt. Ich prüfe nichts mehr. Die Ergebnisse und Messwerte sind vollständig erfasst. Der Fehler wurde behoben und die Regression mit lokalen Streams abgesichert. Der fertige Bericht enthält alle durchgeführten Tests und ihre Abschlusszustände.",
    "Alles ist erledigt. Ich prüfe jetzt nichts mehr.",
    "Alles ist erledigt. Ich prüfe den Fix nicht erneut. Die Ergebnisse und Messwerte sind vollständig erfasst. Der Fehler wurde behoben und die Regression mit lokalen Streams abgesichert. Der fertige Bericht enthält alle durchgeführten Tests und ihre Abschlusszustände.",
    "Der Fehler ist behoben. Die Regression wurde erfolgreich getestet. Im Test prüfe ich beide Provider-Pfade mit lokalen Streams und messe die gespeicherten Abschlusszustände. Die Prüfung enthält auch echte Unterbrechungen, Messwerte und reproduzierbare Beispiele.",
  ]) {
    it.effect(`does not veto a human question or finished test description: ${text.slice(0, 45)}`, () =>
      Effect.sync(() => {
        const evidence = [{ info: { role: "assistant" as const, finish: "stop" }, parts: [{ type: "text", text }] }]
        expect(TurnCompletion.historyStatus(evidence)).toBeUndefined()
        expect(TurnCompletion.hasSubstantialFinalReport(evidence)).toBe(text.length >= 200)
      }),
    )
  }

  for (const text of [
    "Erst verifizieren, dann reparieren — ich prüfe den Choice-Prefab-Stand, bevor ich ihn anfasse.",
    "Eure Bild-Regel schreibe ich in die AGENTS.md und lege den neuen UI-Skill an.",
    "51/51 ist grün. Jetzt noch die fokussierte Abnahme.",
    "Ich gleiche jetzt den Ausführungsvertrag mit den Tests ab und stelle die Änderung fertig.",
    "Ich prüfe, warum der Provider nicht mehr antwortet.",
    "Alle Code-Fixes sind umgesetzt. Es gibt keine offenen Codepunkte mehr. Ich prüfe jetzt noch den Desktop-Neustart und die fokussierte Abnahme. Die Unit-Tests sind grün und der Provider-Stream wurde mit Grenztests abgesichert.",
    "Verstanden — erst die drei Bugfixes, keine Videos. Ich fange beim tatsächlichen Stand an: Ich prüfe die vorhandenen Quellen und die letzten Ergebnisse. Danach folgen die Korrekturen und die passenden Prüfungen, sobald die Ursachen klar sind.",
  ]) {
    it.effect(`continue evidence stays incomplete without todos: ${text.slice(0, 45)}`, () =>
      Effect.gen(function* () {
        published.length = 0
        modelRequests.length = 0
        messages = []
        currentTodos = []
        completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
        const turnCompletion = yield* TurnCompletion.Service
        expect(
          yield* turnCompletion.resolve(SessionID.make("ses_continue_evidence"), {
            messages: [{ info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text }] }],
          }),
        ).toBe("incomplete")
        expect(modelRequests).toEqual([])
      }),
    )
  }

  it.effect("evaluates V2 final evidence instead of empty legacy history and stale todos", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      messages = []
      currentTodos = [{ content: "old Unity acceptance", status: "pending", priority: "high" }]
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      const turnCompletion = yield* TurnCompletion.Service
      const result = yield* turnCompletion.resolve(SessionID.make("ses_v2_evidence"), {
        messages: [
          {
            info: { role: "assistant", finish: "stop" },
            parts: [
              {
                type: "text",
                text: "The requested stack timing fix is implemented and synchronized. Runtime and editor sources compiled successfully; 47 managed test cases passed. Unity remained under user control. The native regression test was added and compiled; its execution is deferred to the human smoke test.",
              },
            ],
          },
        ],
      })
      expect(result).toBe("done")
      expect(modelRequests).toEqual([])
    }),
  )

  it.effect("never marks a long diagnostic announcement done while implementation todos stay open", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      messages = []
      currentTodos = [
        { content: "implement provider-stream fix", status: "in_progress", priority: "high" },
        { content: "run regression tests and report evidence", status: "pending", priority: "high" },
      ]
      completionConfig = {
        session: { turn_completion: { enabled: true } },
      } as ConfigV1.Info
      const turnCompletion = yield* TurnCompletion.Service
      const result = yield* turnCompletion.resolve(SessionID.make("ses_announcement_only"), {
        messages: [
          {
            info: { role: "assistant", finish: "stop" },
            parts: [
              {
                type: "text",
                text: "Fixe ich — ich schaue mir Verlauf und Ursache direkt an. Der neue Abbruch sieht nach demselben Muster aus, ich grabe mich in Runner und Logs. Dein Follow-up sitzt oben auf dem Stapel, ich gleiche Verlauf, Runner-Timeouts und Completion-Logik ab, um den echten Rest-Fehler zu finden. Ich baue dafür einen Regressionstest und melde mich mit Ergebnis und Test-Belegen, sobald Fix und Nachweis stehen.",
              },
            ],
          },
        ],
      })
      // Even a longer diagnostic announcement that only promises the fix must
      // not terminalize the activity while its implementation todos are still
      // open. Without a configured evaluator the mechanical todo verdict
      // applies; the "substantial final report" fast path must not apply to
      // announcement-only text without implementation evidence.
      expect(modelRequests).toHaveLength(0)
      expect(result).toBe("incomplete")
    }),
  )

  it.effect("never marks a real German progress announcement done while C0 work stays open", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      messages = []
      // Open C0 implementation todos: the shared transport budget fix and its
      // regression evidence are still unfinished at announcement time.
      currentTodos = [
        {
          content: "Fix shared transport retry budget across early retries and fresh-turn recovery",
          status: "in_progress",
          priority: "high",
        },
        { content: "Add terminal quota/auth regression tests with evidence", status: "pending", priority: "high" },
        {
          content: "Verify LocalExecution durable failed for event-only provider errors",
          status: "pending",
          priority: "high",
        },
      ]
      completionConfig = {
        session: { turn_completion: { enabled: true } },
      } as ConfigV1.Info
      const turnCompletion = yield* TurnCompletion.Service
      // Exact German progress announcement from the live C0 session: it reports
      // intermediate test evidence but implements nothing and finishes nothing.
      // At 300+ chars it passes the substantial-report length gate, so only the
      // announcement guard can keep the turn incomplete.
      const result = yield* turnCompletion.resolve(SessionID.make("ses_c0_progress_announcement"), {
        messages: [
          {
            info: { role: "assistant", finish: "stop" },
            parts: [
              {
                type: "text",
                text: "Quota-Boundary und Resume-Policy grün. Provider-Failure 13/0, Resume 10/0, LLM-Executor 21/0. Ich arbeite jetzt am geteilten Transportbudget im Runner weiter und sichere danach den aktuellen Diff-Stand, ohne fertige Patches zu wiederholen. Die Review-Findings mit Step-Limit, Empty-Completion und Terminal-Quota stehen noch aus.",
              },
            ],
          },
        ],
      })
      expect(modelRequests).toHaveLength(0)
      expect(result).toBe("incomplete")
    }),
  )

  it.effect("marks a German final report done when it explicitly states no work remains", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      messages = []
      currentTodos = [
        { content: "Fix shared transport retry budget", status: "completed", priority: "high" },
        { content: "Add regression tests", status: "completed", priority: "high" },
      ]
      completionConfig = {
        session: { turn_completion: { enabled: true } },
      } as ConfigV1.Info
      const turnCompletion = yield* TurnCompletion.Service
      const result = yield* turnCompletion.resolve(SessionID.make("ses_c0_final_report"), {
        messages: [
          {
            info: { role: "assistant", finish: "stop" },
            parts: [
              {
                type: "text",
                text: "Alle C0-Arbeiten sind abgeschlossen und verifiziert. Runner-Suite 185/0, Parity 51/0, Recovery 40/0, Turn-Completion 60/0, beide Typechecks Exit 0. Alle Review-Findings sind umgesetzt und die Regressionstests belegen die Verträge. Es gibt keine offenen Punkte mehr, alle Todos sind erledigt und die Evidence liegt vollständig vor.",
              },
            ],
          },
        ],
      })
      expect(modelRequests).toHaveLength(0)
      expect(result).toBe("done")
    }),
  )

  it.effect("preserves plugin vetoes when V2 supplies successful completion evidence", () =>
    Effect.gen(function* () {
      messages = []
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      const unregister = completionRegistry.register("/project", async (input) => {
        expect(input.messages.at(-1)?.text).toBe("Implemented and tested. ".repeat(12).trim())
        return "incomplete"
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const turnCompletion = yield* TurnCompletion.Service
      expect(
        yield* turnCompletion.resolve(SessionID.make("ses_v2_policy"), {
          messages: [
            {
              info: { role: "assistant", finish: "stop" },
              parts: [{ type: "text", text: "Implemented and tested. ".repeat(12) }],
            },
          ],
        }),
      ).toBe("incomplete")
    }),
  )

  it.effect("does not let a V2 final report hide an interrupted tool", () =>
    Effect.gen(function* () {
      messages = []
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      const turnCompletion = yield* TurnCompletion.Service
      expect(
        yield* turnCompletion.resolve(SessionID.make("ses_v2_interrupted"), {
          messages: [
            {
              info: { role: "assistant", finish: "stop" },
              parts: [
                { type: "text", text: "Implemented and tested. ".repeat(12) },
                { type: "tool", tool: "bash", state: { status: "error", metadata: { interrupted: true } } },
              ],
            },
          ],
        }),
      ).toBe("incomplete")
    }),
  )

  it.effect("publishes done for sessions without todos", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = []
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(SessionID.make("ses_no_todos"))
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("does not infer a special completion state from the plan agent name", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      const sessionID = SessionID.make("ses_plan")
      messages = [assistant(sessionID, { agent: "plan" })]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("publishes incomplete when the last assistant was aborted", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      const sessionID = SessionID.make("ses_aborted")
      messages = [
        assistant(sessionID, {
          error: new SessionV1.AbortedError({ message: "aborted" }).toObject() as SessionV1.Assistant["error"],
        }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("publishes incomplete for a stopped assistant turn with no output", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      const sessionID = SessionID.make("ses_empty_stopped")
      messages = [assistant(sessionID, { finish: "stop" })]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("publishes incomplete when the provider stops at its length limit", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      currentTodos = []
      const sessionID = SessionID.make("ses_length_limited")
      messages = [assistant(sessionID, { finish: "length", text: " " })]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
      expect(modelRequests).toHaveLength(0)
    }),
  )

  it.effect("honors a plugin-owned completion requirement", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      const dispose = completionRegistry.register("/project", async (input) => {
        expect(input.messages[0]?.text).toContain("neutral-contract")
        return "incomplete"
      })
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const sessionID = SessionID.make("ses_scheduled_missing_result")
      messages = [
        user(sessionID, `Run the job.\n\n${"neutral-contract"}`),
        assistant(sessionID, { finish: "stop", text: "I will show the required review surface now." }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("honors plugin-owned requirements when the optional completion evaluator is disabled", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = {} as ConfigV1.Info
      const dispose = completionRegistry.register("/project", async () => "incomplete")
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const sessionID = SessionID.make("ses_required_plugin_completion")
      messages = [
        user(sessionID, "Run the required plugin workflow."),
        assistant(sessionID, { finish: "stop", text: "Skipped it." }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("gives plugin requirements enough history to retain an older workflow request", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = {} as ConfigV1.Info
      const dispose = completionRegistry.register("/project", async (input) =>
        input.messages.some((message) => message.text.includes("required-workflow")) ? "incomplete" : undefined,
      )
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const sessionID = SessionID.make("ses_required_plugin_history")
      messages = [
        user(sessionID, "Run required-workflow."),
        ...Array.from({ length: 10 }, (_, index) =>
          assistant(sessionID, { finish: "stop", text: `Intermediate response ${index}` }),
        ),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(messageLimit).toBe(200)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("does not let an explicit done status bypass a plugin requirement", () =>
    Effect.gen(function* () {
      completionConfig = {} as ConfigV1.Info
      const dispose = completionRegistry.register("/project", async () => "incomplete")
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const sessionID = SessionID.make("ses_required_plugin_explicit_status")
      messages = [user(sessionID, "Run the required plugin workflow.")]
      const turnCompletion = yield* TurnCompletion.Service
      expect(yield* turnCompletion.resolve(sessionID, { status: "done" })).toBe("incomplete")
    }),
  )

  it.effect("allows normal completion when plugin requirements are satisfied", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      const dispose = completionRegistry.register("/project", async (input) => {
        expect(input.messages[1]?.tools).toEqual([{ name: "neutral_result", status: "completed" }])
        return undefined
      })
      yield* Effect.addFinalizer(() => Effect.sync(dispose))
      const sessionID = SessionID.make("ses_scheduled_reported_result")
      messages = [
        user(sessionID, `Run the job.\n\n${"neutral-contract"}`),
        assistant(sessionID, { finish: "tool-calls", tool: "neutral_result" }),
        assistant(sessionID, { finish: "stop", text: "Scheduled work completed." }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("uses the completion evaluator for a short stopped response while todos remain open", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      currentTodos = [{ content: "finish implementation", status: "pending", priority: "high" }]
      const sessionID = SessionID.make("ses_open_todo_completion_check")
      messages = [assistant(sessionID, { finish: "stop", text: "Implemented a first part." })]
      modelResponse = "INCOMPLETE"
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(modelRequests).toHaveLength(1)
      expect(published).toEqual(["incomplete"])
      modelResponse = "DONE"
    }),
  )

  it.effect("keeps the substantial final report fast path with stale pending todos", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      currentTodos = [{ content: "stale implementation todo", status: "pending", priority: "high" }]
      const sessionID = SessionID.make("ses_substantial_final_report")
      messages = [
        assistant(sessionID, {
          finish: "stop",
          text: `Auftrag abgeschlossen. ${"Verified implementation details. ".repeat(10)}`,
        }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["done"])
      expect(modelRequests).toHaveLength(0)
    }),
  )

  it.effect("falls back to a deterministic done result for successful text when the evaluator is unavailable", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      modelFailures = 3
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-luna" } },
      } as ConfigV1.Info
      const sessionID = SessionID.make("ses_semantic_text_fallback")
      messages = [assistant(sessionID, { finish: "stop", text: "Completed briefly." })]

      const turnCompletion = yield* TurnCompletion.Service
      const fiber = yield* turnCompletion.evaluate(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(modelRequests).toHaveLength(3)
      expect(published).toEqual(["done"])
      modelFailures = 0
    }),
  )

  it.effect("keeps a started but empty provider response incomplete even with usage", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      const sessionID = SessionID.make("ses_semantic_empty_provider")
      const empty = assistant(sessionID, { finish: "stop" })
      empty.info.tokens.output = 1
      messages = [empty]

      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)

      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("falls back to a deterministic done result for a settled provider tool end", () =>
    Effect.gen(function* () {
      published.length = 0
      modelRequests.length = 0
      modelFailures = 3
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-luna" } },
      } as ConfigV1.Info
      const sessionID = SessionID.make("ses_semantic_tool_fallback")
      messages = [assistant(sessionID, { finish: "tool-calls", tool: "neutral_result" })]

      const turnCompletion = yield* TurnCompletion.Service
      const fiber = yield* turnCompletion.evaluate(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(modelRequests).toHaveLength(3)
      expect(published).toEqual(["done"])
      modelFailures = 0
    }),
  )

  it.effect("keeps a substantial final report incomplete when it explicitly defers the implementation", () =>
    Effect.gen(function* () {
      published.length = 0
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      currentTodos = []
      const sessionID = SessionID.make("ses_explicitly_incomplete_report")
      messages = [
        assistant(sessionID, {
          finish: "stop",
          text: `Die Ursache ist gefunden. ${"Technical investigation details. ".repeat(8)} Die Umsetzung muss aber in einer neuen Session erfolgen; Visual-QA wurde nicht ausgeführt.`,
        }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("keeps an English tool-budget handoff incomplete", () =>
    Effect.gen(function* () {
      published.length = 0
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      currentTodos = []
      const sessionID = SessionID.make("ses_english_incomplete_report")
      messages = [
        assistant(sessionID, {
          finish: "stop",
          text: `The investigation identified the likely root cause. ${"Evidence and file references. ".repeat(8)} I could not finish the implementation or run the requested tests because the tool budget was exhausted.`,
        }),
      ]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("keeps a short stopped response incomplete while work remains open", () =>
    Effect.gen(function* () {
      published.length = 0
      completionConfig = { session: { turn_completion: { enabled: true } } } as ConfigV1.Info
      currentTodos = [{ content: "finish implementation", status: "pending", priority: "high" }]
      const sessionID = SessionID.make("ses_open_work")
      messages = [assistant(sessionID, { finish: "stop", text: "I still need to finish the implementation." })]
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("gives the completion evaluator the last response so a plan-only turn can be rejected", () =>
    Effect.gen(function* () {
      published.length = 0
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openrouter/openrouter/free" } },
      } as ConfigV1.Info
      const sessionID = SessionID.make("ses_plan_only_completion")
      messages = [
        assistant(sessionID, {
          finish: "stop",
          text: "Read-only Diagnose. Ich lege eine Task-Reihenfolge an und erkunde dann gezielt.",
        }),
      ]
      modelPrompts.length = 0
      modelResponse = "INCOMPLETE"
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(sessionID)
      expect(modelPrompts).toHaveLength(1)
      expect(modelPrompts[0]).toContain("Last assistant response:")
      expect(modelPrompts[0]).toContain("Ich lege eine Task-Reihenfolge an")
      expect(published).toEqual(["incomplete"])
      modelResponse = "DONE"
    }),
  )

  it.effect("passes the configured model variant to the completion evaluator", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = [{ content: "verify scheduler", status: "pending", priority: "high" }]
      completionConfig = {
        session: {
          turn_completion: {
            enabled: true,
            model: "openai/gpt-5.6-sol",
            variant: "high",
          },
        },
      } as ConfigV1.Info
      modelRequests.length = 0
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(SessionID.make("ses_model_variant"))
      expect(modelRequests).toEqual([{ model: "openai/gpt-5.6-sol", variant: "high" }])
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("reserves reasoning capacity instead of capping the whole completion evaluator at 16 tokens", () =>
    Effect.gen(function* () {
      published.length = 0
      modelGenerations.length = 0
      messages = []
      currentTodos = [{ content: "verify scheduler", status: "pending", priority: "high" }]
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "opencode-go/muse-spark-1.3-contributor" } },
      } as ConfigV1.Info

      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(SessionID.make("ses_go_completion_budget"))

      expect(modelGenerations).toEqual([{ temperature: 0, maxTokens: 8192 }])
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("runs a custom completion evaluator even when the todo list is empty", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      modelRequests.length = 0
      modelResponse = "INCOMPLETE"
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(SessionID.make("ses_custom_no_todos"), { agent: "custom" })
      expect(modelRequests).toEqual([{ model: "openai/gpt-5.6-sol", variant: undefined }])
      expect(published).toEqual(["incomplete"])
      modelResponse = "DONE"
    }),
  )

  it.effect("retries transient completion model failures before publishing", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = [{ content: "verify retry", status: "pending", priority: "high" }]
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      modelRequests.length = 0
      modelFailures = 2
      modelResponse = "DONE"
      const turnCompletion = yield* TurnCompletion.Service

      const fiber = yield* turnCompletion.evaluate(SessionID.make("ses_completion_retry")).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(modelRequests).toHaveLength(3)
      expect(published).toEqual(["done"])
    }),
  )

  it.effect("retries an unparseable completion response before using a valid result", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      modelRequests.length = 0
      modelResponses.push("I am not sure", "INCOMPLETE")
      const turnCompletion = yield* TurnCompletion.Service

      const fiber = yield* turnCompletion.evaluate(SessionID.make("ses_completion_parse_retry")).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(modelRequests).toHaveLength(2)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("publishes unknown after three unparseable completion responses", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = [{ content: "still pending", status: "pending", priority: "high" }]
      completionConfig = {
        session: { turn_completion: { enabled: true, model: "openai/gpt-5.6-sol" } },
      } as ConfigV1.Info
      modelRequests.length = 0
      modelResponses.push("unknown", "maybe", "")
      const turnCompletion = yield* TurnCompletion.Service

      const fiber = yield* turnCompletion
        .evaluate(SessionID.make("ses_completion_parse_fallback"))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)

      expect(modelRequests).toHaveLength(3)
      expect(published).toEqual(["unknown"])
    }),
  )

  it.effect("falls back mechanically only when no completion target is configured", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = [{ content: "still pending", status: "pending", priority: "high" }]
      completionConfig = {
        session: { turn_completion: { enabled: true } },
      } as ConfigV1.Info
      modelRequests.length = 0
      const turnCompletion = yield* TurnCompletion.Service
      yield* turnCompletion.evaluate(SessionID.make("ses_completion_mechanical"))

      expect(modelRequests).toHaveLength(0)
      expect(published).toEqual(["incomplete"])
    }),
  )

  it.effect("resolves a chain target and reports unknown when the chain id is missing", () =>
    Effect.gen(function* () {
      published.length = 0
      messages = []
      currentTodos = []
      completionConfig = {
        session: { turn_completion: { enabled: true, target: "chain:verdicts" } },
        model_chains: [
          {
            id: "verdicts",
            name: "Verdicts",
            steps: [{ providerID: "openai", modelID: "gpt-5.6-sol" }],
          },
        ],
      } as unknown as ConfigV1.Info
      modelRequests.length = 0
      const turnCompletion = yield* TurnCompletion.Service

      yield* turnCompletion.evaluate(SessionID.make("ses_completion_chain_ok"))
      expect(modelRequests).toHaveLength(1)
      expect(published).toEqual(["done"])

      published.length = 0
      modelRequests.length = 0
      completionConfig = {
        session: { turn_completion: { enabled: true, target: "chain:missing" } },
        model_chains: [
          {
            id: "verdicts",
            name: "Verdicts",
            steps: [{ providerID: "openai", modelID: "gpt-5.6-sol" }],
          },
        ],
      } as unknown as ConfigV1.Info
      yield* turnCompletion.evaluate(SessionID.make("ses_completion_chain_missing"))
      expect(modelRequests).toHaveLength(0)
      expect(published).toEqual(["unknown"])
    }),
  )
})
