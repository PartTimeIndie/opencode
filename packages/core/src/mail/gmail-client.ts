import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const credentialsFile = () => process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ?? join(homedir(), ".config", "gws", "credentials-export.json")

export async function gmailToken(file = credentialsFile()) {
  const input: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Gmail credentials")
  const data = input as Record<string, unknown>
  if (typeof data.client_id !== "string" || typeof data.client_secret !== "string" || typeof data.refresh_token !== "string")
    throw new Error("Invalid Gmail credentials")
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: data.client_id, client_secret: data.client_secret, refresh_token: data.refresh_token, grant_type: "refresh_token" }),
  })
  const token: unknown = await response.json()
  if (!response.ok || !token || typeof token !== "object" || !("access_token" in token) || typeof token.access_token !== "string")
    throw new Error("Gmail authentication failed; reconnect the account")
  return token.access_token
}

export async function gmailRequest(token: string, path: string, init: RequestInit = {}) {
  if (!path.startsWith("/gmail/v1/users/me/") || path.includes("..") || path.includes("//") || /[\r\n]/.test(path))
    throw new Error("Invalid Gmail API path")
  const response = await fetch(`https://gmail.googleapis.com${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(`Gmail API failed (${response.status}); check account permissions`)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Gmail API response")
  return body as Record<string, unknown>
}
