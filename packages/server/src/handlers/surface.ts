import { SessionV2 } from "@opencode-ai/core/session"
import { Surface } from "@opencode-ai/core/surface"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ConflictError, SurfaceNotFoundError } from "../errors"
import { response } from "../groups/location"

function missingRequest(id: Surface.ID) {
  return new SurfaceNotFoundError({ requestID: id, message: `Surface request not found: ${id}` })
}

function missingTool(id: Surface.PersistentToolID) {
  return new SurfaceNotFoundError({ requestID: id, message: `Surface tool not found: ${id}` })
}

function conflict(error: Surface.ConflictError) {
  return new ConflictError({ resource: String(error.requestID), message: error.reason })
}

export const dismissSurfaceRequest = Effect.fn("SurfaceHandler.dismissSurfaceRequest")(function* (input: {
  sessionID: SessionV2.ID
  requestID: Surface.ID
}) {
  yield* Surface.Service.use((surface) => surface.reject(input.requestID, input.sessionID))
  return { status: "settled" as const }
})

export const SurfaceHandler = HttpApiBuilder.group(Api, "server.surface", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "surface.request.list",
        Effect.fn(function* () {
          return yield* response((yield* Surface.Service).list())
        }),
      )
      .handle(
        "surface.tool.list",
        Effect.fn(function* (ctx) {
          return yield* response((yield* Surface.Service).listPersistentTools(ctx.query.includeHidden === true))
        }),
      )
      .handle(
        "session.surface.list",
        Effect.fn(function* (ctx) {
          const requests = yield* (yield* Surface.Service).list()
          return { data: requests.filter((request) => request.sessionID === ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.surface.reply",
        Effect.fn(function* (ctx) {
          yield* Surface.Service.use((surface) =>
            surface.reply({
              sessionID: ctx.params.sessionID,
              requestID: ctx.params.requestID,
              answers: ctx.payload.answers,
            }),
          ).pipe(
            Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID)),
            Effect.catchTag(
              "QuestionV2.ConflictError",
              conflict,
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.surface.dismiss",
        Effect.fn(function* (ctx) {
          return yield* dismissSurfaceRequest(ctx.params).pipe(
            Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID)),
            Effect.catchTag(
              "QuestionV2.ConflictError",
              conflict,
            ),
          )
        }),
      )
      .handle(
        "session.surface.pin",
        Effect.fn(function* (ctx) {
          return yield* Surface.Service.use((surface) =>
            surface.createPersistentTool({
              sessionID: ctx.params.sessionID,
              requestID: ctx.params.requestID,
              expectedRevision: ctx.payload.expectedRevision,
              scope: ctx.payload.scope,
            }),
          ).pipe(
            Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID)),
            Effect.catchTag("QuestionV2.ConflictError", conflict),
          )
        }),
      )
      .handle(
        "surface.tool.state",
        Effect.fn(function* (ctx) {
          return yield* Surface.Service.use((surface) =>
            surface.updatePersistentToolState({
              toolID: ctx.params.toolID,
              expectedRevision: ctx.payload.expectedRevision,
              values: ctx.payload.values,
            }),
          ).pipe(
            Effect.catchTag("Surface.PersistentToolNotFoundError", () => missingTool(ctx.params.toolID)),
            Effect.catchTag("QuestionV2.ConflictError", conflict),
          )
        }),
      )
      .handle(
        "surface.tool.visibility",
        Effect.fn(function* (ctx) {
          return yield* Surface.Service.use((surface) =>
            surface.setPersistentToolHidden(ctx.params.toolID, ctx.payload.hidden),
          ).pipe(Effect.catchTag("Surface.PersistentToolNotFoundError", () => missingTool(ctx.params.toolID)))
        }),
      )
      .handle(
        "surface.tool.remove",
        Effect.fn(function* (ctx) {
          yield* Surface.Service.use((surface) => surface.removePersistentTool(ctx.params.toolID)).pipe(
            Effect.catchTag("Surface.PersistentToolNotFoundError", () => missingTool(ctx.params.toolID)),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
