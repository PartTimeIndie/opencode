import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

type PerfEvent = { kind: string; source?: string } & Record<string, unknown>

const batches = new Map<ServerConnection.Key, { server: ServerConnection.Any; events: PerfEvent[]; timer?: number }>()
const FLUSH_MS = 1_000
const MAX_EVENTS = 50

export function recordPerfEvent(server: ServerConnection.Any | undefined, event: PerfEvent) {
  if (!server || typeof window === "undefined") return
  const key = ServerConnection.key(server)
  const batch = batches.get(key) ?? { server, events: [] }
  batch.server = server
  batch.events.push({ source: "app", ...event })
  batches.set(key, batch)
  if (batch.events.length >= MAX_EVENTS) return flush(key)
  if (batch.timer !== undefined) return
  batch.timer = window.setTimeout(() => flush(key), FLUSH_MS)
}

export function flushPerfEvents() {
  for (const key of batches.keys()) flush(key)
}

function flush(key: ServerConnection.Key) {
  const batch = batches.get(key)
  if (!batch) return
  if (batch.timer !== undefined) window.clearTimeout(batch.timer)
  batches.delete(key)
  if (batch.events.length === 0) return
  void fetch(`${batch.server.http.url.replace(/\/+$/, "")}/perf/record`, {
    method: "POST",
    keepalive: true,
    headers: {
      "content-type": "application/json",
      ...(batch.server.http.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: batch.server.http.username,
              password: batch.server.http.password,
            })}`,
          }
        : {}),
    },
    body: JSON.stringify({ events: batch.events }),
  }).catch(() => undefined)
}

if (typeof window !== "undefined") {
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPerfEvents()
  })
}
