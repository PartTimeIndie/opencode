import { Location } from "@opencode-ai/core/location"
import { SessionV2 } from "@opencode-ai/core/session"
import { Surface } from "@opencode-ai/core/surface"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, SessionNotFoundError, SurfaceNotFoundError } from "../errors"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { LocationMiddleware, LocationQuery, locationQueryOpenApi } from "./location"

export const SurfaceDismissSettlement = Schema.Struct({
  status: Schema.Literals(["settled", "interrupted", "settling"]),
  activityID: Schema.String.pipe(Schema.optional),
})

export const SurfaceToolCreate = Schema.Struct({
  scope: Surface.PersistentToolScope,
  expectedRevision: Schema.Int,
})

export const SurfaceToolStateUpdate = Schema.Struct({
  expectedRevision: Schema.Int,
  values: Schema.Record(Schema.String, Schema.Unknown),
})

export const SurfaceToolVisibilityUpdate = Schema.Struct({ hidden: Schema.Boolean })

export const SurfaceGroup = HttpApiGroup.make("server.surface")
  .add(
    HttpApiEndpoint.get("surface.request.list", "/api/surface/request", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Surface.Request)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.surface.request.list",
          summary: "List pending Surface requests",
          description: "Retrieve pending blocking, interactive, and passive Surface requests for a location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("surface.tool.list", "/api/surface/tool", {
      query: Schema.Struct({ ...LocationQuery.fields, includeHidden: Schema.Boolean.pipe(Schema.optional) }),
      success: Location.response(Schema.Array(Surface.PersistentTool)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.surface.tool.list",
          summary: "List persistent Surface tools",
          description: "Retrieve app-global and current-project persistent Surface tools.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "surfaces", description: "Durable Surface routes." }))
  .middleware(LocationMiddleware)
  .add(
    HttpApiEndpoint.get("session.surface.list", "/api/session/:sessionID/surface", {
      params: { sessionID: SessionV2.ID },
      success: Schema.Struct({ data: Schema.Array(Surface.Request) }),
      error: SessionNotFoundError,
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.surface.list",
          summary: "List session Surface requests",
          description: "Retrieve pending Surface requests owned by a session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.surface.reply", "/api/session/:sessionID/surface/:requestID/reply", {
      params: { sessionID: SessionV2.ID, requestID: Surface.ID },
      payload: Surface.Reply,
      success: HttpApiSchema.NoContent,
      error: [SessionNotFoundError, SurfaceNotFoundError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.surface.reply",
          summary: "Reply to a blocking Surface",
          description: "Answer a pending blocking Surface request owned by a session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.surface.dismiss", "/api/session/:sessionID/surface/:requestID/dismiss", {
      params: { sessionID: SessionV2.ID, requestID: Surface.ID },
      success: SurfaceDismissSettlement,
      error: [SessionNotFoundError, SurfaceNotFoundError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.surface.dismiss",
          summary: "Dismiss a pending Surface",
          description: "Dismiss a pending Surface without interrupting the owning session activity.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("session.surface.pin", "/api/session/:sessionID/surface/:requestID/pin", {
      params: { sessionID: SessionV2.ID, requestID: Surface.ID },
      payload: SurfaceToolCreate,
      success: Surface.PersistentTool,
      error: [SessionNotFoundError, SurfaceNotFoundError, ConflictError],
    })
      .middleware(SessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.surface.pin",
          summary: "Create a persistent tool from a Surface",
          description: "Copy a pending interactive or passive Surface into an independent persistent tool.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("surface.tool.state", "/api/surface/tool/:toolID/state", {
      params: { toolID: Surface.PersistentToolID },
      query: LocationQuery,
      payload: SurfaceToolStateUpdate,
      success: Surface.PersistentTool,
      error: [SurfaceNotFoundError, ConflictError],
    })
      .middleware(LocationMiddleware)
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.surface.tool.state",
          summary: "Update persistent Surface tool state",
          description: "Replace versioned values with optimistic revision checking.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("surface.tool.visibility", "/api/surface/tool/:toolID/visibility", {
      params: { toolID: Surface.PersistentToolID },
      query: LocationQuery,
      payload: SurfaceToolVisibilityUpdate,
      success: Surface.PersistentTool,
      error: SurfaceNotFoundError,
    })
      .middleware(LocationMiddleware)
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.surface.tool.visibility",
          summary: "Hide or restore a persistent Surface tool",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("surface.tool.remove", "/api/surface/tool/:toolID", {
      params: { toolID: Surface.PersistentToolID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: SurfaceNotFoundError,
    })
      .middleware(LocationMiddleware)
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.surface.tool.remove",
          summary: "Remove a persistent Surface tool",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "session surfaces", description: "Durable session Surface routes." }))
