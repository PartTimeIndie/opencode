import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage as SessionMessageV2 } from "@opencode-ai/core/session/message"
import { and, eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
  files: Schema.optional(Schema.Literal("messages_only")),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

type RevertState = NonNullable<Session.Info["revert"]>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const fileMutations = yield* SessionFileMutation.Service
    const database = yield* Database.Service

    const writeRevert = Effect.fn("SessionRevert.writeRevert")(function* (input: {
      sessionID: SessionID
      messages: SessionV1.WithParts[]
      revert: RevertState
    }) {
      const range = input.messages.filter((msg) => msg.info.id >= input.revert.messageID)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: input.revert,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (session.revert?.status === "reverted" && session.revert.fileAction) return session

      let rev: RevertState | undefined
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        if (!rev && msg.info.id === input.messageID && !input.partID) {
          rev = { messageID: lastUser?.id ?? msg.info.id }
        }
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            continue
          }

          if (!rev) {
            if (part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev && !input.partID) {
        const target = yield* database.db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              eq(SessionMessageTable.id, SessionMessageV2.ID.make(input.messageID)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (target) rev = { messageID: input.messageID }
      }
      if (!rev) return session

      const repair =
        session.revert?.messageID === rev.messageID && session.revert.partID === rev.partID
          ? session.revert.repair
          : undefined
      if (input.files === "messages_only")
        return yield* writeRevert({
          sessionID: input.sessionID,
          messages: all,
          revert: { ...rev, status: "reverted", fileAction: "messages_only" },
        })
      const restored = yield* fileMutations.revert({ sessionID: input.sessionID, revert: rev })
      return yield* writeRevert({
        sessionID: input.sessionID,
        messages: all,
        revert: restored.conflicts.length
          ? {
              ...rev,
              status: "blocked",
              blockedReason: "conflict",
              conflicts: restored.conflicts,
              repair: repair ?? { status: "not_started", attempts: 0 },
            }
          : restored.mutations > 0
            ? { ...rev, status: "reverted", fileAction: "journal", ...(repair ? { repair } : {}) }
            : { ...rev, status: "blocked", blockedReason: "unattributed" },
      })
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.status === "reverted" && session.revert.fileAction === undefined)
        return yield* writeRevert({
          sessionID: input.sessionID,
          messages: yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
          revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
        })
      if (session.revert.status === "reverted" && session.revert.fileAction !== "messages_only") {
        const restored = yield* fileMutations.unrevert({ sessionID: input.sessionID, revert: session.revert })
        if (restored.mutations > 0) {
          if (restored.conflicts.length > 0) {
            return yield* writeRevert({
              sessionID: input.sessionID,
              messages: yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
              revert: {
                ...session.revert,
                status: "blocked",
                conflicts: restored.conflicts,
                repair: session.revert.repair ?? { status: "not_started", attempts: 0 },
              },
            })
          }
          const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const diffs = yield* summary.computeDiff({ messages: all })
          yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
          yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
          yield* sessions.setSummary({
            sessionID: input.sessionID,
            summary: {
              additions: diffs.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
              files: diffs.length,
            },
          })
          yield* sessions.clearRevert(input.sessionID)
          return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        }
        return yield* writeRevert({
          sessionID: input.sessionID,
          messages: yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
          revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
        })
      }
      if (session.revert.status !== "reverted" && session.revert.fileAction !== "messages_only") return session
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const diffs = yield* summary.computeDiff({ messages: all })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      if (session.revert.status !== "reverted" || !session.revert.fileAction) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as SessionV1.WithParts[]
      let target: SessionV1.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* events.publish(SessionEvent.Revert.Cleaned, {
        sessionID,
        timestamp: yield* DateTime.now,
        revert: session.revert,
      })
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionFileMutation.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Database.defaultLayer),
  ),
)

const sessionFileMutationNode = LayerNode.make(SessionFileMutation.layer, [
  ContentStore.node,
  Database.node,
  FSUtil.node,
])

export const node = LayerNode.make(layer, [
  Database.node,
  Session.node,
  sessionFileMutationNode,
  Storage.node,
  EventV2Bridge.node,
  SessionSummary.node,
  SessionRunState.node,
])

export * as SessionRevert from "./revert"
