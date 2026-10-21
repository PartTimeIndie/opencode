import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_question_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let captured: QuestionV2.AskInput | undefined
let presented: QuestionV2.PresentInput | undefined
let reject = false
let deny = false
const capturedInput = () => captured
const presentedInput = () => presented
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
        Effect.andThen(
          reject
            ? Effect.fail(new QuestionV2.RejectedError())
            : Effect.succeed(input.questions.map((_, index) => (index === 0 ? ["Build"] : []))),
        ),
      ),
    askDurable: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
        Effect.andThen(
          reject
            ? Effect.fail(new QuestionV2.RejectedError())
            : Effect.succeed(input.questions.map((_, index) => (index === 0 ? ["Build"] : []))),
        ),
      ),
    askDetached: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
        Effect.andThen(
          reject
            ? Effect.fail(new QuestionV2.RejectedError())
            : Effect.succeed(input.questions.map((_, index) => (index === 0 ? ["Build"] : []))),
        ),
      ),
    open: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
        return {
          id: QuestionV2.ID.ascending(),
          sessionID: input.sessionID,
          mode: "blocking" as const,
          revision: 1,
          actions: [],
          questions: input.questions,
          phase: input.phase,
          tool: input.tool,
        }
      }),
    present: (input) =>
      Effect.sync(() => {
        presented = input
        return {
          id: QuestionV2.ID.ascending(),
          sessionID: input.sessionID,
          mode: input.mode,
          revision: 1,
          actions: [],
          surface: input.surface,
          tool: input.tool,
        }
      }),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    dismissSession: () => Effect.die("unused"),
    dismissFollowups: () => Effect.die("unused"),
    settlementTarget: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    createPersistentTool: () => Effect.die("unused"),
    listPersistentTools: () => Effect.die("unused"),
    updatePersistentToolState: () => Effect.die("unused"),
    setPersistentToolHidden: () => Effect.die("unused"),
    removePersistentTool: () => Effect.die("unused"),
    beginActionInvocation: () => Effect.die("unused"),
    beginActionEffect: () => Effect.die("unused"),
    completeActionInvocation: () => Effect.die("unused"),
    getActionInvocation: () => Effect.die("unused"),
    failActionInvocation: () => Effect.die("unused"),
    actionInvocations: () => Effect.die("unused"),
  }),
)
const tool = SurfaceTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(question))
const it = testEffect(Layer.mergeAll(permission, registry, question, tool))

describe("SurfaceTool", () => {
  it.effect("omits a denied built-in Surface and terminally settles a stale call", () =>
    Effect.gen(function* () {
      captured = undefined
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry, [{ action: "surface", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-denied", name: "surface", input: { mode: "blocking", questions: [] } },
        }),
      ).toEqual({ result: { type: "error", value: "Permission denied: surface" } })
      expect(capturedInput()).toBeUndefined()
      deny = false
    }),
  )

  it.effect("registers one Surface and projects blocking answers", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [{ label: "Build", description: "Build it" }],
        },
        {
          question: "Which environment?",
          header: "Environment",
          options: [{ label: "Dev", description: "Development" }],
        },
      ]

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["surface"])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "surface", input: { mode: "blocking", questions } },
        }),
      ).toEqual({
        result: {
          type: "text",
          value:
            'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
        },
        output: {
          structured: { mode: "blocking", answers: [["Build"], []] },
          content: [
            {
              type: "text",
              text: 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "surface", resources: ["blocking"] }])
      expect(capturedInput()).toEqual({
        sessionID,
        questions,
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("presents an interactive surface without waiting for answers", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      presented = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const input = {
        mode: "interactive" as const,
        version: 1 as const,
        controlID: "send-directly",
        title: "Send directly",
        controls: [{ id: "send", type: "button" as const, label: "Send" }],
        actions: [
          {
            id: "save",
            trigger: { event: "click" as const, source: "send" },
            steps: [{ type: "configWrite" as const, target: { path: "settings.json", format: "json" as const } }],
          },
        ],
      }

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-surface-interactive", name: "surface", input },
        }),
      ).toMatchObject({
        result: { type: "text", value: expect.stringContaining("Opened interactive Surface send-directly") },
        output: { structured: { mode: "interactive", revision: 1, controlID: "send-directly" } },
      })
      expect(presentedInput()).toEqual({
        sessionID,
        mode: "interactive",
        surface: {
          version: 1,
          controlID: "send-directly",
          title: "Send directly",
          controls: input.controls,
          actions: input.actions,
        },
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-surface-interactive" },
      })
      expect(assertions.map((item) => ({ action: item.action, resources: item.resources }))).toEqual([
        { action: "surface", resources: ["interactive"] },
        { action: "edit", resources: ["settings.json"] },
      ])
    }),
  )

  it.effect("presents passive surfaces and rejects passive actions", () =>
    Effect.gen(function* () {
      presented = undefined
      deny = false
      const registry = yield* ToolRegistry.Service
      const input = {
        mode: "passive" as const,
        version: 1 as const,
        controlID: "status",
        markdown: "Ready",
        controls: [],
      }

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-surface-passive", name: "surface", input },
        }),
      ).toMatchObject({ output: { structured: { mode: "passive", controlID: "status" } } })
      expect(presentedInput()?.mode).toBe("passive")

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-surface-passive-action",
            name: "surface",
            input: {
              ...input,
              actions: [{ id: "dismiss", trigger: { event: "click" }, steps: [{ type: "dismiss" }] }],
            },
          },
        }),
      ).toMatchObject({
        result: {
          type: "error",
          value: expect.stringContaining("The surface tool is available, but this payload is invalid"),
        },
      })
    }),
  )

  it.effect("rejects invalid choice payloads before asking", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-string-options",
            name: "surface",
            input: { mode: "blocking", questions: [{ question: "Pick one?", options: ["Alpha", "Beta"] }] },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining(`["questions"][0]["options"][0]`) },
      })
      expect(
        (yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-invalid-phase",
            name: "surface",
            input: { mode: "blocking", phase: "planning", questions: [{ question: "Pick one?" }] },
          },
        })).result,
      ).toMatchObject({
        type: "error",
        value: expect.stringContaining('Omit phase unless it is exactly "implementation_complete_followup"'),
      })
      expect(capturedInput()).toBeUndefined()

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-choices",
            name: "surface",
            input: { mode: "blocking", questions: [{ question: "Pick one?", choices: ["Alpha"] }] },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining(`["questions"][0]["choices"]`) },
      })
      expect(capturedInput()).toBeUndefined()
    }),
  )
  it.effect("explains misplaced blocking actions and legacy visible content", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-top-level-actions",
            name: "surface",
            input: { mode: "blocking", questions: [{ question: "Continue?" }], actions: [] },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining("Blocking Surface inputs cannot declare actions") },
      })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-question-actions",
            name: "surface",
            input: { mode: "blocking", questions: [{ question: "Continue?", actions: [] }] },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining("Blocking questions cannot declare actions") },
      })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-legacy-context",
            name: "surface",
            input: { mode: "blocking", questions: [{ question: "Continue?", context: "Legacy" }] },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining('Put structured visible copy in "body" blocks') },
      })
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("requires exactly one inline or source-backed question input", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-both-inputs",
            name: "surface",
            input: {
              mode: "blocking",
              questions: [{ question: "Inline?" }],
              sourceFile: {
                path: join(Global.Path.state, "question-payloads", `${"0".repeat(64)}.json`),
                sha256: "0".repeat(64),
                count: 1,
              },
            },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: expect.stringContaining('["questions"]') } })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-neither-input",
            name: "surface",
            input: { mode: "blocking" },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: expect.stringContaining("questions") } })
      expect(assertions).toEqual([])
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("checks Surface permission before probing a source file", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = true
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          deny = false
        }),
      )
      const registry = yield* ToolRegistry.Service

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-denied",
            name: "surface",
            input: {
              mode: "blocking",
              sourceFile: {
                path: join(Global.Path.state, "question-payloads", `${"1".repeat(64)}.json`),
                sha256: "1".repeat(64),
                count: 1,
              },
            },
          },
        }),
      ).toEqual({ result: { type: "error", value: "Permission denied: surface" } })
      expect(assertions).toMatchObject([{ sessionID, action: "surface", resources: ["blocking"] }])
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("loads a 32-question hash-pinned payload and writes a stable keyed response", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const keys = Array.from({ length: 32 }, (_, index) => `review:item-${index + 1}`)
      const questions = keys.map((_, index) => ({
        type: "review_section" as const,
        question: `Review item ${index + 1}?`,
        options: [
          {
            label: index === 0 ? "Build" : "Skip",
            description: index === 0 ? "Build it" : "Skip it",
          },
        ],
      }))
      const answers = questions.map((_, index) => (index === 0 ? ["Build"] : []))
      const payload = `${JSON.stringify(
        {
          version: 1,
          kind: "opencode.question-payload",
          binding: "daily-review:2026-07-18:run-positive",
          keys,
          questions,
        },
        null,
        2,
      )}\n`
      const hash = createHash("sha256").update(payload, "utf8").digest("hex")
      const source = join(Global.Path.state, "question-payloads", `${hash}.json`)
      const response = join(Global.Path.state, "question-payloads", `${hash}.response.json`)
      const modelOutput = `User has answered your questions: ${keys
        .map((key, index) => `"${key}"="${index === 0 ? "Build" : "Unanswered"}"`)
        .join(", ")}. Durable response: ${response}. You can now continue with the user's answers in mind.`
      yield* Effect.sync(() => {
        mkdirSync(join(Global.Path.state, "question-payloads"), { recursive: true })
        writeFileSync(source, payload, "utf8")
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(source, { force: true })
          rmSync(response, { force: true })
        }),
      )

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source",
            name: "surface",
            input: {
              mode: "blocking",
              sourceFile: {
                path: source,
                sha256: hash,
                count: 32,
              },
            },
          },
        }),
      ).toMatchObject({
        result: {
          type: "text",
          value: modelOutput,
        },
        output: {
          structured: {
            mode: "blocking",
            answers,
            keys,
            responseFile: response,
          },
          content: [{ type: "text", text: modelOutput }],
        },
      })
      expect(capturedInput()?.questions).toEqual(questions)
      expect(JSON.parse(readFileSync(response, "utf8"))).toEqual({
        version: 1,
        kind: "opencode.question-response",
        sourceSha256: hash,
        keys,
        answers,
      })
    }),
  )

  it.effect("rejects question sources outside the managed root or with a mismatched hash", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const payload = `${JSON.stringify({
        version: 1,
        kind: "opencode.question-payload",
        keys: ["review:first"],
        questions: [{ question: "Review?" }],
      })}\n`
      const managed = join(Global.Path.state, "question-payloads", `${"0".repeat(64)}.json`)
      const outside = join(Global.Path.tmp, `${createHash("sha256").update(payload, "utf8").digest("hex")}.json`)
      yield* Effect.sync(() => {
        mkdirSync(join(Global.Path.state, "question-payloads"), { recursive: true })
        mkdirSync(Global.Path.tmp, { recursive: true })
        writeFileSync(managed, payload, "utf8")
        writeFileSync(outside, payload, "utf8")
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(managed, { force: true })
          rmSync(outside, { force: true })
        }),
      )

      const hash = createHash("sha256").update(payload, "utf8").digest("hex")
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-outside",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: outside, sha256: hash, count: 1 } },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: expect.stringContaining("managed content-addressed file") } })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-hash",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: managed, sha256: "0".repeat(64), count: 1 } },
          },
        }),
      ).toMatchObject({ result: { type: "error", value: expect.stringContaining("SHA-256 does not match") } })
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("keeps finalizeRemaining options valid but insufficient as the only selectable options", () =>
    Effect.sync(() => {
    expect(
      QuestionV2.validateToolInput({
        questions: [
          {
            type: "pick_one",
            question: "Only a footer button?",
            options: [{ id: "done", label: "Enough for today", finalizeRemaining: true }],
          },
        ],
      }),
    ).toContain('["options"]')
    expect(
      QuestionV2.validateToolInput({
        questions: [
          {
            type: "pick_one",
            question: "A footer button next to real choices?",
            options: [
              { id: "yes", label: "Yes" },
              { id: "done", label: "Enough for today", finalizeRemaining: true },
            ],
          },
        ],
      }),
    ).toBeUndefined()
    expect(
      QuestionV2.validateToolInput({
        questions: [{ type: "pick_one", question: "Unknown option field?", options: [{ label: "Yes", bogus: true }] }],
      }),
    ).toContain("Unexpected field")
    }),
  ),

  it.effect("loads a source payload with a finalizeRemaining footer option", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const keys = ["review:finalize-first", "review:finalize-second"]
      const questions = keys.map((key) => ({
        type: "review_section" as const,
        question: `Finalize ${key}?`,
        options: [
          { id: "yes", label: "Ja", description: "Übernehmen" },
          { id: "done", label: "Genug fuer heute", description: "Rest überspringen", finalizeRemaining: true },
        ],
      }))
      const payload = `${JSON.stringify(
        {
          version: 1,
          kind: "opencode.question-payload",
          binding: "daily-review:finalize-remaining",
          keys,
          questions,
        },
        null,
        2,
      )}\n`
      const hash = createHash("sha256").update(payload, "utf8").digest("hex")
      const source = join(Global.Path.state, "question-payloads", `${hash}.json`)
      const response = join(Global.Path.state, "question-payloads", `${hash}.response.json`)
      yield* Effect.sync(() => {
        mkdirSync(join(Global.Path.state, "question-payloads"), { recursive: true })
        writeFileSync(source, payload, "utf8")
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(source, { force: true })
          rmSync(response, { force: true })
        }),
      )

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-finalize",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: source, sha256: hash, count: 2 } },
          },
        }),
      ).toMatchObject({ result: { type: "text" } })
      expect(capturedInput()?.questions).toEqual(questions)
      expect(JSON.parse(readFileSync(response, "utf8")).keys).toEqual(keys)
    }),
  )

  it.effect("rejects unknown source envelopes, invalid bindings, and duplicate stable keys", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const unknownPayload = `${JSON.stringify({
        version: 1,
        kind: "opencode.question-payload",
        keys: ["review:unknown-envelope"],
        questions: [{ type: "ask_text", question: "Review the envelope?" }],
        unexpected: true,
      })}\n`
      const invalidBindingPayload = `${JSON.stringify({
        version: 1,
        kind: "opencode.question-payload",
        binding: "",
        keys: ["review:invalid-binding"],
        questions: [{ type: "ask_text", question: "Review the binding?" }],
      })}\n`
      const duplicatePayload = `${JSON.stringify({
        version: 1,
        kind: "opencode.question-payload",
        keys: ["review:duplicate", "review:duplicate"],
        questions: [
          { type: "ask_text", question: "Review one?" },
          { type: "ask_text", question: "Review two?" },
        ],
      })}\n`
      const unknownHash = createHash("sha256").update(unknownPayload, "utf8").digest("hex")
      const invalidBindingHash = createHash("sha256").update(invalidBindingPayload, "utf8").digest("hex")
      const duplicateHash = createHash("sha256").update(duplicatePayload, "utf8").digest("hex")
      const unknownSource = join(Global.Path.state, "question-payloads", `${unknownHash}.json`)
      const invalidBindingSource = join(Global.Path.state, "question-payloads", `${invalidBindingHash}.json`)
      const duplicateSource = join(Global.Path.state, "question-payloads", `${duplicateHash}.json`)
      yield* Effect.sync(() => {
        mkdirSync(join(Global.Path.state, "question-payloads"), { recursive: true })
        writeFileSync(unknownSource, unknownPayload, "utf8")
        writeFileSync(invalidBindingSource, invalidBindingPayload, "utf8")
        writeFileSync(duplicateSource, duplicatePayload, "utf8")
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(unknownSource, { force: true })
          rmSync(invalidBindingSource, { force: true })
          rmSync(duplicateSource, { force: true })
        }),
      )

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-unknown-envelope",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: unknownSource, sha256: unknownHash, count: 1 } },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining('Unexpected field ["unexpected"]') },
      })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-invalid-binding",
            name: "surface",
            input: {
              mode: "blocking",
              sourceFile: { path: invalidBindingSource, sha256: invalidBindingHash, count: 1 },
            },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining('["binding"]') },
      })
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-duplicate-keys",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: duplicateSource, sha256: duplicateHash, count: 2 } },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining("Question source keys must be unique") },
      })
      expect(capturedInput()).toBeUndefined()
    }),
  )

  it.effect("does not overwrite a different response for the same question source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const questions = [
        { type: "ask_text", question: "Review one?" },
        { type: "ask_text", question: "Review two?" },
      ] as const
      const payload = `${JSON.stringify({
        version: 1,
        kind: "opencode.question-payload",
        keys: ["review:no-overwrite-one", "review:no-overwrite-two"],
        questions,
      })}\n`
      const hash = createHash("sha256").update(payload, "utf8").digest("hex")
      const source = join(Global.Path.state, "question-payloads", `${hash}.json`)
      const response = join(Global.Path.state, "question-payloads", `${hash}.response.json`)
      const existing = `${JSON.stringify({ preserved: true })}\n`
      yield* Effect.sync(() => {
        mkdirSync(join(Global.Path.state, "question-payloads"), { recursive: true })
        writeFileSync(source, payload, "utf8")
        writeFileSync(response, existing, "utf8")
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(source, { force: true })
          rmSync(response, { force: true })
        }),
      )

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-question-source-no-overwrite",
            name: "surface",
            input: { mode: "blocking", sourceFile: { path: source, sha256: hash, count: 2 } },
          },
        }),
      ).toMatchObject({
        result: { type: "error", value: expect.stringContaining("A different response already exists") },
      })
      expect(readFileSync(response, "utf8")).toBe(existing)
      expect(capturedInput()?.questions).toEqual(questions)
    }),
  )


  it.effect("does not invent tool ownership metadata without a durable registry source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registryService = yield* ToolRegistry.Service

      yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "surface", input: { mode: "blocking", questions: [] } },
      })
      expect(capturedInput()).toEqual({
        sessionID,
        questions: [],
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("keeps dismissed questions out of model-facing output", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = true
      deny = false
      const registryService = yield* ToolRegistry.Service
      const fiber = yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "surface", input: { mode: "blocking", questions: [] } },
      }).pipe(Effect.forkScoped)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
