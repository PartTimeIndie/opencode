import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ApiNotFoundError } from "../errors"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const UsageTotals = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cost: Schema.Finite,
  total: Schema.Finite,
}).annotate({ identifier: "SessionUsageTotals" })

const UsageMeasuredValue = Schema.Struct({
  known: Schema.optional(Schema.Finite),
  complete: Schema.Boolean,
}).annotate({ identifier: "SessionUsageMeasuredValue" })

const UsageMeasurement = Schema.Struct({
  complete: Schema.Boolean,
  reportedSteps: NonNegativeInt,
  unreportedSteps: NonNegativeInt,
  categories: Schema.Struct({
    input: UsageMeasuredValue,
    output: UsageMeasuredValue,
    reasoning: UsageMeasuredValue,
    cacheRead: UsageMeasuredValue,
    cacheWrite: UsageMeasuredValue,
    inputTotal: UsageMeasuredValue,
    outputTotal: UsageMeasuredValue,
    total: UsageMeasuredValue,
  }),
}).annotate({ identifier: "SessionUsageMeasurement" })

const UsageAttribution = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "unknown"]),
  reasons: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionUsageAttribution" })

const UsageModelSelection = Schema.Struct({
  model: ModelV2.Ref,
  source: Schema.Literals(["prompt", "model-switch"]),
  sequence: Schema.Finite,
}).annotate({ identifier: "SessionUsageModelSelection" })

const UsageModelObservation = Schema.Struct({
  model: ModelV2.Ref,
  sequence: Schema.Finite,
}).annotate({ identifier: "SessionUsageModelObservation" })

const UsageRun = Schema.Struct({
  activityID: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  running: Schema.Boolean,
  timeStart: Schema.Finite,
  timeEnd: Schema.optional(Schema.Finite),
  timeUpdated: Schema.optional(Schema.Finite),
  openedSeq: Schema.optional(Schema.Finite),
  closedSeq: Schema.optional(Schema.Finite),
  own: UsageTotals,
  descendants: UsageTotals,
  total: UsageTotals,
  complete: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  generationMs: Schema.optional(NonNegativeInt),
  attribution: Schema.optional(UsageAttribution),
  measurement: Schema.optional(Schema.Struct({
    own: UsageMeasurement,
    descendants: UsageMeasurement,
    total: UsageMeasurement,
  })),
  models: Schema.optional(Schema.Struct({
    selected: Schema.Array(UsageModelSelection),
    observed: Schema.Array(UsageModelObservation),
    complete: Schema.Boolean,
  })),
}).annotate({ identifier: "SessionUsageRun" })

export const SessionUsageResponse = Schema.Struct({
  sessionID: Schema.String,
  activityID: Schema.optional(Schema.String),
  asOf: Schema.Finite,
  sequence: Schema.optional(Schema.Finite),
  session: Schema.Struct({
    own: UsageTotals,
    descendants: UsageTotals,
    total: UsageTotals,
    descendantSessions: NonNegativeInt,
    complete: Schema.Boolean,
    generationMs: Schema.optional(NonNegativeInt),
  }).annotate({ identifier: "SessionUsageSession" }),
  run: Schema.optional(Schema.NullOr(UsageRun)),
}).annotate({ identifier: "SessionUsageResponse" })

const SessionUsageApiErrorName = Schema.Literals(["SessionUsageNotFound", "SessionUsageActivityMismatch"])
export class SessionUsageApiError extends Schema.ErrorClass<SessionUsageApiError>("SessionUsageError")(
  {
    name: SessionUsageApiErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const BackgroundTask = Schema.Struct({
  taskID: SessionID,
  parentSessionID: SessionID,
  title: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
  timeCompleted: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "ExperimentalBackgroundTask" })

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
  scope: Schema.Literals(["application", "location"]),
  project: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  visible: Schema.Boolean,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: Schema.optional(ProviderV2.ID),
  model: Schema.optional(ModelV2.ID),
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
  includeHidden: Schema.optional(QueryBoolean),
})

export const SessionUsageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  activityID: Schema.optional(Schema.String),
})

export const ExperimentalPaths = {
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  sessionTasks: "/experimental/session/:sessionID/tasks",
  sessionUsage: "/experimental/session/:sessionID/usage",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get the current workspace's configurable tool catalog with JSON schema parameters, including inactive tools. Listing does not grant execution access. Provider and model query parameters are accepted for compatibility but do not filter this catalog.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get configurable tool IDs for the current workspace, including inactive built-in and dynamically registered tools. Listing does not grant execution access.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("sessionTasks", ExperimentalPaths.sessionTasks, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(BackgroundTask), "Durable background tasks"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.tasks",
            summary: "List durable background tasks",
            description: "List active and terminal background subagent tasks for a parent session.",
          }),
        ),
        HttpApiEndpoint.get("sessionUsage", ExperimentalPaths.sessionUsage, {
          params: { sessionID: SessionID },
          query: SessionUsageQuery,
          success: described(SessionUsageResponse, "Session and run usage with subagent attribution"),
          error: SessionUsageApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.usage",
            summary: "Get session usage",
            description:
              "Read-only token/cost totals for a session including all descendant sessions, plus the latest (or requested) run activity window with provenance-based subagent attribution.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
