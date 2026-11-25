import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInput } from "@opencode-ai/core/session/input"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath, PositiveInt, RelativePath, withStatics } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"

const QueryBooleanString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
)
const QueryBoolean = Schema.Union([Schema.Boolean, QueryBooleanString])

const SessionsQueryFields = {
  workspace: WorkspaceV2.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
  includeHidden: QueryBoolean.pipe(Schema.optional),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: SessionV2.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  withStatics((schema) => {
    const make = schema.make
    return {
      make: (input: typeof SessionsCursorInput.Type) =>
        make(Buffer.from(encodeSessionsCursor(input)).toString("base64url")),
      parse: (input: string) => decodeSessionsCursor(Buffer.from(input, "base64url").toString("utf8")),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionsCursorQuery = Schema.Struct({
  cursor: SessionsCursor.annotate({
    description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
  }),
  limit: SessionsQueryFields.limit,
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: ProjectV2.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsCursorQuery.fields.cursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const SessionGroup = HttpApiGroup.make("server.session")
  .add(
    HttpApiEndpoint.get("session.list", "/api/session", {
      query: SessionsQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionV2.Info),
        cursor: Schema.Struct({
          previous: SessionsCursor.pipe(Schema.optional),
          next: SessionsCursor.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionsResponse" }),
      error: [InvalidCursorError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.list",
        summary: "List sessions",
        description:
          "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("session.create", "/api/session", {
      payload: Schema.Struct({
        id: SessionV2.ID.pipe(Schema.optional),
        agent: AgentV2.ID.pipe(Schema.optional),
        model: ModelV2.Ref.pipe(Schema.optional),
        location: Location.Ref.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: SessionV2.Info }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.create",
        summary: "Create session",
        description: "Create a session at the requested location.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
      params: { sessionID: SessionV2.ID },
      success: Schema.Struct({ data: SessionV2.Info }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.get",
          summary: "Get session",
          description: "Retrieve a session by ID.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("session.metadata", "/api/session/:sessionID/metadata", {
      params: { sessionID: SessionV2.ID },
      payload: SessionV2.MetadataPatch,
      success: Schema.Struct({ data: SessionV2.Info }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.metadata",
          summary: "Patch session metadata",
          description: "Atomically set and unset individual session metadata keys without replacing unrelated keys.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        id: SessionMessage.ID.pipe(Schema.optional),
        prompt: Prompt,
        agent: AgentV2.ID.pipe(Schema.optional),
        model: ModelV2.Ref.pipe(Schema.optional),
        system: Schema.String.pipe(Schema.optional),
        delivery: SessionInput.Delivery.pipe(Schema.optional),
        resume: Schema.Boolean.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: SessionInput.Admitted }),
      error: [ConflictError, InvalidRequestError, SessionNotFoundError, UnknownError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.prompt",
          summary: "Send message",
          description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        id: SessionMessage.ID.pipe(Schema.optional),
        command: Schema.String,
        arguments: Schema.String.pipe(Schema.optional),
        agent: AgentV2.ID.pipe(Schema.optional),
        model: ModelV2.Ref.pipe(Schema.optional),
        files: Schema.Array(FileAttachment).pipe(Schema.optional),
        delivery: SessionInput.Delivery.pipe(Schema.optional),
        resume: Schema.Boolean.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: SessionInput.Admitted }),
      error: [ConflictError, InvalidRequestError, SessionNotFoundError, UnknownError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.command",
          summary: "Send command",
          description:
            "Resolve a registered V2 command template, durably admit it as a session input, and schedule execution unless resume is false.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.synthetic", "/api/session/:sessionID/synthetic", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        id: SessionMessage.ID.pipe(Schema.optional),
        text: Schema.String,
      }),
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, SessionNotFoundError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.synthetic",
          summary: "Append synthetic message",
          description: "Append a visible synthetic session message without scheduling assistant execution.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.resume", "/api/session/:sessionID/resume", {
      params: { sessionID: SessionV2.ID },
      success: HttpApiSchema.NoContent,
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.resume",
          summary: "Resume session",
          description: "Schedule an explicit SessionV2 continuation and return after the resume is accepted.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
      params: { sessionID: SessionV2.ID },
      success: HttpApiSchema.NoContent,
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.interrupt",
          summary: "Interrupt session",
          description: "Interrupt active SessionV2 work owned by this process. Idle interruption is a no-op.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.rollback", "/api/session/:sessionID/rollback", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        messageID: SessionMessage.ID,
        partID: Schema.String.pipe(Schema.optional),
        files: Schema.Literal("messages_only").pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: SessionV2.Info }),
      error: [SessionNotFoundError, MessageNotFoundError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.rollback",
          summary: "Rollback session",
          description:
            "Atomically interrupt active work, wait for authoritative idle cleanup, discard pending input and questions, and revert at an exact message boundary.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        agent: AgentV2.ID,
        model: ModelV2.Ref.pipe(Schema.optional),
      }),
      success: HttpApiSchema.NoContent,
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.switch_agent",
          summary: "Switch session agent",
          description: "Persist a selected agent switch for the session without scheduling assistant execution.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("session.heldInputs", "/api/session/:sessionID/held-inputs", {
      params: { sessionID: SessionV2.ID },
      success: Schema.Struct({ data: Schema.Array(SessionInput.Admitted) }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.held_inputs",
          summary: "List held session inputs",
          description: "List durable pending inputs paused by an explicit manual agent switch.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.releaseInput", "/api/session/:sessionID/held-inputs/:inputID/release", {
      params: { sessionID: SessionV2.ID, inputID: SessionMessage.ID },
      success: Schema.Struct({ data: Schema.Union([SessionInput.Admitted, Schema.Null]) }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.release_input",
          summary: "Release one held session input",
          description: "Release one durable held input under the session's currently selected agent and model.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({ model: ModelV2.Ref }),
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, UnknownError, ServiceUnavailableError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.switch_model",
          summary: "Switch session model",
          description: "Persist a selected model switch for the session without scheduling assistant execution.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.switchAgentAndPrompt", "/api/session/:sessionID/switch-agent-and-prompt", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        agent: AgentV2.ID,
        model: ModelV2.Ref.pipe(Schema.optional),
        prompt: Prompt,
        confirmation: Schema.Struct({
          requestID: Schema.String,
          revision: Schema.Int,
          actionID: Schema.String,
          invocationID: Schema.String,
          token: Schema.String,
        }),
      }),
      success: Schema.Struct({ data: SessionInput.Admitted }),
      error: [InvalidRequestError, SessionNotFoundError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.switch_agent_and_prompt",
          summary: "Switch agent and submit prompt",
          description:
            "Validate a durable user-confirmed Surface action, then atomically switch the selections and admit its exact prompt.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        command: Schema.String,
        agent: AgentV2.ID.pipe(Schema.optional),
      }),
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, ServiceUnavailableError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.shell",
          summary: "Run shell command",
          description: "Run a shell command through the Location-scoped bash tool and append shell output events.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.skill", "/api/session/:sessionID/skill", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({ skill: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, InvalidRequestError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.skill",
          summary: "Inject session skill",
          description:
            "Load a skill and append its instructions as a synthetic session message without scheduling execution.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("session.skillSelections", "/api/session/:sessionID/skill-selections", {
      params: { sessionID: SessionV2.ID },
      success: Schema.Struct({
        data: Schema.Struct({
          sessionID: SessionV2.ID,
          revision: Schema.Finite,
          serverNow: Schema.Finite,
          selections: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              status: Schema.Literals([
                "active",
                "expired_time",
                "expired_messages",
                "forgotten",
                "renewal_declined",
                "missing",
                "origin_unverified",
                "state_unavailable",
              ]),
              generation: Schema.Finite,
              originKind: Schema.Literals(["input", "chat_send", "command", "renewal"]),
              selectedAt: Schema.Finite,
              expiresAt: Schema.Finite.pipe(Schema.optional),
              remainingMs: Schema.Finite,
              remainingMessages: Schema.Finite,
              limitMinutes: Schema.Finite,
              limitMessages: Schema.Finite,
              recognized: Schema.Boolean,
            }),
          ),
        }),
      }),
      error: [SessionNotFoundError, ServiceUnavailableError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.skill_selections",
          summary: "List remembered skill selections",
          description:
            "Read the durable same-chat skill selection ledger for one session with derived remaining validity.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.skillSelectionForget", "/api/session/:sessionID/skill-selections/forget", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        name: Schema.String.pipe(Schema.optional),
        all: Schema.Boolean.pipe(Schema.optional),
        expectedRevision: Schema.Finite,
        operationID: Schema.String,
      }),
      success: Schema.Struct({
        data: Schema.Struct({
          revision: Schema.Finite,
          outcome: Schema.Literals(["forgotten", "revision_conflict", "duplicate_operation"]),
        }),
      }),
      error: [SessionNotFoundError, InvalidRequestError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.skill_selection_forget",
          summary: "Forget remembered skill selections",
          description:
            "Forget one skill selection or all selections of this session. Never touches durable allow/deny policy.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.chatSend", "/api/session/:sessionID/chat-send", {
      params: { sessionID: SessionV2.ID },
      payload: Schema.Struct({
        requestID: Schema.String,
        text: Schema.String,
        id: Schema.String,
      }),
      success: Schema.Struct({
        data: Schema.Struct({
          admitted: SessionInput.Admitted,
          selections: Schema.Array(Schema.String),
        }),
      }),
      error: [SessionNotFoundError, InvalidRequestError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.chat_send",
          summary: "Send the one-click chat approval",
          description:
            "Host-bound chat-send adapter for a pending blocking question: verifies the stored chatSend text, " +
            "admits the exact interactive prompt with a stable input id, and settles the question. " +
            "Skill selection is established only by normal input promotion and the consuming gate, never by the click itself.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
      params: { sessionID: SessionV2.ID },
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, UnknownError, ServiceUnavailableError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.compact",
          summary: "Compact session",
          description: "Compact a session conversation.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("session.activity", "/api/session/:sessionID/activity", {
      params: { sessionID: SessionV2.ID },
      query: Schema.Struct({ messageID: SessionMessage.ID.pipe(Schema.optional) }),
      success: Schema.Struct({
        data: Schema.Struct({
          type: Schema.Literals(["idle", "busy"]),
          activityID: Schema.String.pipe(Schema.optional),
          activityStatus: Schema.Literals(["running", "recovering", "completed", "failed", "interrupted"]).pipe(
            Schema.optional,
          ),
          lastError: Schema.String.pipe(Schema.optional),
          turnCompletionResult: Schema.Literals(["done", "incomplete", "unknown", "skipped"]).pipe(Schema.optional),
        }),
      }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.activity",
          summary: "Get session activity",
          description: "Read the authoritative durable activity state for a session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
      params: { sessionID: SessionV2.ID },
      success: HttpApiSchema.NoContent,
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.wait",
          summary: "Wait for session",
          description: "Wait for a session agent loop to become idle.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.cancelTool", "/api/session/:sessionID/tool/:callID/cancel", {
      params: { sessionID: SessionV2.ID, callID: Schema.String },
      success: Schema.Struct({ data: Schema.Struct({ cancelled: Schema.Boolean }) }).annotate({
        identifier: "SessionToolCancelResponse",
      }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.cancelTool",
          summary: "Cancel tool call",
          description: "Cancel one active tool call in a running session without interrupting the whole session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
      params: { sessionID: SessionV2.ID },
      success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
      error: [SessionNotFoundError, UnknownError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.context",
          summary: "Get session context",
          description: "Retrieve the active context messages for a session (all messages after the last compaction).",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "sessions",
      description: "Experimental session routes.",
    }),
  )
