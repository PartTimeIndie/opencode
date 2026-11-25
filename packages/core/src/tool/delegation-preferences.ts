export * as DelegationPreferencesTool from "./delegation-preferences"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { DelegationPreferences } from "../session/delegation-preferences"
import { DelegationSettings } from "../session/delegation-settings"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "delegation_preferences"
export const Input = Schema.Struct({
  operation: Schema.Literals(["get", "patch"]),
  ...DelegationPreferences.Target.fields,
  expectedRevision: DelegationPreferences.ScopedPatch.fields.expectedRevision,
  expectedVersion: DelegationPreferences.ScopedPatch.fields.expectedVersion,
  patch: DelegationPreferences.Patch.pipe(Schema.optional),
})
export const Output = DelegationSettings.Snapshot

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const settings = yield* DelegationSettings.Service
  const permission = yield* PermissionV2.Service
  yield* tools.register({ [name]: Tool.make({
    description: "Read or patch saved delegation settings through the same owner as Settings. With no explicit scope, only this Session changes. Task needs an explicit owned taskID; project/global must be explicitly requested. Get the current revision/file version before patching; stale saves fail instead of retrying. Preferences advise, hard rules constrain, and neither grants tools, permissions or unconfigured models. No destination file can be chosen.",
    input: Input, output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
    execute: (input, context) => Effect.gen(function* () {
      const authorize: DelegationSettings.Authorize = (request) => permission.assert({
        sessionID: context.sessionID, agent: context.agent,
        action: name, resources: [`${request.scope}:${request.taskID ?? context.sessionID}`],
        metadata: { operation: request.operation, scope: request.scope, taskID: request.taskID },
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })
      const target = { scope: input.scope, taskID: input.taskID }
      if (input.operation === "get") {
        if (input.patch !== undefined || input.expectedRevision !== undefined || input.expectedVersion !== undefined)
          return yield* new ToolFailure({ message: "get does not accept mutation fields" })
        return yield* settings.get(context.sessionID, target, authorize)
      }
      if (input.patch === undefined) return yield* new ToolFailure({ message: "patch requires a concrete patch and the current revision/file version" })
      return yield* settings.patch(context.sessionID, { ...target,
        expectedRevision: input.expectedRevision, expectedVersion: input.expectedVersion, patch: input.patch }, authorize)
    }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }))),
  }) }).pipe(Effect.orDie)
}))
