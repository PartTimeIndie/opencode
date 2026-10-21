/**
 * Cursor model token pricing for OpenCode cost reporting.
 *
 * Rates come from Cursor's public docs (Other Models pool = provider API price).
 * Generated data lives in `pricing-data.ts`; regenerate with
 * `bun run generate:pricing`. Unknown / unpublished models get no `cost`.
 */
/** Classic OpenCode / models.dev cost shape used in provider config. */
export type OpenCodeModelCost = {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: OpenCodeModelCost;
};
/** OpenCode 2.0 `Model.Info.cost` entry (array of tiered rates). */
export type OpenCode2ModelCost = {
    tier?: {
        type: "context";
        size: number;
    };
    input: number;
    output: number;
    cache: {
        read: number;
        write: number;
    };
};
export type CursorPricingCoverage = {
    priced: string[];
    missing: string[];
};
/**
 * Models we expose that Cursor does not currently publish numeric rates for
 * on the Other Models table (Auto / first-party Cursor Models pool).
 */
export declare const CURSOR_UNPRICED_MODEL_IDS: readonly ["default", "composer-2.5", "grok-4.5", "grok-4.6"];
export declare function validateOpenCodeModelCost(value: unknown, path?: string): {
    valid: boolean;
    errors: string[];
};
export declare function isOpenCodeModelCost(value: unknown): value is OpenCodeModelCost;
/** Strip synthetic OpenCode long-context suffix (`…-1m`, `…-1m-2`, …). */
export declare function wireModelIdForPricing(modelId: string): {
    baseId: string;
    longContextEntry: boolean;
};
/**
 * Look up classic OpenCode cost for a catalog / wire model id.
 * Synthetic `-1m` entries retain both base and documented long-context rates.
 */
export declare function getCursorModelCost(modelId: string): OpenCodeModelCost | undefined;
export declare function applyCursorModelCost<T extends Record<string, unknown>>(modelId: string, entry: T): T & {
    cost?: OpenCodeModelCost;
};
/** Convert classic cost → OpenCode 2.0 `Model.Info.cost` array. */
export declare function toOpenCode2Costs(cost: OpenCodeModelCost | undefined): OpenCode2ModelCost[];
/**
 * Coverage helper for CI / maintainer checks.
 * Intentionally unpriced first-party ids are counted as priced (covered).
 */
export declare function checkCursorPricingCoverage(modelIds: string[]): CursorPricingCoverage;
