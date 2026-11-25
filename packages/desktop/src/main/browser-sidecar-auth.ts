import { Buffer } from "node:buffer"

type SidecarCredentials = {
  url: string
  username?: string
  password?: string
}

export function ownsSidecarLogin(source: { session: object } | null, session: object, isProxy: boolean) {
  return source !== null && source.session === session && !isProxy
}

export function sidecarBrowserAuthorization(requestURL: string, sidecar: SidecarCredentials | undefined) {
  if (!sidecar?.password) return
  if (!isDesktopSidecarURL(sidecar.url)) return
  if (!sameOrigin(requestURL, sidecar.url)) return
  return `Basic ${Buffer.from(`${sidecar.username ?? "opencode"}:${sidecar.password}`).toString("base64")}`
}

function sameOrigin(left: string, right: string) {
  if (!URL.canParse(left) || !URL.canParse(right)) return false
  return new URL(left).origin === new URL(right).origin
}

function isDesktopSidecarURL(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1")
}
