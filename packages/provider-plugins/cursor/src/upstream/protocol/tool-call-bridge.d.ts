/**
 * Cursor's interaction_update.tool_call_* carries a typed ToolCall oneof
 * (shell_tool_call, update_todos_tool_call, mcp_tool_call, …). Some of those
 * never become ExecServerMessage requests — Cursor completes them display-only
 * — so OpenCode would never see a tool-call unless we bridge them here.
 */
export type DisplayToolCall = {
    callId: string;
    variant: string;
    /** Preferred OpenCode tool id before advertisement checks. */
    preferredToolName: string;
    args: Record<string, unknown>;
    /** False when the Cursor call cannot be represented safely in OpenCode. */
    bridgeable?: boolean;
};
export type BridgedOpenCodeToolCall = {
    toolName: string;
    args: Record<string, unknown>;
    callId: string;
    variant: string;
};
/**
 * Decode a Cursor ToolCall oneof into a display tool call we can bridge.
 */
export declare function parseDisplayToolCall(callId: string, toolCall: Record<string, unknown> | undefined): DisplayToolCall | undefined;
/**
 * Pick an advertised OpenCode tool for a display call, remapping args as needed.
 * Returns undefined when nothing compatible is advertised this turn.
 */
export declare function resolveBridgedOpenCodeToolCall(display: DisplayToolCall, advertised: Iterable<string>): BridgedOpenCodeToolCall | undefined;
/** Advertised OpenCode tool ids from Cursor McpToolDefinition descriptors. */
export declare function advertisedToolNamesFromDescriptors(descriptors: Array<Record<string, unknown>>): string[];
/** Walk a protobuf message and return top-level field numbers present. */
export declare function listProtobufFieldNumbers(buf: Uint8Array): number[];
/**
 * Extract nested bytes for path of field numbers (each must be wire type 2).
 * Returns undefined if any segment is missing.
 */
export declare function extractProtobufSubmessage(buf: Uint8Array, path: number[]): Uint8Array | undefined;
/**
 * Pull Cursor's tool_call_id out of a raw ExecServerMessage args variant so we
 * can correlate display tool_call_started with the authoritative exec path.
 */
export declare function extractExecDisplayCallId(execMsg: Record<string, unknown>): string | undefined;
