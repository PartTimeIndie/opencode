import { Context } from "effect"

const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string>; readonly hostname?: string }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

// A rebound Host header lets a remote page send "same-origin" fetches to the
// loopback server. Only loopback names and explicitly configured origins are
// accepted; a deliberate non-loopback bind (LAN/mDNS exposure) skips the host
// check because that mode already publishes the server beyond the machine.
export function isAllowedRequestHost(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  const bare = input.toLowerCase().replace(/:\d+$/, "").replace(/^\[/, "").replace(/\]$/, "")
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1") return true
  const hostname = opts?.hostname
  if (hostname && hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") return true
  return (
    opts?.cors?.some((entry) => {
      const lower = entry.toLowerCase()
      const withoutScheme = lower.includes("://") ? lower.slice(lower.indexOf("://") + 3) : lower
      const candidate = withoutScheme.replace(/:\d+$/, "").replace(/^\[/, "").replace(/\]$/, "")
      return candidate === bare || lower === input.toLowerCase()
    }) ?? false
  )
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
