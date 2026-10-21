import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { composer } from "@opencode-ai/core/mail/composer"
import { managerComposer } from "@opencode-ai/core/mail/manager-composer"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import {
  closeQuestion,
  formActionForInput,
  formActionProblem,
  formActionProblemRetry,
  questionPending,
} from "../../src/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.make("project_question_host"),
        worktree: AbsolutePath.make("/question-host"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_question_host_attachment"),
        project_id: ProjectV2.ID.make("project_question_host"),
        slug: "question-host",
        directory: "/question-host",
        title: "Question host",
        version: "1",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, questions, fixture))

describe("QuestionV2 host routes", () => {
  it.effect("uses V2 pending requests for attachment validation and close", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.open({
        sessionID: SessionV2.ID.make("ses_question_host_attachment"),
        questions: [{ question: "Attach evidence?", type: "file_picker" }],
      })

      expect(yield* questionPending(service, request.id)).toBe(true)
      yield* closeQuestion(service, request.id)
      expect(yield* questionPending(service, request.id)).toBe(false)
      yield* closeQuestion(service, request.id)
    }),
  )

  it.effect("resolves and validates host form actions from V2 requests", () =>
    Effect.sync(() => {
      const requestID = QuestionV2.ID.make("que_question_host_form")
      const request: QuestionV2.Request = {
        id: requestID,
        sessionID: SessionV2.ID.make("ses_question_host_form"),
        mode: "blocking",
        revision: 1,
        actions: [],
        detached: true,
        questions: [
          {
            question: "Apply the action?",
            type: "form",
            form: {
              version: 1,
              id: "host-form.v1",
              fields: [],
              actions: [
                {
                  id: "dismiss",
                  trigger: { event: "click" },
                  steps: [{ type: "dismiss" }],
                },
              ],
            },
          },
        ],
      }
      const input = {
        requestID,
        revision: 1,
        invocationID: "inv_host_form",
        target: { kind: "request" as const, id: requestID, revision: 1 },
        directory: "C:/repo",
        formID: "host-form.v1",
        values: {},
        action: { id: "dismiss", source: undefined },
      }
      const action = formActionForInput([request], input)

      expect(action?.steps).toEqual([{ type: "dismiss" }])
      expect(formActionProblem([request], input, action)).toBeUndefined()
      expect(formActionProblem([], input, action)).toBe("Form action Surface is no longer available")
      expect(formActionProblemRetry("Form action Surface is no longer available")).toBe("reconcile")
      expect(formActionProblemRetry("Form action is not allowed by this form")).toBe("safe")

      const mail = composer({ provider: "gmx", account: "gmx-crisci" }).controls[0]!.form!
      const mailRequest: QuestionV2.Request = {
        ...request,
        questions: [{ question: "Send mail?", type: "form", form: mail }],
      }
      const mailInput = {
        ...input,
        formID: "email-composer.v1",
        values: { to: ["recipient@example.com"], subject: "Subject", body: "Message", action: "send" },
        action: { id: "send", source: undefined },
      }
      expect(formActionProblem([mailRequest], mailInput, formActionForInput([mailRequest], mailInput))).toBeUndefined()
      expect(formActionProblem([mailRequest], { ...mailInput, values: { ...mailInput.values, action: "cancel" } }, formActionForInput([mailRequest], mailInput))).toBe("Form action does not match the selected value")

      const manager = managerComposer({
        id: "12345678-1234-1234-1234-123456789abc", sessionID: request.sessionID, directory: "C:/repo",
        accountID: "gmail-default", address: "user@example.com", provider: "gmail", mailbox: "INBOX",
        createdAt: Date.now(), revision: 1, state: "ready", rows: [], destinations: [],
      }).controls[0]!.form!
      const managerRequest: QuestionV2.Request = { ...request, questions: [{ question: "Manage mail?", type: "form", form: manager }] }
      const managerInput = { ...input, formID: "email-manager.v1", values: { action: "mark_read" },
        action: { id: "apply", source: "apply" } }
      expect(formActionProblem([managerRequest], managerInput, formActionForInput([managerRequest], managerInput))).toBeUndefined()
    }),
  )
})
