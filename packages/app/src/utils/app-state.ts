import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

function authHeaders(server: ServerConnection.HttpBase) {
  if (!server.password) return {} as Record<string, string>
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

function appStateUrl(server: ServerConnection.HttpBase, key: string) {
  return `${server.url.replace(/\/+$/, "")}/app/state/${encodeURIComponent(key)}`
}

export async function readAppState<T>(server: ServerConnection.HttpBase, key: string): Promise<T | undefined> {
  const response = await fetch(appStateUrl(server, key), {
    headers: authHeaders(server),
    cache: "no-store",
  }).catch(() => undefined)
  if (!response?.ok) return
  return (await response.json().catch(() => undefined)) as T | undefined
}

export async function writeAppState(server: ServerConnection.HttpBase, key: string, value: Record<string, unknown>) {
  await fetch(appStateUrl(server, key), {
    method: "PUT",
    headers: {
      ...authHeaders(server),
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  }).catch(() => undefined)
}
