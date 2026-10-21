/** Whether `CURSOR_PROVIDER_DEBUG` is enabled for this process. */
export declare function isDebugEnabled(): boolean;
/** Resolve the debug log path (env override or per-uid tmpdir default). */
export declare function resolveDebugLogPath(): string;
/**
 * Ensure the log directory is 0o700 and create/truncate the log file as 0o600.
 * Exported for tests; callers normally go through `trace`.
 */
export declare function ensureSecureDebugLog(filePath: string, options?: {
    secureParent?: boolean;
}): void;
export declare function trace(msg: string): void;
/**
 * Compact path-advertising summary for RequestContext troubleshooting.
 * Safe: no tokens / file contents — only workspace vs metadata roots.
 */
export declare function traceRequestContextPaths(label: string, requestContext: Record<string, unknown> | undefined): void;
