export * as SessionRunner from "./index"

import type { LLMError } from "@opencode-ai/llm"
import { Context, Effect, Schema } from "effect"
import { EventV2 } from "../../event"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import type { SummaryFailed } from "../compaction"
import { ModelV2 } from "../../model"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { SessionContextEpoch } from "../context-epoch"
import type { ToolOutputStore } from "../../tool-output-store"
import type { ContentStore } from "../../content-store"
import type { LegacyDelegationGuard } from "../legacy-delegation/guard"
import type { WorkspaceCheckout } from "../workspace/checkout"

export class StepLimitExceededError extends Schema.TaggedErrorClass<StepLimitExceededError>()(
  "SessionRunner.StepLimitExceededError",
  {
    sessionID: SessionSchema.ID,
    limit: Schema.Int,
  },
) {}

/** The user rejected a blocking Surface or permission, so the current activity must stop cleanly. */
export class UserDeclinedError extends Schema.TaggedErrorClass<UserDeclinedError>()(
  "SessionRunner.UserDeclinedError",
  {},
) {}

/** A provider interrupted itself while the runner owner is still alive. */
export class ProviderInterruptedError extends Schema.TaggedErrorClass<ProviderInterruptedError>()(
  "SessionRunner.ProviderInterruptedError",
  {},
) {}

export type RunError =
  | LLMError
  | SummaryFailed
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | StepLimitExceededError
  | UserDeclinedError
  | ProviderInterruptedError
  | SystemContext.InitializationBlocked
  | SessionContextEpoch.AgentReplacementBlocked
  | ToolOutputStore.Error
  | ContentStore.Error
  | LegacyDelegationGuard.Blocked
  | WorkspaceCheckout.Blocked

/** Process-local settlement for every runner invocation, including foreground child sessions. */
export const Settled = EventV2.define({
  type: "session.runner.settled",
  schema: {
    sessionID: SessionSchema.ID,
    status: Schema.Literals(["completed", "error", "interrupted"]),
  },
})

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force?: boolean
  }) => Effect.Effect<void, RunError>
  /** Checks whether the selected model needs a durable history checkpoint before switching. */
  readonly requiresModelSwitchCompaction: (input: {
    readonly sessionID: SessionSchema.ID
    readonly model: ModelV2.Ref
  }) => Effect.Effect<boolean, MessageDecodeError>
  /** Compacts history for the selected model, requesting approval for a larger-context summarizer if needed. */
  readonly prepareModelSwitch: (input: {
    readonly sessionID: SessionSchema.ID
    readonly model: ModelV2.Ref
  }) => Effect.Effect<boolean, SummaryFailed | MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunner") {}
