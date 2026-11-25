export * as SessionAgentPolicyEvent from "./agent-policy-event"

import { EventV2 } from "../event"
import { V2Schema } from "../v2-schema"
import { SessionMessageID } from "./message-id"
import { SessionSchema } from "./schema"
import { SessionAgentPolicy } from "./agent-policy"

/** Rebinds a terminal native dispatch child's input binding to a new admitted
 * follow-up scope. The previous input binding is part of the event so replay
 * fails closed against a concurrent or reordered rebind. This leaf module keeps
 * the event and policy modules free of each other's import cycles. */
export const AgentPolicyRebound = EventV2.define({
  type: "session.agent_policy.rebound",
  sync: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionSchema.ID,
    timestamp: V2Schema.DateTimeUtcFromMillis,
    previousInputID: SessionMessageID.ID,
    agentPolicy: SessionAgentPolicy.Info,
  },
})
export type AgentPolicyRebound = typeof AgentPolicyRebound.Type
