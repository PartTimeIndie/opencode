import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLayout } from "@/context/layout"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { buildSummary, parseModelLimit, rangeStartForDays, applyLimit, type UsageBucket, type UsageRow } from "./usage-dashboard-model"

type RangeKey = "7d" | "30d" | "90d" | "365d" | "all"

const ranges: { key: RangeKey; label: string; days?: number }[] = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "365d", label: "1 year", days: 365 },
  { key: "all", label: "All loaded" },
]

const pageLimit = 500
const maxPages = 10
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 })

export function UsageDashboard() {
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [store, setStore] = createStore({
    range: "30d" as RangeKey,
    modelLimit: 8 as number | "all",
    loading: false,
    error: undefined as string | undefined,
    sessions: [] as GlobalSession[],
    complete: true,
    pages: 0,
    refreshedAt: undefined as number | undefined,
  })
  let loadRun = 0
  let loadedSdk: ServerSDK | undefined

  const selectedRange = () => ranges.find((item) => item.key === store.range) ?? ranges[1]!
  const rangeStart = () => (selectedRange().days === undefined ? undefined : rangeStartForDays(selectedRange().days!))

  createEffect(() => {
    const sdk = serverSDK()
    const key = store.range
    loadRun += 1
    void loadSessions(sdk, key, loadRun)
  })

  onCleanup(() => {
    loadRun += 1
  })

  const activeSessions = createMemo(() => {
    const fetchedBySession = new Map(store.sessions.map((session) => [`${pathKey(session.directory)}\n${session.id}`, session]))
    const directories = new Set([
      ...store.sessions.map((session) => session.directory),
      ...layout.projects.list().flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])]),
    ])
    return [...directories].flatMap((directory) => {
      const existing = serverSync().existing(directory)?.[0]
      if (!existing) return []
      return Object.entries(existing.session_status).flatMap(([sessionID, status]) => {
        if (!status || status.type === "idle") return []
        const session = fetchedBySession.get(`${pathKey(directory)}\n${sessionID}`) ?? existing.session.find((item) => item.id === sessionID)
        return [
          {
            id: sessionID,
            directory,
            status: status.type,
            agent: session?.agent ?? "default",
            title: session?.title ?? sessionID,
          },
        ]
      })
    })
  })

  const summary = createMemo(() => buildSummary(store.sessions, selectedRange(), rangeStart(), activeSessions()))

  const refresh = () => {
    loadRun += 1
    void loadSessions(serverSDK(), store.range, loadRun)
  }

  async function loadSessions(sdk: ServerSDK, range: RangeKey, run: number) {
    setStore("loading", true)
    setStore("error", undefined)

    const start = ranges.find((item) => item.key === range)?.days
    const since = start === undefined ? undefined : rangeStartForDays(start)
    const sessions: GlobalSession[] = []
    let cursor: string | undefined
    let complete = false
    let pages = 0

    try {
      for (let page = 0; page < maxPages; page++) {
        const response = await sdk.client.experimental.session.list({
          archived: true,
          includeHidden: true,
          limit: pageLimit,
          ...(since === undefined ? {} : { start: since }),
          ...(cursor === undefined ? {} : { cursor }),
        })
        pages = page + 1
        sessions.push(...(response.data ?? []))

        const next = response.response.headers.get("x-next-cursor")
        if (!next) {
          complete = true
          break
        }
        cursor = next
      }
    } catch (error) {
      if (run !== loadRun) return
      setStore("loading", false)
      setStore("error", error instanceof Error ? error.message : "Could not load usage data")
      // Keep the last successful data for transient failures on the same
      // server; only drop rows when the failing request came from a different
      // server than the data currently shown, so foreign server sessions are
      // never displayed with an error note only.
      if (loadedSdk !== sdk) {
        setStore("sessions", reconcile([]))
        setStore("complete", true)
        setStore("pages", 0)
        setStore("refreshedAt", undefined)
      }
      return
    }

    if (run !== loadRun) return
    loadedSdk = sdk
    setStore("sessions", reconcile(sessions))
    setStore("complete", complete)
    setStore("pages", pages)
    setStore("refreshedAt", Date.now())
    setStore("loading", false)
  }

  return (
    <div data-component="usage-dashboard" class="size-full min-h-0 overflow-auto bg-background-base">
      <div class="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 p-3 md:p-4">
        <header data-slot="usage-header" class="flex flex-col gap-3 rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
          <div class="min-w-0">
            <h2 class="text-20-medium text-text-strong">Usage Dashboard</h2>
            <p class="mt-1 text-12-regular leading-relaxed text-text-weak">
              App-wide session usage from the experimental global session API. Daily totals are grouped by session last update.
            </p>
          </div>
          <div data-slot="usage-controls" class="flex shrink-0 items-center gap-2">
            <select
              data-slot="usage-range-select"
              value={store.range}
              onInput={(event) => setStore("range", event.currentTarget.value as RangeKey)}
            >
              <For each={ranges}>{(item) => <option value={item.key}>{item.label}</option>}</For>
            </select>
            <button
              type="button"
              class="rounded-md border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-hover-base disabled:opacity-60"
              disabled={store.loading}
              onClick={refresh}
            >
              Refresh
            </button>
          </div>
        </header>

        <Show when={store.error}>
          <div class="rounded-lg border border-border-critical-base bg-surface-critical-weak p-3 text-14-regular text-text-on-critical-base">
            {store.error}
          </div>
        </Show>

        <div data-slot="usage-metrics" class="grid gap-3">
          <MetricCard label="Tokens" value={formatNumber(summary().totalTokens)} detail="input, output, reasoning, cache" />
          <MetricCard label="Cost" value={formatCurrency(summary().totalCost)} detail="stored provider cost" />
          <MetricCard label="Sessions" value={formatNumber(summary().sessionCount)} detail={`${summary().projectCount} projects`} />
          <MetricCard label="Active Agents" value={formatNumber(summary().activeSessionCount)} detail="from loaded session stores" />
        </div>

        <div data-slot="usage-chart-grid" class="grid min-h-0 gap-3">
          <ChartCard title="Daily Tokens" detail={`${selectedRange().label}, ${summary().daily.length} buckets`}>
            <Switch>
              <Match when={summary().hasDailyUsage}>
                <DailyTokenChart buckets={summary().daily} />
              </Match>
              <Match when={true}>
                <EmptyState>No sessions with usage in this range.</EmptyState>
              </Match>
            </Switch>
          </ChartCard>

          <ChartCard title="Agents" detail={`${summary().agents.length} used, active status approximate`}>
            <Switch>
              <Match when={summary().agents.length > 0}>
                <AgentUsageChart agents={summary().agents.slice(0, 8)} />
              </Match>
              <Match when={true}>
                <EmptyState>No agent usage found.</EmptyState>
              </Match>
            </Switch>
          </ChartCard>
        </div>

        <div data-slot="usage-table-grid" class="grid gap-3">
          <UsageTable title="Agent Breakdown" rows={summary().agents} showActive />
          <UsageTable
            title="Model Breakdown"
            rows={summary().models}
            limit={store.modelLimit}
            onLimitChange={(limit) => setStore("modelLimit", limit)}
          />
        </div>

        <div data-slot="usage-table-grid" class="grid gap-3">
          <UsageTable title="Project Breakdown" rows={summary().projects} />
          <section class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
            <h3 class="text-14-medium text-text-strong">Data Notes</h3>
            <div class="mt-3 space-y-2 text-12-regular leading-relaxed text-text-weak">
              <p>
                Loaded {formatNumber(store.sessions.length)} sessions across {store.pages} page{store.pages === 1 ? "" : "s"}.
                {" "}
                {store.complete ? "The API returned no additional page for this range." : `More sessions exist beyond the ${formatNumber(pageLimit * maxPages)} loaded limit.`}
              </p>
              <Show when={store.pages > 1}>
                <p>Multi-page totals can shift if sessions are updated while the dashboard is loading.</p>
              </Show>
              <p>
                Archived and hidden sessions are included. Usage is aggregated from session-level totals, so work spanning several days is counted on the session's latest update day.
              </p>
              <Show when={store.refreshedAt}>
                <p>Last refreshed {new Date(store.refreshedAt!).toLocaleTimeString()}.</p>
              </Show>
            </div>
          </section>
        </div>

        <Show when={store.loading}>
          <div data-slot="usage-loading" class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3 text-12-medium text-text-weak">
            Loading usage data...
          </div>
        </Show>
      </div>
    </div>
  )
}

function formatNumber(value: number) {
  if (Math.abs(value) >= 1_000_000) return compact.format(value)
  return number.format(value)
}

function formatCurrency(value: number) {
  return currency.format(value)
}

function MetricCard(props: { label: string; value: string; detail: string }) {
  return (
    <section data-slot="usage-metric-card" class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="text-12-medium uppercase tracking-wide text-text-weak">{props.label}</div>
      <div class="mt-2 text-20-medium text-text-strong">{props.value}</div>
      <div class="mt-1 text-12-regular text-text-weak">{props.detail}</div>
    </section>
  )
}

function ChartCard(props: { title: string; detail: string; children: JSX.Element }) {
  return (
    <section data-slot="usage-chart-card" class="min-w-0 rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-14-medium text-text-strong">{props.title}</h3>
        <span class="text-12-regular text-text-weak">{props.detail}</span>
      </div>
      <div class="mt-3 min-h-48">{props.children}</div>
    </section>
  )
}

function DailyTokenChart(props: { buckets: UsageBucket[] }) {
  const width = 720
  const height = 220
  const top = 18
  const bottom = 34
  const left = 46
  const right = 16
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const max = createMemo(() => Math.max(1, ...props.buckets.map((bucket) => bucket.tokens)))
  const bars = createMemo(() =>
    props.buckets.map((bucket, index) => {
      const slot = plotWidth / props.buckets.length
      const barWidth = Math.max(1, slot * 0.68)
      const barHeight = (bucket.tokens / max()) * plotHeight
      return {
        ...bucket,
        x: left + index * slot + (slot - barWidth) / 2,
        y: top + plotHeight - barHeight,
        width: barWidth,
        height: barHeight,
      }
    }),
  )

  return (
    <svg data-slot="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily token usage chart">
      <line x1={left} y1={top + plotHeight} x2={width - right} y2={top + plotHeight} class="usage-chart-axis" />
      <line x1={left} y1={top} x2={left} y2={top + plotHeight} class="usage-chart-axis" />
      <text x="4" y={top + 8} class="usage-chart-label">{formatNumber(max())}</text>
      <For each={bars()}>
        {(bar) => (
          <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx="3" class="usage-chart-bar">
            <title>{`${bar.label}: ${formatNumber(bar.tokens)} tokens, ${formatCurrency(bar.cost)}, ${bar.sessions} sessions`}</title>
          </rect>
        )}
      </For>
      <Show when={props.buckets[0]}>
        <text x={left} y={height - 8} class="usage-chart-label">{props.buckets[0]!.label}</text>
      </Show>
      <Show when={props.buckets[props.buckets.length - 1]}>
        <text x={width - right} y={height - 8} text-anchor="end" class="usage-chart-label">
          {props.buckets[props.buckets.length - 1]!.label}
        </text>
      </Show>
    </svg>
  )
}

function AgentUsageChart(props: { agents: UsageRow[] }) {
  const width = 520
  const rowHeight = 28
  const left = 128
  const right = 72
  const height = createMemo(() => Math.max(120, 20 + props.agents.length * rowHeight))
  const max = createMemo(() => Math.max(1, ...props.agents.map((agent) => agent.tokens)))
  return (
    <svg data-slot="usage-chart" viewBox={`0 0 ${width} ${height()}`} role="img" aria-label="Agent token usage chart">
      <For each={props.agents}>
        {(agent, index) => {
          const y = 18 + index() * rowHeight
          const barWidth = ((width - left - right) * agent.tokens) / max()
          return (
            <>
              <text x="0" y={y + 12} class="usage-chart-label">{agent.name}</text>
              <rect x={left} y={y} width={barWidth} height="16" rx="4" class="usage-chart-bar" data-active={agent.active}>
                <title>{`${agent.name}: ${formatNumber(agent.tokens)} tokens, ${formatCurrency(agent.cost)}`}</title>
              </rect>
              <text x={width} y={y + 12} text-anchor="end" class="usage-chart-label">{formatNumber(agent.tokens)}</text>
            </>
          )
        }}
      </For>
    </svg>
  )
}

function UsageTable(props: {
  title: string
  rows: UsageRow[]
  showActive?: boolean
  limit?: number | "all"
  onLimitChange?: (limit: number | "all") => void
}) {
  const shown = () => applyLimit(props.rows, props.limit ?? 8)
  return (
    <section class="min-w-0 rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-14-medium text-text-strong">{props.title}</h3>
        <Show
          when={props.onLimitChange}
          fallback={<span class="text-12-regular text-text-weak">Top {Math.min(8, props.rows.length)}</span>}
        >
          <div class="flex items-center gap-2">
            <span data-slot="usage-model-count" class="text-12-regular text-text-weak">
              {shown().length} of {props.rows.length} models
            </span>
            <select
              data-slot="usage-model-limit"
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-medium text-text-base"
              value={String(props.limit)}
              aria-label="Number of models to show"
              onInput={(event) => props.onLimitChange!(parseModelLimit(event.currentTarget.value))}
            >
              <option value="8">Top 8</option>
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
              <option value="all">All</option>
            </select>
          </div>
        </Show>
      </div>
      <div class="mt-3 overflow-auto">
        <table data-slot="usage-table" class="w-full min-w-[460px] text-left">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sessions</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <For each={shown()} fallback={<tr><td colSpan={4}>No usage data.</td></tr>}>
              {(row) => (
                <tr>
                  <td>
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="truncate">{row.name}</span>
                      <Show when={props.showActive && row.active}>
                        <span data-slot="usage-active-badge">{row.activeSessions} active</span>
                      </Show>
                    </div>
                  </td>
                  <td>{formatNumber(row.sessions)}</td>
                  <td>{formatNumber(row.tokens)}</td>
                  <td>{formatCurrency(row.cost)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function EmptyState(props: { children: JSX.Element }) {
  return (
    <div class="flex min-h-44 items-center justify-center rounded-md border border-border-weak-base bg-background-base p-4 text-14-regular text-text-weak">
      {props.children}
    </div>
  )
}
