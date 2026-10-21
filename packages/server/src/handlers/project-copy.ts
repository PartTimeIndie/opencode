import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { Git } from "@opencode-ai/core/git"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProjectCopyError } from "../groups/project-copy"

export const ProjectCopyHandler = HttpApiBuilder.group(Api, "server.projectCopy", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap
    return handlers
      .handle("projectCopy.create", (ctx) =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          return yield* badRequest(
            ProjectCopy.Service.use((copies) =>
              copies.create({
                ...ctx.payload,
                projectID: ctx.params.projectID,
                sourceDirectory: location.project.directory,
              }),
            ),
          ).pipe(Effect.provide(locations.get(new Location.Ref(location))))
        }),
      )
      .handle("projectCopy.remove", (ctx) =>
        Location.Service.use((location) =>
          ProjectCopy.Service.use((copies) =>
            badRequest(copies.remove({ ...ctx.payload, projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            ),
          ).pipe(Effect.provide(locations.get(new Location.Ref(location)))),
        ),
      )
      .handle("projectCopy.handback", (ctx) =>
        Location.Service.use((location) =>
          ProjectCopy.Service.use((copies) =>
            badRequest(copies.handback({ ...ctx.payload, projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            ),
          ).pipe(Effect.provide(locations.get(new Location.Ref(location)))),
        ),
      )
      .handle("projectCopy.refresh", (ctx) =>
        Location.Service.use((location) =>
          ProjectCopy.Service.use((copies) =>
            badRequest(copies.refresh({ projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            ),
          ).pipe(Effect.provide(locations.get(new Location.Ref(location)))),
        ),
      )
  }),
)

function badRequest<A, R>(effect: Effect.Effect<A, ProjectCopy.Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new ProjectCopyError({
          name: "ProjectCopyError",
          data: {
            message: message(error),
            forceRequired:
              error instanceof Git.WorktreeError || error instanceof ProjectCopy.CopyRemovalError
                ? error.forceRequired
                : undefined,
          },
        }),
    ),
  )
}

function message(error: ProjectCopy.Error) {
  if (error instanceof ProjectCopy.SourceDirectoryNotFoundError)
    return `Project copy source not found: ${error.directory}`
  if (error instanceof ProjectCopy.DestinationExistsError)
    return `Project copy destination already exists: ${error.directory}`
  if (error instanceof ProjectCopy.DirectoryUnavailableError)
    return `Project copy directory unavailable: ${error.directory}`
  if (error instanceof ProjectCopy.CopyUnavailableError) return error.message
  if (error instanceof ProjectCopy.InvalidDirectoryError) return `Invalid project copy directory: ${error.directory}`
  if (error instanceof ProjectCopy.StrategyUnavailableError)
    return `Project copy strategy unavailable: ${error.strategy}`
  return error.message
}
