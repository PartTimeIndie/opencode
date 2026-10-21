import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ScheduledJob, resultTool } from "../../../../../opencode-scheduler/src/result"
import { SessionExecutionView } from "@opencode-ai/core/session/execution-view"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import {
  applySchedulerJobState,
  mergeSchedulerJobAugmentation,
  schedulerJobOutcome,
} from "../../../../../opencode-scheduler/src/service"

const sessionID = SessionSchema.ID.make("ses_scheduler_outcome")
const messageID = SessionMessage.ID.make("msg_scheduler_outcome")
const runId = "7b83e4af22bf493f83085fe7358b29c7"

const scheduledJobResult = (status: "success" | "failed", error?: string, id = "call_scheduled_job_result") => ({
  type: "tool",
  id,
  name: ScheduledJob.resultToolName,
  state: {
    status: "completed",
    input: { status, ...(error === undefined ? {} : { error }) },
    structured: {
      contract: ScheduledJob.resultContractMarker,
      status,
      ...(error === undefined ? {} : { error }),
    },
    content: [],
    outputPaths: [],
  },
  time: { created: 2_500, ran: 2_510, completed: 2_520 },
})

test("scheduler augmentation preserves the plugin's projected terminal status over stale raw state", () => {
  expect(
    mergeSchedulerJobAugmentation(
      {
        scopeId: "scope",
        slug: "job",
        lastRunStatus: "failed",
        lastRunError: "interrupted: scheduler runner process is no longer active",
      },
      {
        lastRunStatus: "running",
        lastRunRunnerPID: 123,
      },
    ),
  ).toMatchObject({
    lastRunStatus: "failed",
    lastRunError: "interrupted: scheduler runner process is no longer active",
    lastRunRunnerPID: 123,
  })
})

test("scheduler augmentation fills status when an older plugin omits it", () => {
  expect(mergeSchedulerJobAugmentation({ scopeId: "scope", slug: "job" }, { lastRunStatus: "success" })).toMatchObject({
    lastRunStatus: "success",
  })
})

const runOutcome = (input: {
  promotedSeq: number | null
  activities: Array<{
    id: string
    status: string
    openedSeq: number
    closedSeq: number | null
    lastError?: string
    turnCompletionState?: "running" | "ready" | "done"
    turnCompletionResult?: "done" | "incomplete" | "skipped"
  }>
  storedActivityID?: string
  jobRunId?: string
  promptText?: string
  resultContract?: string
  stepFailure?: { seq: number; message: string }
  assistants?: Array<{ seq: number; finish?: string; error?: string; agent?: string; content?: ReadonlyArray<unknown> }>
  laterInputs?: Array<{ id: string; admittedSeq: number; promotedSeq: number }>
  question?: { state: "queued" | "active" | "rejected" | "orphaned"; activityID: string; detached?: boolean }
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: AbsolutePath.make("C:/OpenCode/SchedulerOutcome"),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "scheduler-outcome",
          directory: AbsolutePath.make("C:/OpenCode/SchedulerOutcome"),
          title: "Scheduler outcome",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionInputTable)
        .values({
          id: messageID,
          session_id: sessionID,
          prompt: { text: input.promptText ?? "Run the scheduled job." },
          delivery: "steer",
          admitted_seq: 11,
          promoted_seq: input.promotedSeq,
          time_created: 1_000,
        })
        .run()
        .pipe(Effect.orDie)
      if (input.laterInputs?.length) {
        yield* database.db
          .insert(SessionInputTable)
          .values(
            input.laterInputs.map((item) => ({
              id: SessionMessage.ID.make(item.id),
              session_id: sessionID,
              prompt: { text: "Later prompt." },
              delivery: "steer" as const,
              admitted_seq: item.admittedSeq,
              promoted_seq: item.promotedSeq,
              time_created: 1_100 + item.admittedSeq,
            })),
          )
          .run()
          .pipe(Effect.orDie)
      }
      if (input.activities.length > 0) {
        yield* database.db
          .insert(SessionActivityTable)
          .values(
            input.activities.map((activity, index) => ({
              id: activity.id,
              session_id: sessionID,
              status: activity.status,
              kind: "prompt",
              owner_id: "owner_scheduler_outcome",
              opened_seq: activity.openedSeq,
              closed_seq: activity.closedSeq,
              last_error: activity.lastError,
              turn_completion_state: activity.turnCompletionState,
              turn_completion_result: activity.turnCompletionResult,
              time_created: 2_000 + index,
              time_updated: 3_000 + index,
            })),
          )
          .run()
          .pipe(Effect.orDie)
      }
      if (input.assistants?.length) {
        yield* database.db
          .insert(SessionMessageTable)
          .values(
            input.assistants.map((assistant, index) => ({
              id: SessionMessage.ID.make(`msg_scheduler_assistant_${index}`),
              session_id: sessionID,
              type: "assistant" as const,
              seq: assistant.seq,
              time_created: 2_500 + index,
              time_updated: 2_600 + index,
              data: {
                agent: assistant.agent ?? "build",
                model: { providerID: "openai", id: "gpt-5.6", variant: "max" },
                content: assistant.content ?? [],
                time: { created: 2_500 + index, completed: 2_600 + index },
                finish: assistant.error ? "error" : assistant.finish,
                ...(assistant.error ? { error: { type: "unknown" as const, message: assistant.error } } : {}),
              },
            })),
          )
          .run()
          .pipe(Effect.orDie)
      }
      if (input.question) {
        yield* database.db
          .insert(QuestionTable)
          .values({
            id: QuestionV2.ID.make("que_scheduler_outcome"),
            session_id: sessionID,
            seq: 1,
            state: input.question.state,
            request: {
              id: QuestionV2.ID.make("que_scheduler_outcome"),
              sessionID,
              mode: "blocking",
              revision: 1,
              actions: [],
              questions: [
                { header: "Review", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] },
              ],
            },
            detached: input.question.detached === true,
            activity_id: input.question.activityID,
            time_created: 2_700,
            time_updated: 2_800,
            time_settled: input.question.state === "queued" || input.question.state === "active" ? null : 2_800,
          })
          .run()
          .pipe(Effect.orDie)
      }
      if (input.stepFailure) {
        yield* database.db
          .insert(EventSequenceTable)
          .values({ aggregate_id: sessionID, seq: input.stepFailure.seq })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(EventTable)
          .values({
            id: EventV2.ID.create(),
            aggregate_id: sessionID,
            seq: input.stepFailure.seq,
            type: EventV2.versionedType(SessionEvent.Step.Failed.type, 2),
            data: {
              timestamp: 2_500,
              sessionID,
              assistantMessageID: "msg_scheduler_assistant",
              error: { type: "unknown", message: input.stepFailure.message },
            },
          })
          .run()
          .pipe(Effect.orDie)
      }
      return yield* Effect.promise(() => schedulerJobOutcome(
        {execution:{read: (request) => Effect.runPromise(SessionExecutionView.read(database, request))}},
        {
          lastRunStatus: "running",
          lastRunRunId: input.jobRunId ?? runId,
          lastRunSessionID: sessionID,
          lastRunMessageID: messageID,
          ...(input.storedActivityID ? { lastRunActivityID: input.storedActivityID } : {}),
          ...(input.resultContract ? { lastRunResultContract: input.resultContract } : {}),
          run: { runTarget: "app", appSessionID: sessionID },
        },
        runId,
      ))
    }).pipe(Effect.provide(Database.layerFromPath(":memory:").pipe(Layer.fresh))),
  )

describe("scheduled app job outcome", () => {
  test("accepts the public plugin tool result envelope alongside legacy durable results", async () => {
    const tool = scheduledJobResult("success")
    const output = await resultTool.execute({status:"success"}, {
      sessionID, messageID, callID: tool.id, agent: "build", directory: "C:/OpenCode/SchedulerOutcome", worktree: "C:/OpenCode/SchedulerOutcome",
      abort: new AbortController().signal, metadata: () => {}, ask: async () => {}, customPart: async () => {},
      sessionContext: { planDocument: async () => undefined, actionInvocations: async () => [] },
    })
    expect(await runOutcome({resultContract:ScheduledJob.resultContractMarker,promotedSeq:11,
      activities:[{id:"activity_public_result",status:"completed",openedSeq:10,closedSeq:16}],
      assistants:[{seq:12,finish:"tool-calls",content:[{...tool,state:{...tool.state,structured:output}}]},{seq:14,finish:"stop"}],
    })).toEqual({status:"success",runId,activityID:"activity_public_result"})
  })
  test("uses an explicit failed result even when the terminal assistant response stops normally", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_explicit_failure", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [scheduledJobResult("failed", "Implementation timed out before verification.")],
          },
          { seq: 14, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_explicit_failure",
      error: "Implementation timed out before verification.",
    })
  })

  test("accepts one explicit success result followed by a terminal assistant response", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_explicit_success", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [
          { seq: 12, finish: "tool-calls", content: [scheduledJobResult("success")] },
          { seq: 14, finish: "stop" },
        ],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_explicit_success" })
  })

  test("rejects an explicit success result that contains an error", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_inconsistent_success", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [scheduledJobResult("success", "This must not be accepted.")],
          },
          { seq: 14, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_inconsistent_success",
      error: "Scheduled app job reported an invalid explicit result.",
    })
  })

  test("rejects success reported alongside another tool call", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_success_with_tool", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [
              scheduledJobResult("success"),
              {
                type: "tool",
                id: "call_late_verification",
                name: "bash",
                state: {
                  status: "error",
                  input: { command: "verify" },
                  error: "Verification failed.",
                  content: [],
                },
              },
            ],
          },
          { seq: 14, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_success_with_tool",
      error: "Scheduled app job success was not the only tool call immediately before the terminal response.",
    })
  })

  test("rejects success followed by another tool turn before the terminal response", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_early_success", status: "completed", openedSeq: 10, closedSeq: 18 }],
        assistants: [
          { seq: 12, finish: "tool-calls", content: [scheduledJobResult("success")] },
          {
            seq: 14,
            finish: "tool-calls",
            content: [
              {
                type: "tool",
                id: "call_after_success",
                name: "bash",
                state: {
                  status: "error",
                  input: { command: "verify" },
                  error: "Verification failed.",
                  content: [],
                },
              },
            ],
          },
          { seq: 16, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_early_success",
      error: "Scheduled app job success was not the only tool call immediately before the terminal response.",
    })
  })

  test("accepts success followed by a confirmed build handoff owning the session terminal response", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [
          { id: "activity_plan_handoff", status: "completed", openedSeq: 10, closedSeq: 16 },
          { id: "activity_build_handoff", status: "completed", openedSeq: 17, closedSeq: 20 },
        ],
        laterInputs: [{ id: "msg_build_handoff", admittedSeq: 903, promotedSeq: 17 }],
        assistants: [
          { seq: 12, agent: "plan", finish: "tool-calls", content: [scheduledJobResult("success")] },
          {
            seq: 16,
            agent: "build",
            finish: "tool-calls",
            content: [
              {
                type: "tool",
                id: "call_build_implementation",
                name: "daily_review_implementation",
                state: { status: "completed", input: { operation: "start" }, content: [] },
              },
            ],
          },
          { seq: 18, agent: "build", finish: "stop" },
        ],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_build_handoff" })
  })

  test("rejects success when the reporting agent keeps working after it during a handoff", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [
          { id: "activity_plan_handoff_followup", status: "completed", openedSeq: 10, closedSeq: 16 },
          { id: "activity_build_handoff_followup", status: "completed", openedSeq: 17, closedSeq: 21 },
        ],
        laterInputs: [{ id: "msg_build_handoff_followup", admittedSeq: 903, promotedSeq: 19 }],
        assistants: [
          { seq: 12, agent: "plan", finish: "tool-calls", content: [scheduledJobResult("success")] },
          {
            seq: 14,
            agent: "plan",
            finish: "tool-calls",
            content: [
              {
                type: "tool",
                id: "call_late_plan_note",
                name: "plan_document",
                state: { status: "completed", input: {}, content: [] },
              },
            ],
          },
          { seq: 20, agent: "build", finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_build_handoff_followup",
      error: "Scheduled app job success was not the only tool call immediately before the terminal response.",
    })
  })

  test("fails a contracted run that reaches a terminal response without an explicit result", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [
          {
            id: "activity_missing_result",
            status: "completed",
            openedSeq: 10,
            closedSeq: 16,
            turnCompletionState: "done",
            turnCompletionResult: "done",
          },
        ],
        assistants: [{ seq: 14, finish: "stop" }],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_missing_result",
      error: "Scheduled app job completed without the required explicit result.",
    })
  })

  test("keeps a contracted run active while turn completion is preparing an automatic continuation", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [
          {
            id: "activity_missing_result_resume",
            status: "completed",
            openedSeq: 10,
            closedSeq: 16,
            turnCompletionState: "ready",
            turnCompletionResult: "incomplete",
          },
        ],
        assistants: [{ seq: 14, finish: "stop" }],
      }),
    ).toEqual({
      status: "running",
      phase: "continuation_pending",
      runId,
      activityID: "activity_missing_result_resume",
    })
  })

  test("follows a provider-only continuation to its explicit scheduled result", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        storedActivityID: "activity_missing_result_root",
        activities: [
          {
            id: "activity_missing_result_root",
            status: "completed",
            openedSeq: 10,
            closedSeq: 16,
            turnCompletionState: "ready",
            turnCompletionResult: "incomplete",
          },
          {
            id: "activity_missing_result_successor",
            status: "completed",
            openedSeq: 16,
            closedSeq: 24,
            turnCompletionState: "done",
            turnCompletionResult: "done",
          },
        ],
        assistants: [
          { seq: 14, finish: "stop" },
          { seq: 18, finish: "tool-calls", content: [scheduledJobResult("success")] },
          { seq: 20, finish: "stop" },
        ],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_missing_result_successor" })
  })

  test("rejects duplicate explicit results instead of selecting either result", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_duplicate_result", status: "completed", openedSeq: 10, closedSeq: 18 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [
              scheduledJobResult("success", undefined, "call_scheduled_job_result_first"),
              scheduledJobResult("failed", "Late failure.", "call_scheduled_job_result_second"),
            ],
          },
          { seq: 16, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_duplicate_result",
      error: "Scheduled app job reported more than one explicit result.",
    })
  })

  test("keeps legacy prompts backward-compatible and does not parse fail-closed prose", async () => {
    expect(
      await runOutcome({
        promptText: `Discuss ${ScheduledJob.resultContractMarker}, but this legacy run has no persisted result contract.`,
        promotedSeq: 11,
        activities: [{ id: "activity_legacy_prose", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [{ seq: 14, finish: "stop" }],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_legacy_prose" })
  })

  test("rejects a malformed scheduled result tool part", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_invalid_result", status: "completed", openedSeq: 10, closedSeq: 18 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [
              {
                ...scheduledJobResult("success", undefined, "call_scheduled_job_result_running"),
                state: {
                  status: "running",
                  input: { status: "success" },
                  structured: { status: "success" },
                  content: [],
                },
              },
            ],
          },
          { seq: 16, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_invalid_result",
      error: "Scheduled app job reported an invalid explicit result.",
    })
  })

  test("counts malformed calls when rejecting duplicate scheduled results", async () => {
    expect(
      await runOutcome({
        promptText: `${ScheduledJob.resultContractMarker}\nRun the scheduled job.`,
        resultContract: ScheduledJob.resultContractMarker,
        promotedSeq: 11,
        activities: [{ id: "activity_duplicate_invalid_result", status: "completed", openedSeq: 10, closedSeq: 18 }],
        assistants: [
          {
            seq: 12,
            finish: "tool-calls",
            content: [
              scheduledJobResult("success", undefined, "call_scheduled_job_result_valid"),
              scheduledJobResult("failed", undefined, "call_scheduled_job_result_invalid"),
            ],
          },
          { seq: 16, finish: "stop" },
        ],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_duplicate_invalid_result",
      error: "Scheduled app job reported more than one explicit result.",
    })
  })

  test("maps a completed activity with a durable provider 429 step failure to failed", async () => {
    expect(
      await runOutcome({
        promotedSeq: 12,
        activities: [
          {
            id: "activity_429",
            status: "completed",
            openedSeq: 11,
            closedSeq: 15,
          },
        ],
        assistants: [{ seq: 13, error: "HTTP 429 usage_limit_reached" }],
        stepFailure: { seq: 14, message: "HTTP 429 usage_limit_reached" },
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_429",
      error: "HTTP 429 usage_limit_reached",
    })
  })

  test("ignores an older failed activity in a reused session", async () => {
    expect(
      await runOutcome({
        promotedSeq: 20,
        activities: [
          { id: "activity_old", status: "failed", openedSeq: 1, closedSeq: 9, lastError: "historical failure" },
          { id: "activity_current", status: "completed", openedSeq: 18, closedSeq: 24 },
        ],
        assistants: [{ seq: 21, finish: "stop" }],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_current" })
  })

  test("keeps an admitted but unpromoted input pending", async () => {
    expect(
      await runOutcome({
        promotedSeq: null,
        activities: [
          { id: "activity_unrelated", status: "failed", openedSeq: 1, closedSeq: 99, lastError: "unrelated" },
        ],
      }),
    ).toEqual({ status: "pending", phase: "admitted", runId })
  })

  test("keeps a promoted input with an open question activity running", async () => {
    expect(
      await runOutcome({
        promotedSeq: 30,
        activities: [{ id: "activity_question", status: "running", openedSeq: 28, closedSeq: null }],
      }),
    ).toEqual({ status: "running", runId, activityID: "activity_question" })
  })

  test("does not accept the activity opening boundary or a legacy terminal null close", async () => {
    expect(
      await runOutcome({
        promotedSeq: 40,
        activities: [
          { id: "activity_boundary", status: "completed", openedSeq: 40, closedSeq: 45 },
          { id: "activity_legacy_terminal", status: "completed", openedSeq: 30, closedSeq: null },
        ],
      }),
    ).toEqual({ status: "pending", phase: "promoted", runId })
  })

  test("trusts a persisted same-session activity after recovery shifts its sequence window", async () => {
    expect(
      await runOutcome({
        promotedSeq: 5,
        storedActivityID: "037eefe79001PZNs7k25G8iehW",
        activities: [
          {
            id: "037eefe79001PZNs7k25G8iehW",
            status: "completed",
            openedSeq: 97,
            closedSeq: 98,
          },
          { id: "activity_prompt_window", status: "completed", openedSeq: 4, closedSeq: 90 },
        ],
        assistants: [{ seq: 89 }],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "037eefe79001PZNs7k25G8iehW",
      error: "Scheduled app job completed without a terminal assistant result.",
    })
  })

  test("assigns the opening boundary to the predecessor activity", async () => {
    expect(
      await runOutcome({
        promotedSeq: 70,
        activities: [
          { id: "activity_predecessor", status: "completed", openedSeq: 60, closedSeq: 70 },
          { id: "activity_successor", status: "completed", openedSeq: 70, closedSeq: 80 },
        ],
        assistants: [{ seq: 69, finish: "stop" }],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_predecessor",
      error: "Scheduled app job completed without an assistant response.",
    })
  })

  test("does not attribute a later prompt failure in the same activity to this run", async () => {
    expect(
      await runOutcome({
        promotedSeq: 70,
        activities: [
          {
            id: "activity_shared",
            status: "failed",
            openedSeq: 60,
            closedSeq: 90,
            lastError: "Later prompt failed",
          },
        ],
        assistants: [
          { seq: 72, finish: "stop" },
          { seq: 80, error: "Later prompt failed" },
        ],
        laterInputs: [{ id: "msg_later_prompt", admittedSeq: 74, promotedSeq: 75 }],
      }),
    ).toEqual({ status: "success", runId, activityID: "activity_shared" })
  })

  test("waits through tool calls and reports a continuation provider failure", async () => {
    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_continuation", status: "completed", openedSeq: 10, closedSeq: 16 }],
        assistants: [
          { seq: 12, finish: "tool-calls" },
          { seq: 14, error: "Provider failed after question reply" },
        ],
        laterInputs: [{ id: "msg_question_reply", admittedSeq: 13, promotedSeq: 13 }],
        stepFailure: { seq: 15, message: "Provider failed after question reply" },
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_continuation",
      error: "Provider failed after question reply",
    })
  })

  test("does not mark an incomplete or tool-calls-only terminal activity successful", async () => {
    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_incomplete", status: "completed", openedSeq: 10, closedSeq: 15 }],
        assistants: [{ seq: 12 }],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_incomplete",
      error: "Scheduled app job completed without a terminal assistant result.",
    })

    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_tool_calls_only", status: "completed", openedSeq: 10, closedSeq: 15 }],
        assistants: [{ seq: 12, finish: "tool-calls" }],
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_tool_calls_only",
      error: "Scheduled app job completed without a terminal assistant result.",
    })
  })

  test("separates an explicit question dismissal from generic interrupted runs", async () => {
    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_dismissed", status: "interrupted", openedSeq: 10, closedSeq: 15 }],
        assistants: [{ seq: 12, finish: "tool-calls" }],
        question: { state: "rejected", activityID: "activity_dismissed" },
      }),
    ).toEqual({ status: "dismissed", runId, activityID: "activity_dismissed" })

    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_app_closed", status: "interrupted", openedSeq: 10, closedSeq: 15 }],
        assistants: [{ seq: 12, finish: "tool-calls" }],
        question: { state: "orphaned", activityID: "activity_app_closed" },
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_app_closed",
      error: "Scheduled app session was interrupted.",
    })

    expect(
      await runOutcome({
        promotedSeq: 11,
        activities: [{ id: "activity_detached", status: "interrupted", openedSeq: 10, closedSeq: 15 }],
        assistants: [{ seq: 12, finish: "tool-calls" }],
        question: { state: "rejected", activityID: "activity_detached", detached: true },
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_detached",
      error: "Scheduled app session was interrupted.",
    })
  })

  test("keeps the exact scheduled run pending while its durable blocking question awaits input", async () => {
    expect(
      await runOutcome({
        promotedSeq: 11,
        resultContract: ScheduledJob.resultContractMarker,
        activities: [{ id: "activity_awaiting_input", status: "running", openedSeq: 10, closedSeq: null }],
        assistants: [{ seq: 12, finish: "tool-calls" }],
        question: { state: "active", activityID: "activity_awaiting_input" },
      }),
    ).toEqual({
      status: "awaiting_input",
      runId,
      activityID: "activity_awaiting_input",
      questionID: QuestionV2.ID.make("que_scheduler_outcome"),
    })
  })

  test("rejects a superseded run id before reading activity state", async () => {
    expect(await runOutcome({ promotedSeq: 60, activities: [], jobRunId: "newer-run" })).toEqual({
      status: "superseded",
      runId,
      currentRunId: "newer-run",
    })
  })

  test("keeps an owned activity running but terminally fails an orphaned activity", async () => {
    expect(
      await runOutcome({
        promotedSeq: 60,
        activities: [{ id: "activity_active", status: "running", openedSeq: 50, closedSeq: null }],
      }),
    ).toEqual({ status: "running", runId, activityID: "activity_active" })

    expect(
      await runOutcome({
        promotedSeq: 60,
        activities: [{ id: "activity_orphaned", status: "orphaned", openedSeq: 50, closedSeq: null }],
        storedActivityID: "activity_orphaned",
      }),
    ).toEqual({
      status: "failed",
      runId,
      activityID: "activity_orphaned",
      error: "Scheduled app session activity was orphaned before producing a terminal result.",
    })
  })
})

describe("scheduled app job state transitions", () => {
  test("first target claim wins and exact retries remain idempotent", () => {
    const before = Date.now()
    const unsupportedJob: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      run: { runTarget: "app", appSessionStrategy: "new" },
    }
    expect(
      applySchedulerJobState(unsupportedJob, {
        scopeId: "scheduler-outcome",
        slug: "target-claim",
        runId,
        status: "running",
        resultContract: "opencode.scheduled-job-result/future",
      }),
    ).toMatchObject({
      ignored: false,
      unsupported: true,
      output: expect.stringContaining("Unsupported scheduled job result contract"),
    })
    expect(unsupportedJob).not.toHaveProperty("lastRunResultContract")

    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      lastRunOwner: "runner",
      lastRunRunnerPID: 123,
      lastRunRunnerStartedAt: "2026-07-12T08:00:00.000Z",
      lastRunLeaseUntil: "2026-07-12T08:05:00.000Z",
      run: { runTarget: "app", appSessionStrategy: "new" },
    }
    const input = {
      scopeId: "scheduler-outcome",
      slug: "target-claim",
      runId,
      status: "running",
      appSessionID: "ses_first_target",
      messageID: "msg_first_target",
      resultContract: ScheduledJob.resultContractMarker,
    }

    expect(applySchedulerJobState(job, input).ignored).toBe(false)
    expect(applySchedulerJobState(job, input).ignored).toBe(false)
    expect(
      applySchedulerJobState(job, {
        ...input,
        appSessionID: "ses_second_target",
        messageID: "msg_second_target",
      }),
    ).toMatchObject({ ignored: true, output: expect.stringContaining("conflicting session claim") })
    expect(
      applySchedulerJobState(job, {
        ...input,
        resultContract: "opencode.scheduled-job-result/future",
      }),
    ).toMatchObject({
      ignored: false,
      unsupported: true,
      output: expect.stringContaining("Unsupported scheduled job result contract"),
    })
    expect(job).toMatchObject({
      lastRunSessionID: "ses_first_target",
      lastRunMessageID: "msg_first_target",
      lastRunResultContract: ScheduledJob.resultContractMarker,
      lastRunOwner: "app",
      run: { appSessionID: "ses_first_target" },
    })
    expect(job).not.toHaveProperty("lastRunRunnerPID")
    expect(job).not.toHaveProperty("lastRunRunnerStartedAt")
    expect(Date.parse(String(job.lastRunLeaseUntil))).toBeGreaterThanOrEqual(before + 300_000)
  })

  test("a healthy app heartbeat renews its finite lease without changing the target claim", () => {
    const before = Date.now()
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      lastRunOwner: "app",
      lastRunLeaseUntil: "2000-01-01T00:00:00.000Z",
      lastRunSessionID: "ses_heartbeat",
      lastRunMessageID: "msg_heartbeat",
      lastRunFinishedAt: "2000-01-01T00:00:00.000Z",
      run: { runTarget: "app", appSessionStrategy: "new", appSessionID: "ses_heartbeat" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "heartbeat",
        runId,
        status: "running",
        appSessionID: "ses_heartbeat",
        messageID: "msg_heartbeat",
      }).ignored,
    ).toBe(false)
    expect(job).toMatchObject({
      lastRunOwner: "app",
      lastRunSessionID: "ses_heartbeat",
      lastRunMessageID: "msg_heartbeat",
    })
    expect(Date.parse(String(job.lastRunLeaseUntil))).toBeGreaterThanOrEqual(before + 300_000)
    expect(job).not.toHaveProperty("lastRunFinishedAt")
  })

  test("terminal state is first-writer-wins and cannot regress", () => {
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      lastRunOwner: "app",
      lastRunLeaseUntil: "2026-07-12T08:05:00.000Z",
      run: { runTarget: "app", appSessionStrategy: "new" },
    }
    const input = { scopeId: "scheduler-outcome", slug: "terminal", runId }

    expect(applySchedulerJobState(job, { ...input, status: "success" }).ignored).toBe(false)
    expect(job).toMatchObject({ lastRunStatus: "success", lastRunExitCode: 0 })
    expect(job.lastRunFinishedAt).toBe(job.updatedAt)
    expect(applySchedulerJobState(job, { ...input, status: "running", activityID: "late" }).ignored).toBe(true)
    expect(applySchedulerJobState(job, { ...input, status: "failed", error: "late failure" }).ignored).toBe(true)
    expect(job).toMatchObject({ lastRunStatus: "success", lastRunExitCode: 0 })
    expect(job).not.toHaveProperty("lastRunError")
    expect(job).not.toHaveProperty("lastRunActivityID")
    expect(job).not.toHaveProperty("lastRunOwner")
    expect(job).not.toHaveProperty("lastRunLeaseUntil")
  })

  test("persists explicit dismissal as a successful terminal resolution", () => {
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      lastRunOwner: "app",
      lastRunLeaseUntil: "2026-07-12T08:05:00.000Z",
      run: { runTarget: "app", appSessionStrategy: "job" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "dismissed",
        runId,
        status: "success",
        resolution: "dismissed",
      }).ignored,
    ).toBe(false)
    expect(job).toMatchObject({ lastRunStatus: "success", lastRunExitCode: 0, lastRunResolution: "dismissed" })
    expect(job).not.toHaveProperty("lastRunOwner")
    expect(job).not.toHaveProperty("lastRunLeaseUntil")
  })

  test("an orphaned outcome releases the app lease so a new run can claim", () => {
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      lastRunOwner: "app",
      lastRunLeaseUntil: "2026-07-12T08:05:00.000Z",
      lastRunActivityID: "activity_orphaned",
      run: { runTarget: "app", appSessionStrategy: "current", appSessionID: "ses_current" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "orphaned-retry",
        runId,
        status: "failed",
        error: "Scheduled app session activity was orphaned before producing a terminal result.",
      }).ignored,
    ).toBe(false)
    expect(job).toMatchObject({ lastRunStatus: "failed", lastRunExitCode: -1 })
    expect(job).not.toHaveProperty("lastRunOwner")
    expect(job).not.toHaveProperty("lastRunLeaseUntil")
  })

  test("a job-session run may replace its previous reusable session before claiming this run", () => {
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      run: {
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: "ses_deleted_reusable",
        appResetHistory: true,
      },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "replace-reusable",
        runId,
        status: "running",
        appSessionID: "ses_replacement",
        messageID: "msg_replacement",
      }).ignored,
    ).toBe(false)
    expect(job).toMatchObject({
      lastRunSessionID: "ses_replacement",
      lastRunMessageID: "msg_replacement",
      run: { appSessionID: "ses_replacement" },
    })
  })

  test("a current-session run cannot replace its configured target", () => {
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "running",
      run: { runTarget: "app", appSessionStrategy: "current", appSessionID: "ses_configured_current" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "fixed-current-target",
        runId,
        status: "running",
        appSessionID: "ses_conflicting_current",
        messageID: "msg_conflicting_current",
      }),
    ).toMatchObject({ ignored: true, output: expect.stringContaining("conflicting session claim") })
    expect(job).toMatchObject({ run: { appSessionID: "ses_configured_current" } })
    expect(job).not.toHaveProperty("lastRunSessionID")
  })

  test("an idempotent run-once success resumes tombstoning after a crash window", () => {
    const finishedAt = "2026-07-12T08:00:00.000Z"
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "success",
      lastRunExitCode: 0,
      lastRunFinishedAt: finishedAt,
      updatedAt: "2026-07-12T08:01:00.000Z",
      runOnce: true,
      run: { runTarget: "app", appSessionStrategy: "new" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "resume-run-once-cleanup",
        runId,
        status: "success",
      }).ignored,
    ).toBe(false)
    expect(job).toMatchObject({ lastRunStatus: "success", lastRunExitCode: 0, runOnce: true })
    expect(job.lastRunFinishedAt).toBe(finishedAt)
    expect(job.updatedAt).not.toBe(finishedAt)
  })

  test("a legacy run-once terminal retry backfills its original completion timestamp", () => {
    const completedAt = "2026-07-12T08:00:00.000Z"
    const job: Record<string, unknown> = {
      lastRunRunId: runId,
      lastRunStatus: "success",
      lastRunExitCode: 0,
      updatedAt: completedAt,
      runOnce: true,
      run: { runTarget: "app", appSessionStrategy: "new" },
    }

    expect(
      applySchedulerJobState(job, {
        scopeId: "scheduler-outcome",
        slug: "resume-legacy-run-once-cleanup",
        runId,
        status: "success",
      }).ignored,
    ).toBe(false)
    expect(job.lastRunFinishedAt).toBe(completedAt)
    expect(job.updatedAt).not.toBe(completedAt)
  })
})
