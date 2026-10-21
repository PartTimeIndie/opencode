import { Database } from "bun:sqlite"
import fs from "node:fs"

type Row = {
  id: string
  title: string
  directory: string
  time_updated: number
  tokens_input: number
  tokens_cache_read: number
  tokens_cache_write: number
  activities?: number
  running_activities?: number
  stale_activities?: number
  recovering_activities?: number
  latest_activity_at?: number
  activity_statuses?: string
  background_jobs?: number
  running_jobs?: number
  stale_jobs?: number
  tool_status?: string
  context_tokens: number | null
  waiting_questions: number
}

export function sessionHealth(
  db: Database,
  options: { now?: number; hours?: number; limit?: number; all?: boolean } = {},
) {
  const now = options.now ?? Date.now()
  const hours = options.hours ?? 168
  const limit = options.limit ?? 20
  const hasTable = (name: string) =>
    db
      .query<{ name: string }, [string]>("select name from sqlite_master where type = 'table' and name = ?")
      .get(name) !== null

  const sessionActivity = hasTable("session_activity")
  const backgroundJob = hasTable("background_job")
  const sessionMessage = hasTable("session_message")
  const question =
    hasTable("session_question") &&
    db
      .query<{ name: string }, []>("pragma table_info(session_question)")
      .all()
      .some((column) => column.name === "mode")
  const cutoff = now - (Number.isFinite(hours) && hours > 0 ? hours : 168) * 60 * 60 * 1000
  const rows = db
    .query<Row, { $now: number; $all: number; $cutoff: number; $limit: number }>(
      `
    select
      s.id,
      s.title,
      s.directory,
      s.time_updated,
      s.tokens_input,
      s.tokens_cache_read,
      s.tokens_cache_write,
      ${
        sessionMessage
          ? `(select
        coalesce(json_extract(m.data, '$.tokens.input'), 0)
        + coalesce(json_extract(m.data, '$.tokens.cache.read'), 0)
        + coalesce(json_extract(m.data, '$.tokens.cache.write'), 0)
        from session_message m
        where m.session_id = s.id and m.type = 'assistant'
          and json_valid(m.data) and json_type(m.data, '$.tokens') = 'object'
        order by m.seq desc limit 1)`
          : "null"
      } as context_tokens,
      ${
        question
          ? `(select count(*) from session_question q
        where q.session_id = s.id and q.state = 'active' and q.mode = 'blocking')`
          : "0"
      } as waiting_questions
      ${
        sessionActivity
          ? `,
      coalesce(a.activities, 0) as activities,
      coalesce(a.running_activities, 0) as running_activities,
      coalesce(a.stale_activities, 0) as stale_activities,
      coalesce(a.recovering_activities, 0) as recovering_activities,
      a.latest_activity_at,
      a.activity_statuses`
          : ""
      }
      ${
        backgroundJob
          ? `,
      coalesce(b.background_jobs, 0) as background_jobs,
      coalesce(b.running_jobs, 0) as running_jobs,
      coalesce(b.stale_jobs, 0) as stale_jobs,
      b.tool_status`
          : ""
      }
    from session s
    ${
      sessionActivity
        ? `left join (
      select
        session_id,
        sum(count) as activities,
        sum(live) as running_activities,
        sum(stale) as stale_activities,
        sum(case when status = 'recovering' then live else 0 end) as recovering_activities,
        max(coalesce(heartbeat_at, time_updated, time_created)) as latest_activity_at,
        group_concat(status || ':' || count, ', ') as activity_statuses
      from (
        select session_id, status, count(*) as count,
          sum(case when status in ('running', 'recovering') and coalesce(lease_until, 0) > $now then 1 else 0 end) as live,
          sum(case when status in ('running', 'recovering') and coalesce(lease_until, 0) <= $now then 1 else 0 end) as stale,
          max(heartbeat_at) as heartbeat_at, max(time_updated) as time_updated, max(time_created) as time_created
        from session_activity
        group by session_id, status
      )
      group by session_id
    ) a on a.session_id = s.id`
        : ""
    }
    ${
      backgroundJob
        ? `left join (
      select
        session_id,
        sum(count) as background_jobs,
        sum(live) as running_jobs,
        sum(stale) as stale_jobs,
        group_concat(type || ':' || status || ':' || count, ', ') as tool_status
      from (
        select session_id, type, status, count(*) as count,
          sum(case when status = 'running' and coalesce(lease_until, 0) > $now then 1 else 0 end) as live,
          sum(case when status = 'running' and coalesce(lease_until, 0) <= $now then 1 else 0 end) as stale
        from (
          select parent_session_id as session_id, type, status, lease_until from background_job where parent_session_id is not null
          union all
          select child_session_id as session_id, type, status, lease_until from background_job
          where child_session_id is not null and (parent_session_id is null or child_session_id != parent_session_id)
        )
        group by session_id, type, status
      )
      group by session_id
    ) b on b.session_id = s.id`
        : ""
    }
    where $all = 1
      or s.time_updated >= $cutoff
      ${sessionActivity ? "or coalesce(a.running_activities, 0) > 0" : ""}
      ${backgroundJob ? "or coalesce(b.running_jobs, 0) > 0" : ""}
    order by context_tokens desc, s.time_updated desc
    limit $limit
  `,
    )
    .all({
      $now: now,
      $all: options.all ? 1 : 0,
      $cutoff: cutoff,
      $limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20,
    })

  return rows.map((row) => ({
    title: row.title,
    id: row.id,
    running: row.waiting_questions === 0 && ((row.running_activities ?? 0) > 0 || (row.running_jobs ?? 0) > 0),
    waiting_for_user: row.waiting_questions > 0,
    context_estimate_tokens: row.context_tokens,
    context_estimate_source: row.context_tokens === null ? "unavailable" : "latest recorded assistant input usage",
    lifetime_input_tokens: row.tokens_input + row.tokens_cache_read + row.tokens_cache_write,
    lifetime_cache_read_tokens: row.tokens_cache_read,
    last_activity: new Date(row.latest_activity_at ?? row.time_updated).toISOString(),
    activities: sessionActivity
      ? {
          total: row.activities ?? 0,
          running: row.running_activities ?? 0,
          recovering: row.recovering_activities ?? 0,
          stale: row.stale_activities ?? 0,
          statuses: row.activity_statuses ?? "none",
        }
      : "n/a: session_activity table missing",
    tool_status: backgroundJob ? (row.tool_status ?? "none") : "n/a: background_job table missing",
    jobs: backgroundJob
      ? { total: row.background_jobs ?? 0, running: row.running_jobs ?? 0, stale: row.stale_jobs ?? 0 }
      : "n/a: background_job table missing",
    runners: sessionActivity
      ? `${row.running_activities ?? 0} activity row(s) with unexpired leases; live in-process runner map is not enumerable from SQLite`
      : "n/a: session_activity table missing",
    directory: row.directory,
  }))
}

if (import.meta.main) {
  const { path } = await import("@opencode-ai/core/database/database")
  const args = new Set(process.argv.slice(2))
  const hours = Number(process.argv.find((arg) => arg.startsWith("--hours="))?.slice("--hours=".length) ?? 168)
  const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length) ?? 20)
  const dbPath = path()
  using db = new Database(dbPath, { readonly: true })
  const dbBytes = fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`)
  const output = sessionHealth(db, { hours, limit, all: args.has("--all") })
  if (args.has("--json"))
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          db_size: formatBytes(dbBytes),
          active_window_hours: args.has("--all") ? "all" : hours,
          sessions: output,
        },
        null,
        2,
      ),
    )
  else {
    console.log(`Database: ${dbPath}`)
    console.log(`DB size: ${formatBytes(dbBytes)} (${dbBytes} bytes including WAL/SHM when present)`)
    console.table(output)
  }
}

function fileBytes(path: string) {
  try {
    return fs.statSync(path).size
  } catch {
    return 0
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}
