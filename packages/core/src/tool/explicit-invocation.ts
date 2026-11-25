export * as ExplicitInvocation from "./explicit-invocation"

import { createHash } from "node:crypto"
import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { Effect } from "effect"
import type { AgentV2 } from "../agent"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { PermissionV2 } from "../permission"
import type { SessionSchema } from "../session/schema"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "../session/sql"

export type Context = { readonly sessionID: SessionSchema.ID; readonly agent: AgentV2.ID }
export type Grant = Context & {
  readonly activityID: string
  readonly ownerID: string
  readonly inputID: string
  readonly command: string
  readonly promptDigest: string
  readonly tool: string
  readonly registration: number
}

/** Only a leading standalone slash command is an activation candidate, never a mention or quote. */
export function command(text: string) {
  return text.trimStart().match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/)?.[1]
}

// A user-shaped input is not proof of human authority (schedulers and dispatchers
// can admit one too). Always require single-use HOST consent before exposing the
// tool schema. The stored input is only a candidate and an immutable scope anchor.
export function make(db: Database.Interface["db"], permission: PermissionV2.Interface) {
  const decisions = new Map<string, { key: string; allowed: boolean }>()
  const mutex = KeyedMutex.makeUnsafe<string>()
  const current = Effect.fn("ExplicitInvocation.current")(function* (context: Context) {
    const session = yield* db
      .select({ agent: SessionTable.agent })
      .from(SessionTable)
      .where(eq(SessionTable.id, context.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session || (session.agent !== null && session.agent !== context.agent)) return
    const activity = yield* db
      .select()
      .from(SessionActivityTable)
      .where(
        and(
          eq(SessionActivityTable.session_id, context.sessionID),
          eq(SessionActivityTable.status, "running"),
          isNull(SessionActivityTable.closed_seq),
          gt(SessionActivityTable.lease_until, Date.now()),
        ),
      )
      .orderBy(desc(SessionActivityTable.opened_seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!activity?.owner_id || activity.opened_seq === null) return
    // Do not fall back to an earlier command when the newest user message is
    // empty, synthetic-looking, unadmitted, or no longer inside this activity.
    const user = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, context.sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!user || user.seq <= activity.opened_seq) return
    const input = yield* db
      .select({
        prompt: SessionInputTable.prompt,
        executionPrompt: SessionInputTable.execution_prompt,
        seq: SessionInputTable.promoted_seq,
      })
      .from(SessionInputTable)
      .where(and(eq(SessionInputTable.session_id, context.sessionID), eq(SessionInputTable.id, user.id)))
      .get()
      .pipe(Effect.orDie)
    if (!input || input.seq !== user.seq) return
    const text = (input.executionPrompt ?? input.prompt).text
    const invoked = command(text)
    if (!invoked) return
    return {
      activityID: activity.id,
      ownerID: activity.owner_id,
      inputID: user.id,
      command: invoked,
      promptDigest: createHash("sha256").update(text).digest("hex"),
    }
  })
  const valid = Effect.fn("ExplicitInvocation.valid")(function* (grant: Grant) {
    const now = yield* current(grant)
    return (
      now !== undefined &&
      now.activityID === grant.activityID &&
      now.ownerID === grant.ownerID &&
      now.inputID === grant.inputID &&
      now.command === grant.command &&
      now.promptDigest === grant.promptDigest
    )
  })
  const authorize = Effect.fn("ExplicitInvocation.authorize")(function* (
    context: Context,
    tool: string,
    required: ReadonlyArray<string>,
    registration: number,
  ) {
    const slot = JSON.stringify([context.sessionID, context.agent, tool, registration])
    return yield* mutex.withLock(slot)(
      Effect.gen(function* () {
        const input = yield* current(context)
        if (!input || !required.includes(input.command)) return
        const grant: Grant = { sessionID: context.sessionID, agent: context.agent, ...input, tool, registration }
        const key = JSON.stringify(grant)
        const previous = decisions.get(slot)
        if (previous?.key === key) return previous.allowed && (yield* valid(grant)) ? grant : undefined
        // Mark denied before waiting: cancellation must not cause an automatic
        // repeated prompt on the next provider request for the same invocation.
        decisions.set(slot, { key, allowed: false })
        const allowed = yield* permission
          .assert(
            PermissionV2.singleUse({
              sessionID: context.sessionID,
              agent: context.agent,
              action: tool,
              resources: [`explicit-invocation:/${input.command}`],
              metadata: {
                purpose:
                  "Expose this tool only for this explicit command in the current activity. This does not approve any tool operation, sending, or external writes.",
                command: `/${input.command}`,
                tool,
                inputID: input.inputID,
                activityID: input.activityID,
              },
            }),
          )
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
        if (!allowed || !(yield* valid(grant))) return
        decisions.set(slot, { key, allowed: true })
        return grant
      }),
    )
  })
  return { authorize, valid }
}
