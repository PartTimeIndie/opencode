import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventCheckpointTable, EventTable } from "@opencode-ai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload, SyncUpgradeRequiredError } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      if (ctx.payload.capability !== undefined && ctx.payload.capability !== EventV2.CheckpointCapability)
        return yield* new SyncUpgradeRequiredError({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_upgrade_required",
            message: `Checkpoint capability ${ctx.payload.capability} is unsupported. Upgrade to ${EventV2.CheckpointCapability}.`,
          },
        })
      const checkpoint =
        ctx.payload.capability === EventV2.CheckpointCapability && "checkpoint" in ctx.payload
          ? (ctx.payload.checkpoint as EventV2.SerializedCheckpoint)
          : undefined
      if (
        ctx.payload.events.some((event) => containsInlineDataUrl(event.data)) ||
        (checkpoint !== undefined && containsInlineDataUrl(checkpoint.baseline.data))
      )
        return yield* new SyncUpgradeRequiredError({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "content_externalization_required",
            message: "Sync replay contains inline data URLs. Externalize the content before replaying this history.",
          },
        })
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = checkpoint?.aggregateID ?? payload[0]?.aggregateID
      if (!source) return yield* Effect.die("Sync replay requires an aggregate")
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: checkpoint ? checkpoint.seq : payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      if (checkpoint) {
        yield* events.replayCheckpoint(
          {
            aggregateID: checkpoint.aggregateID,
            seq: checkpoint.seq,
            version: checkpoint.version,
            baseline: checkpoint.baseline,
            baselineHash: checkpoint.baselineHash,
            eventHash: checkpoint.eventHash,
            ...(checkpoint.compactedSeq === undefined ? {} : { compactedSeq: checkpoint.compactedSeq }),
            ...(checkpoint.compactedAt === undefined ? {} : { compactedAt: checkpoint.compactedAt }),
          },
          { ownerID, strictOwner: true },
        )
        if (payload.length > 0) yield* events.replayAll(payload, { ownerID, strictOwner: true })
      } else {
        yield* events.replayAll(payload, { ownerID, strictOwner: true })
      }
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: checkpoint ? checkpoint.seq : payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      if (
        "capability" in ctx.payload &&
        ctx.payload.capability !== EventV2.CheckpointCapability
      )
        return yield* new SyncUpgradeRequiredError({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_upgrade_required",
            message: `Checkpoint capability ${ctx.payload.capability} is unsupported. Upgrade to ${EventV2.CheckpointCapability}.`,
          },
        })
      const checkpointed =
        "capability" in ctx.payload && ctx.payload.capability === EventV2.CheckpointCapability && "cursors" in ctx.payload
      const cursors: Readonly<Record<string, number>> = checkpointed
        ? (ctx.payload as { readonly cursors: Readonly<Record<string, number>> }).cursors
        : (ctx.payload as Readonly<Record<string, number>>)
      const exclude = Object.entries(cursors)
      const checkpointRows = yield* db
        .select({ aggregateID: EventCheckpointTable.aggregate_id })
        .from(EventCheckpointTable)
        .all()
        .pipe(Effect.orDie)
      const storedCheckpoints = new Map(
        yield* Effect.forEach(checkpointRows, (row) =>
          events.checkpoint(row.aggregateID).pipe(Effect.map((checkpoint) => [row.aggregateID, checkpoint] as const)),
        ),
      )
      const compacted = Array.from(storedCheckpoints.values()).filter(
        (checkpoint): checkpoint is EventV2.SerializedCheckpoint | EventV2.LegacySerializedCheckpoint =>
          checkpoint?.compactedSeq !== undefined,
      )
      if (!checkpointed && compacted.length > 0)
        return yield* new SyncUpgradeRequiredError({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_capability_required",
            message: `This history contains compacted event prefixes. Upgrade the client to ${EventV2.CheckpointCapability} before syncing.`,
          },
        })
      if (checkpointed) {
        const legacy = compacted.find((checkpoint) => checkpoint.version === EventV2.LegacyCheckpointVersion)
        if (legacy)
          return yield* new SyncUpgradeRequiredError({
            name: "SyncUpgradeRequiredError",
            data: {
              requiredCapability: EventV2.CheckpointCapability,
              reason: "checkpoint_upgrade_required",
              message: `Aggregate ${legacy.aggregateID} still uses a legacy event-prefix checkpoint and must be upgraded before sync.`,
            },
          })
        const behind = compacted.find(
          (checkpoint) =>
            Object.hasOwn(cursors, checkpoint.aggregateID) &&
            cursors[checkpoint.aggregateID]! < checkpoint.compactedSeq!,
        )
        if (behind)
          return yield* new SyncUpgradeRequiredError({
            name: "SyncUpgradeRequiredError",
            data: {
              requiredCapability: EventV2.CheckpointCapability,
              reason: "checkpoint_reset_required",
              message: `Aggregate ${behind.aggregateID} is behind compacted sequence ${behind.compactedSeq}. Reset its local projection and request the checkpoint baseline again.`,
            },
          })
      }
      const checkpoints = checkpointed
        ? new Map(
            yield* Effect.forEach(
              Array.from(
                new Set([
                  ...storedCheckpoints.keys(),
                  ...(yield* db
                    .selectDistinct({ aggregateID: EventTable.aggregate_id })
                    .from(EventTable)
                    .all()
                    .pipe(
                      Effect.orDie,
                      Effect.map((rows) =>
                        rows
                          .map((row) => row.aggregateID)
                          .filter((aggregateID) => !Object.hasOwn(cursors, aggregateID)),
                      ),
                    )),
                ]),
              ),
              (aggregateID) => {
                if (Object.hasOwn(cursors, aggregateID))
                  return Effect.succeed([aggregateID, storedCheckpoints.get(aggregateID)] as const)
                const stored = storedCheckpoints.get(aggregateID)
                if (stored?.version === EventV2.CheckpointVersion)
                  return Effect.succeed([aggregateID, stored] as const)
                return events.createCheckpoint(aggregateID).pipe(
                  Effect.map((checkpoint) => [aggregateID, checkpoint] as const),
                )
              },
            ),
          )
        : storedCheckpoints
      const rows = yield* (checkpointed
        ? db
            .select({
              id: EventTable.id,
              aggregate_id: EventTable.aggregate_id,
              seq: EventTable.seq,
              type: EventTable.type,
              data: EventTable.data,
            })
            .from(EventTable)
            .leftJoin(EventCheckpointTable, eq(EventCheckpointTable.aggregate_id, EventTable.aggregate_id))
            .where(
              exclude.length === 0
                ? or(isNull(EventCheckpointTable.seq), gt(EventTable.seq, EventCheckpointTable.seq))
                : or(
                    ...exclude.map(([id, seq]) =>
                      and(eq(EventTable.aggregate_id, id), gt(EventTable.seq, seq)),
                    ),
                    and(
                      not(inArray(EventTable.aggregate_id, exclude.map(([id]) => id))),
                      or(isNull(EventCheckpointTable.seq), gt(EventTable.seq, EventCheckpointTable.seq)),
                    ),
                  ),
            )
            .orderBy(asc(EventTable.seq))
            .all()
        : db
            .select()
            .from(EventTable)
            .where(
              exclude.length > 0
                ? not(
                    or(
                      ...exclude.map(([id, seq]) =>
                        and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq)),
                      ),
                    )!,
                  )
                : undefined,
            )
            .orderBy(asc(EventTable.seq))
            .all())
        .pipe(Effect.orDie)
        .pipe(Effect.map((rows) => rows.map((event) => ({ ...event, data: EventV2.decodeStoredEventData(event.data) }))))
      if (!checkpointed) {
        if (rows.some((event) => containsInlineDataUrl(event.data)))
          return yield* new SyncUpgradeRequiredError({
            name: "SyncUpgradeRequiredError",
            data: {
              requiredCapability: EventV2.CheckpointCapability,
              reason: "content_externalization_required",
              message: "Sync history contains inline data URLs. Externalize the content before synchronizing it.",
            },
          })
        return rows
      }

      const grouped = Map.groupBy(rows, (event) => event.aggregate_id)
      const aggregates = Array.from(new Set([...grouped.keys(), ...checkpoints.keys()])).map((aggregateID) => {
        const cursorKnown = Object.hasOwn(cursors, aggregateID)
        const stored = cursorKnown ? undefined : checkpoints.get(aggregateID)
        const checkpoint = stored?.version === EventV2.CheckpointVersion ? stored : undefined
        return {
          aggregateID,
          ...(checkpoint ? { checkpoint } : {}),
          events: (grouped.get(aggregateID) ?? [])
            .filter((event) => event.seq > (cursorKnown ? cursors[aggregateID]! : (checkpoint?.seq ?? -1)))
            .map((event) => ({ ...event, aggregateID: event.aggregate_id })),
        }
      })
      if (
        aggregates.some(
          (aggregate) =>
            (aggregate.checkpoint !== undefined && containsInlineDataUrl(aggregate.checkpoint.baseline.data)) ||
            aggregate.events.some((event) => containsInlineDataUrl(event.data)),
        )
      )
        return yield* new SyncUpgradeRequiredError({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "content_externalization_required",
            message: "Sync history contains inline data URLs. Externalize the content before synchronizing it.",
          },
        })
      return { capability: EventV2.CheckpointCapability, aggregates }
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)

function containsInlineDataUrl(value: unknown): boolean {
  if (typeof value === "string") return value.trimStart().toLowerCase().startsWith("data:")
  if (Array.isArray(value)) return value.some(containsInlineDataUrl)
  if (value === null || typeof value !== "object") return false
  return Object.values(value).some(containsInlineDataUrl)
}
