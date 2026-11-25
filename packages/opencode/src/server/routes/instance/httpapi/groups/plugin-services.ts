import { Schema } from "effect"
import { SessionPluginContext } from "@opencode-ai/core/session/plugin-context"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors"

export const PluginServicesApi = HttpApi.make("pluginServices").add(
  HttpApiGroup.make("pluginServices")
    .add(
      HttpApiEndpoint.post("sessionContext", "/app/host/session-context", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          caller: Schema.Struct({ id: Schema.String, version: Schema.String, hash: Schema.String }),
          sessionID: Schema.String,
          limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
          maxTextChars: Schema.optional(
            Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(48_000)),
          ),
        }),
        success: Schema.Struct({ ok: Schema.Literal(true), context: SessionPluginContext.Info }),
        error: [ForbiddenError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginServices.sessionContext",
          summary: "Read bounded session context and pending requests for any authorized app plugin",
        }),
      ),
      HttpApiEndpoint.post("sessionPolicy", "/app/host/session-policy", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          caller: Schema.Struct({ id: Schema.String, version: Schema.String, hash: Schema.String }),
          action: Schema.Literals(["read", "write"]),
          sessionID: Schema.optional(Schema.String),
          mode: Schema.optional(Schema.Literals(["ask", "approve_for_me", "full_access"])),
        }),
        success: Schema.Struct({
          ok: Schema.Literal(true),
          mode: Schema.Literals(["ask", "approve_for_me", "full_access"]),
        }),
        error: [ForbiddenError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginServices.sessionPolicy",
          summary: "Read or set a plugin-authorized session access policy",
        }),
      ),
      HttpApiEndpoint.post("sessionGoal", "/app/host/session-goal", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          sessionID: Schema.String,
          action: Schema.Literals(["pause", "resume"]),
          // Best-effort optimistic guard: a client that captured an older run
          // or revision gets an explicit rejection instead of a mutation.
          runID: Schema.optional(Schema.String),
          operationID: Schema.String,
          expectedRevision: Schema.optional(
            Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          ),
        }),
        success: Schema.Struct({
          ok: Schema.Literal(true),
          data: Schema.Unknown,
        }),
        error: [ForbiddenError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginServices.sessionGoal",
          summary: "Built-in user control for the session goal plugin lifecycle (pause/resume)",
        }),
      ),
      HttpApiEndpoint.post("call", "/plugins/:pluginID/services/:serviceID", {
        params: Schema.Struct({ pluginID: Schema.String, serviceID: Schema.String }),
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({
          caller: Schema.Struct({ id: Schema.String, version: Schema.String, hash: Schema.String }),
          version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
          input: Schema.Unknown,
        }),
        success: Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
        error: [ForbiddenError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "pluginServices.call", summary: "Call a registered plugin service" }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
