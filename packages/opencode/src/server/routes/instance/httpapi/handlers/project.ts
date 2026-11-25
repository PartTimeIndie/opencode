import * as InstanceState from "@/effect/instance-state"
import { ProjectIconGeneration } from "@/project/icon-generation"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const icons = yield* ProjectIconGeneration.Service
    const project = yield* ProjectV2.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    const directoryIcons = Effect.fn("ProjectHttpApi.directoryIcons")(function* () {
      return yield* svc.directoryIcons()
    })

    const directoryIcon = Effect.fn("ProjectHttpApi.directoryIcon")(function* (ctx: {
      payload: Project.DirectoryIconInput
    }) {
      return yield* svc.setDirectoryIcon(ctx.payload)
    })

    const resolve = Effect.fn("ProjectHttpApi.resolve")(function* (ctx: {
      payload: { directories: readonly string[] }
    }) {
      return yield* svc.resolveDirectories(ctx.payload.directories)
    })

    const requireIconResult = Effect.fnUntraced(function* (
      projectID: ProjectV2.ID,
      result: Project.Info | undefined,
    ) {
      if (result) return result
      return yield* new ProjectNotFoundError({ projectID, message: `Project not found: ${projectID}` })
    })

    const generateIcon = Effect.fn("ProjectHttpApi.generateIcon")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: { force?: boolean }
    }) {
      return yield* requireIconResult(ctx.params.projectID, yield* icons.enqueue(ctx.params.projectID, ctx.payload.force))
    })

    const retryIcon = Effect.fn("ProjectHttpApi.retryIcon")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
    }) {
      return yield* requireIconResult(ctx.params.projectID, yield* icons.enqueue(ctx.params.projectID, true))
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("generateIcon", generateIcon)
      .handle("retryIcon", retryIcon)
      .handle("directories", directories)
      .handle("directoryIcons", directoryIcons)
      .handle("directoryIcon", directoryIcon)
      .handle("resolve", resolve)
  }),
)
