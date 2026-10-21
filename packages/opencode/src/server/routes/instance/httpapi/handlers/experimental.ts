import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { McpTool } from "@opencode-ai/core/mcp/tool"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { TaskJob } from "@opencode-ai/core/tool/task-job"
import path from "path"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { ConsoleSwitchPayload, SessionListQuery, SessionUsageApiError, SessionUsageQuery, ToolListQuery, WorktreeApiError } from "../groups/experimental"
import { mapStorageNotFound } from "./session-errors"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { Database } from "@opencode-ai/core/database/database"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

function parseSessionCursor(cursor: string | undefined) {
  if (!cursor) return {}
  const [updated, id] = cursor.split(":")
  const time = Number(updated)
  if (!Number.isFinite(time)) return {}
  return { cursor: time, cursorID: id || undefined }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const locations = yield* LocationServiceMap
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const instance = yield* InstanceState.context
      const location = locations.get(
        Location.Ref.make({
          directory: AbsolutePath.make(instance.directory),
          workspaceID: yield* InstanceState.workspaceID,
        }),
      )
      const [list, catalog] = yield* Effect.gen(function* () {
        yield* McpTool.Service.use((mcpTools) => mcpTools.refresh()).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest({})),
        )
        return yield* Effect.all(
          [
            ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
              Effect.map((materialized) => materialized.definitions),
            ),
            ToolRegistry.Service.use((registry) => registry.catalog()),
          ],
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(location))
      return [
        ...list.map((item) => {
          const metadata = catalog.find((entry) => entry.id === item.name)
          return {
            id: item.name,
            description: item.description,
            parameters: item.inputSchema,
            scope: metadata?.scope ?? ("location" as const),
            ...(metadata?.project ? { project: metadata.project } : {}),
            ...(metadata?.source ? { source: metadata.source } : {}),
            ...(metadata?.version ? { version: metadata.version } : {}),
            visible: metadata?.visible ?? true,
          }
        }),
      ]
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.gen(function* () {
        yield* McpTool.Service.use((mcpTools) => mcpTools.refresh()).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest({})),
        )
        return yield* ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
          Effect.map((materialized) => materialized.definitions.map((item) => item.name)),
        )
      }).pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({
              directory: AbsolutePath.make(instance.directory),
              workspaceID: yield* InstanceState.workspaceID,
            }),
          ),
        ),
      )
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const all = yield* sessions.listGlobal({
        directory: ctx.query.directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        ...parseSessionCursor(ctx.query.cursor),
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
        includeHidden: ctx.query.includeHidden,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? {
                "Access-Control-Expose-Headers": "x-next-cursor",
                "x-next-cursor": `${list[list.length - 1].time.updated}:${list[list.length - 1].id}`,
              }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const sessionTasks = Effect.fn("ExperimentalHttpApi.sessionTasks")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const instance = yield* InstanceState.context
      const parent = yield* mapStorageNotFound(sessions.get(ctx.params.sessionID))
      const selectedDirectory = path.resolve(instance.directory)
      const parentDirectory = path.resolve(parent.directory)
      if (
        process.platform === "win32"
          ? selectedDirectory.toLowerCase() !== parentDirectory.toLowerCase()
          : selectedDirectory !== parentDirectory
      )
        return yield* Effect.fail(notFound(`Session not found: ${ctx.params.sessionID}`))
      return yield* TaskJob.Service.use((jobs) => jobs.list(ctx.params.sessionID)).pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))),
      )
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    const sessionUsage = Effect.fn("ExperimentalHttpApi.sessionUsage")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof SessionUsageQuery.Type
    }) {
      const { db } = yield* Database.Service
      const summary = yield* SessionUsage.summarize(db, {
        sessionID: ctx.params.sessionID,
        ...(ctx.query.activityID ? { activityID: ctx.query.activityID } : {}),
      }).pipe(
        Effect.catchTag("SessionUsage.NotFound", (error) =>
          Effect.fail(
            new SessionUsageApiError({
              name: "SessionUsageNotFound",
              data: { message: `Session not found: ${error.sessionID}` },
            }),
          ),
        ),
        Effect.catchTag("SessionUsage.ActivityMismatch", (error) =>
          Effect.fail(
            new SessionUsageApiError({
              name: "SessionUsageActivityMismatch",
              data: { message: `Activity ${error.activityID} does not belong to session ${error.sessionID}` },
            }),
          ),
        ),
        Effect.catchTag("SqlError", (error) => Effect.die(error)),
      )
      // `run` is omitted when the session has no activity window; the SDK type
      // carries it as optional because the codegen drops nullable $ref members.
      return {
        sessionID: summary.sessionID,
        ...(summary.activityID ? { activityID: summary.activityID } : {}),
        asOf: summary.asOf,
        ...(summary.sequence === undefined ? {} : { sequence: summary.sequence }),
        session: summary.session,
        ...(summary.run ? { run: summary.run } : {}),
      }
    })

    return handlers
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("sessionTasks", sessionTasks)
      .handle("sessionUsage", sessionUsage)
      .handle("resource", resource)
  }),
)
