export * as LegacyDelegationRecord from "./record"

// Stored JSON shapes only, not executable policy or authorization.
export type WorkspaceMode = "mirror" | "shared"
export type Control = "active" | "draining" | "paused" | "retired"
export type TaskState =
  | "planned"
  | "waiting"
  | "reserved"
  | "snapshotting"
  | "starting"
  | "checking_cache"
  | "running"
  | "reviewing"
  | "integrating"
  | "done"
  | "blocked_cache"
  | "blocked_decision"
  | "paused"
  | "failed"
  | "cancelled"
export type Settings = {
  readonly interaction: boolean
  readonly workspaceMode: WorkspaceMode
  readonly maxWorkers: number
  readonly minCacheReadRatio: number
}
export type Result = {
  readonly activityID: string
  readonly messageID: string
  readonly messageSeq: number
  readonly messageDigest: string
  readonly summary: string
  readonly review: string
  readonly reviewedBy: "user" | "main"
  readonly time: number
}
