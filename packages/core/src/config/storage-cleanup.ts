export * as ConfigStorageCleanup from "./storage-cleanup"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30
export const DEFAULT_COMPACTION_BACKUP_RETENTION_DAYS = 60
export const DEFAULT_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024 * 1024
export const MIN_CHECK_INTERVAL_HOURS = 24
export const DEFAULT_CHECK_INTERVAL_HOURS = MIN_CHECK_INTERVAL_HOURS

const CheckIntervalHours = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_CHECK_INTERVAL_HOURS))

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically delete expired storage artifacts (default: true)",
  }),
  snapshot_retention_days: Schema.optional(PositiveInt).annotate({
    description: "Days since last snapshot use before its repository can be deleted (default: 30)",
  }),
  compaction_backup_retention_days: Schema.optional(PositiveInt).annotate({
    description: "Days to retain completed event-compaction rollback backups (default: 60)",
  }),
  snapshot_max_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum combined snapshot repository size in bytes (default: 10737418240)",
  }),
  check_interval_hours: Schema.optional(CheckIntervalHours).annotate({
    description: "Minimum hours between successful automatic cleanup runs (minimum/default: 24)",
  }),
})

export type Info = typeof Info.Type

export type Resolved = {
  readonly enabled: boolean
  readonly snapshotRetentionDays: number
  readonly compactionBackupRetentionDays: number
  readonly snapshotMaxBytes: number
  readonly checkIntervalHours: number
}

export function resolve(info?: Info): Resolved {
  return {
    enabled: info?.enabled ?? true,
    snapshotRetentionDays: info?.snapshot_retention_days ?? DEFAULT_SNAPSHOT_RETENTION_DAYS,
    compactionBackupRetentionDays:
      info?.compaction_backup_retention_days ?? DEFAULT_COMPACTION_BACKUP_RETENTION_DAYS,
    snapshotMaxBytes: info?.snapshot_max_bytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
    checkIntervalHours: Math.max(info?.check_interval_hours ?? DEFAULT_CHECK_INTERVAL_HOURS, MIN_CHECK_INTERVAL_HOURS),
  }
}
