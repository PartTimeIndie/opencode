import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { CreateCursorOptions, CursorRetryOptions } from "./index.js";
import { type OpencodeToolDef } from "./protocol/tools.js";
import { cursorContextUsageMetadata, type CursorContextUsageSource, type CursorConversationTokenDetails } from "./protocol/token-details.js";
import { type ConversationBlobGraphStats } from "./protocol/blob-store.js";
import { type CursorSession } from "./session.js";
import { CursorProviderError } from "./errors.js";
import type { SeedHistoryMessage } from "./protocol/request.js";
export declare const MAX_TURN_STATE_SESSIONS = 256;
/** Cursor's own conversation export path treats state above 100 MiB as large. */
export declare const MAX_CHECKPOINT_BLOB_GRAPH_BYTES: number;
export declare function checkpointBlobGraphRequiresRebase(stats: ConversationBlobGraphStats, maxBytes?: number): boolean;
export type CursorRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};
export declare function resolveRetryPolicy(options: CursorRetryOptions | undefined): CursorRetryPolicy;
export declare function connectFrameError(payload: string): CursorProviderError;
/** Restore the last real catalog solely for lifecycle turns such as compaction. */
export declare function restoreTurnToolCatalog(sessionKey: string, tools: OpencodeToolDef[]): void;
type V3Part = LanguageModelV3StreamPart;
export declare function createCursorLanguageModel(modelId: string, providerId: string, options: CreateCursorOptions): LanguageModelV3;
export declare function pumpWithRecovery(input: {
    initialSession: CursorSession;
    controller: ReadableStreamDefaultController<V3Part>;
    abortSignal?: AbortSignal;
    retryPolicy?: CursorRetryPolicy;
    recover: (recovery: CursorRunRecovery) => Promise<CursorSession>;
    onSession?: (session: CursorSession) => void;
    maxRecoveries?: number;
}): Promise<CursorSession>;
export type CursorRunRecovery = {
    kind: "rebase";
} | {
    kind: "resume";
    conversationId: string;
    checkpoint: Uint8Array;
};
/**
 * OpenCode re-sends the full tool-result history on every continuation. Prefer
 * the newest result that still has a live pending exec on its tagged session.
 */
export declare function findContinuationSession(toolResults: Array<{
    sessionId: string;
    execId: number;
}>): CursorSession | undefined;
/**
 * Deliver trailing tool results onto a live continuation session.
 * Returns the same session when writes succeed (or only bridged results were
 * cleared). Returns undefined after closing the session when a write fails, so
 * the caller can rebase onto a fresh Run instead of pumping a dead stream.
 */
export declare function deliverContinuationResults(session: CursorSession, trailingToolResults: ExtractedToolResult[]): CursorSession | undefined;
/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended → finish "stop" and close the session;
 *  - transport EOF before turn_ended → throw for one fresh-Run recovery.
 */
export declare function pump(session: CursorSession, controller: ReadableStreamDefaultController<V3Part>, ids: {
    textId: string;
    reasoningId: string;
}, abortSignal?: AbortSignal): Promise<void>;
type ExtractedToolResult = {
    toolCallId: string;
    sessionId: string;
    execId: number;
    toolName: string;
    output: string;
    error?: string;
};
/**
 * Tool results that form a live continuation: only the trailing run of `tool`
 * messages after the last non-tool message. Mid-prompt historical tool results
 * are ignored — they are conversation history, not replies for a held-open Run.
 */
export declare function extractTrailingToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[];
/**
 * Cursor's native UI interactions cannot be surfaced through the AI SDK.
 * Redirect only to OpenCode tools that are genuinely advertised this turn;
 * compaction keeps its dedicated summary prompt unchanged.
 */
export declare function buildOpenCodeInteractionGuidance(tools: OpencodeToolDef[], isCompaction: boolean, workspaceRoot: string): string | undefined;
/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export declare function estimateTokens(chars: number): number;
/** Preserve exact request-local Cursor counters as diagnostics. */
export declare function cursorTurnEndedProviderMetadata(te: Record<string, unknown>, tokenDetails?: CursorConversationTokenDetails, contextSource?: CursorContextUsageSource): {
    cursor: {
        usageVersion: number;
        inputTokensRaw: number;
        outputTokensRaw: number;
        cacheReadRaw: number;
        cacheWriteRaw: number;
        reasoningTokensRaw: number;
        context?: ReturnType<typeof cursorContextUsageMetadata>;
    };
};
/**
 * Prior prompt turns for a seed ConversationStateStructure. Tool results must
 * never be replayed as assistant-authored prose: that teaches the model to
 * counterfeit `Tool result (...)` text instead of emitting a real tool call.
 * Normal rebases omit old results; compaction can retain all results and
 * interrupted continuations retain only the trailing live result suffix as
 * explicit OpenCode-host observations.
 */
export declare function extractPromptHistory(prompt: LanguageModelV3CallOptions["prompt"], options?: {
    preserveTrailingUser?: boolean;
    toolResults?: "omit" | "all" | "trailing";
}): SeedHistoryMessage[];
/** OpenCode session id header, if present. */
export declare function opencodeSessionKey(callOptions: LanguageModelV3CallOptions): string | undefined;
/**
 * Map OpenCode's session id header to the active Cursor conversation_id.
 * Compaction resets remint via bindConversationId; otherwise the binding is
 * sticky for the OpenCode session. Falls back to a random UUID with no header.
 */
export declare function resolveConversationId(callOptions: LanguageModelV3CallOptions): string;
export { sessionIdToUuid } from "./protocol/conversation-bind.js";
/** Exported for tests — AI SDK V3 span ends that must precede finish / tool-call. */
export declare function spanEndParts(opts: {
    textStarted: boolean;
    reasoningStarted: boolean;
    textId: string;
    reasoningId: string;
}): Array<{
    type: "text-end" | "reasoning-end";
    id: string;
}>;
/** Exported for tests — false for compaction/summary (no tools) and toolChoice none. */
export declare function computeAllowTools(toolCount: number, toolChoice: LanguageModelV3CallOptions["toolChoice"] | undefined): boolean;
export declare function resolveTurnToolState(input: {
    sessionKey?: string;
    incomingTools: OpencodeToolDef[];
    toolChoice?: LanguageModelV3CallOptions["toolChoice"];
    isCompaction: boolean;
    abortSignal?: AbortSignal;
}): Promise<{
    advertisedTools: OpencodeToolDef[];
    allowTools: boolean;
}>;
export declare function resolveTurnConversationReset(input: {
    sessionKey?: string;
    isCompaction: boolean;
}): {
    reset: boolean;
    reason?: "compaction" | "post-compaction-rebase";
};
export declare function resetTurnStateForTests(): void;
