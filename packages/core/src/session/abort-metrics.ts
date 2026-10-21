export * as SessionAbortMetrics from "./abort-metrics"

import { SessionFailure } from "./failure"

/**
 * Standing defect-abort metrics (E7). User-stop and owner-shutdown are
 * excluded so the gate measures preventable/provider defects, not intentional
 * interrupts. Target: defect-abort rate ≤ 10% over a documented window.
 */
export const TARGET_DEFECT_RATE = 0.1
export const BASELINE = {
  sessions: 319,
  interrupted: 134,
  failed: 49,
} as const

const excluded = new Set<SessionFailure.Code>(["user.stop", "owner.shutdown"])

export function isDefectAbort(code: SessionFailure.Code): boolean {
  return !excluded.has(code)
}

export function defectRate(codes: readonly SessionFailure.Code[]): number {
  if (codes.length === 0) return 0
  return codes.filter(isDefectAbort).length / codes.length
}

export function meetsTarget(codes: readonly SessionFailure.Code[]): boolean {
  return defectRate(codes) <= TARGET_DEFECT_RATE
}
