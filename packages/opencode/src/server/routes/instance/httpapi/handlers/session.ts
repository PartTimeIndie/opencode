import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import * as SessionProtection from "@opencode-ai/core/session/protection"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Source } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { TurnCompletionV2 } from "@/session/turn-completion-v2"
import { Todo } from "@/session/todo"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  DeleteQuery,
  DiffQuery,
  ForkPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  ProtectionPayload,
  RevertPayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError, notFound } from "../errors"
import { sameEventDirectory } from "./event"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const { db } = yield* Database.Service
    const archive = yield* SessionArchive.Service
    const content = yield* ContentStore.Service
    const shareSvc = yield* SessionShare.Service
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    yield* TurnCompletionV2.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
        includeHidden: ctx.query.includeHidden,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      const instance = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const legacy = yield* statusSvc.list()
      const active = yield* db
        .select({
          sessionID: SessionActivityTable.session_id,
          directory: SessionTable.directory,
          projectID: SessionTable.project_id,
          workspaceID: SessionTable.workspace_id,
        })
        .from(SessionActivityTable)
        .innerJoin(SessionTable, eq(SessionActivityTable.session_id, SessionTable.id))
        .where(
          and(
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            gt(SessionActivityTable.lease_until, Date.now()),
            eq(SessionTable.project_id, instance.project.id),
            workspaceID ? eq(SessionTable.workspace_id, workspaceID) : isNull(SessionTable.workspace_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      // A blocking question is durable session state, not evidence that its
      // originating runner still owns a live lease. Keep it independent from
      // activity liveness so a stale runner cannot hide a question that still
      // requires user input.
      const waiting = yield* db
        .select({
          sessionID: QuestionTable.session_id,
          directory: SessionTable.directory,
          projectID: SessionTable.project_id,
          workspaceID: SessionTable.workspace_id,
        })
        .from(QuestionTable)
        .innerJoin(SessionTable, eq(QuestionTable.session_id, SessionTable.id))
        .where(
          and(
            eq(QuestionTable.state, "active"),
            eq(QuestionTable.mode, "blocking"),
            eq(SessionTable.project_id, instance.project.id),
            workspaceID ? eq(SessionTable.workspace_id, workspaceID) : isNull(SessionTable.workspace_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const legacySessions = legacy.size
        ? yield* db
            .select({
              sessionID: SessionTable.id,
              directory: SessionTable.directory,
              projectID: SessionTable.project_id,
              workspaceID: SessionTable.workspace_id,
            })
            .from(SessionTable)
            .where(
              and(
                inArray(SessionTable.id, [...legacy.keys()]),
                eq(SessionTable.project_id, instance.project.id),
                workspaceID ? eq(SessionTable.workspace_id, workspaceID) : isNull(SessionTable.workspace_id),
              ),
            )
            .all()
            .pipe(Effect.orDie)
        : []
      const matches = (item: Pick<(typeof active)[number], "directory" | "projectID" | "workspaceID">) =>
        sameEventDirectory(item.directory, instance.directory) &&
        item.projectID === instance.project.id &&
        (item.workspaceID ?? undefined) === workspaceID
      return Object.fromEntries([
        ...legacySessions.filter(matches).flatMap((item) => {
          const value = legacy.get(SessionID.make(item.sessionID))
          return value ? ([[item.sessionID, value]] as const) : []
        }),
        ...active.filter(matches).map((item) => [item.sessionID, { type: "busy" as const }] as const),
        ...waiting.filter(matches).map((item) => [item.sessionID, { type: "waiting_for_user" as const }] as const),
      ])
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const activateForMutation = Effect.fn("SessionHttpApi.activateForMutation")(function* (sessionID: SessionID) {
      const entry = yield* archive
        .getCatalog(sessionID)
        .pipe(Effect.catchTag("SessionArchive.NotFoundError", () => Effect.succeed(undefined)))
      if (entry?.location !== "archived") return
      yield* archive.ensureActive(sessionID).pipe(
        Effect.catchTag("SessionArchive.NotFoundError", (error) => Effect.die(error)),
        Effect.catchTag("SessionArchive.IntegrityError", (error) => Effect.die(error)),
      )
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const exists = Effect.fn("SessionHttpApi.exists")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* session.get(ctx.params.sessionID).pipe(
        Effect.map((info) => ({ exists: true as const, session: info })),
        Effect.catchTag("NotFoundError", () => Effect.succeed({ exists: false as const })),
      )
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DeleteQuery.Type
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* session
        .remove({
          sessionID: ctx.params.sessionID,
          overrideProtection: ctx.query.overrideProtection === true,
        })
        .pipe(
          Effect.catchTag("NotFoundError", (error) => Effect.fail(notFound(error.message))),
          Effect.catchTag("SessionProtection.ProtectedError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        )
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
      }
      if (ctx.payload.metadataPatch !== undefined) {
        yield* session.setMetadataPatch({ sessionID: ctx.params.sessionID, patch: ctx.payload.metadataPatch })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        if (current.protected) return yield* new HttpApiError.BadRequest({})
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const protection = Effect.fn("SessionHttpApi.protection")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ProtectionPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionProtection.setProtected(db, ctx.params.sessionID, ctx.payload.protected).pipe(
        Effect.catchTag("SessionProtection.NotFoundError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      const input = { sessionID: ctx.params.sessionID, ...ctx.payload }
       return yield* SessionError.mapBusy(revertSvc.revert(input))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* activateForMutation(ctx.params.sessionID)
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      if (payload.type !== "file") return yield* session.updatePart(payload)
      const file = (yield* content
        .normalizeFiles({
          sessionID: SessionSchema.ID.make(payload.sessionID),
          messageID: SessionMessage.ID.make(payload.messageID),
          key: `legacy-part:${payload.id}`,
          files: [
            new FileAttachment({
              uri: payload.url,
              mime: payload.mime,
              name: payload.filename,
              source: payload.source
                ? new Source({
                    start: payload.source.text.start,
                    end: payload.source.text.end,
                    text: payload.source.text.value,
                  })
                : undefined,
            }),
          ],
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))))[0]!
      return yield* session.updatePart({
        ...payload,
        url: file.uri,
        mime: file.mime,
        filename: file.name,
        source:
          payload.source && file.source
            ? {
                ...payload.source,
                text: {
                  value: file.source.text,
                  start: file.source.start,
                  end: file.source.end,
                },
              }
            : payload.source,
      })
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("exists", exists)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handle("protection", protection)
      .handleRaw("fork", forkRaw)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
