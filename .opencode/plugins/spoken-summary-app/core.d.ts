import type { AppHostSessionContext, AppPluginApi } from "@opencode-ai/plugin/app"
export type SummarySettings = { summaryTarget: string; speechTarget: string; voice: string; voiceOverrides: Array<{ model: string; voice: string }>; speed: number; language: string; targetWords: number; cacheEnabled: boolean }
export const DEFAULTS: SummarySettings
export function settings(value?: Partial<SummarySettings>): SummarySettings
export function modelRequest(target: string, message: string): { model?: string; chain?: string }
export function summaryPrompt(context: AppHostSessionContext, config: SummarySettings): { system: string; prompt: string }
export function validateSummary(text: unknown, words: number): { ok: true; text: string } | { ok: false; reason: string }
export function createController(api: AppPluginApi, player: { unlock(): Promise<void>; decode(input: unknown, signal: AbortSignal): Promise<unknown>; playBuffer(input: unknown, signal: AbortSignal): Promise<void>; stop(): void; dispose?(): void }): unknown
