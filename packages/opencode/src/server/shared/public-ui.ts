// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/apple-touch-icon-v3.png",
  "/favicon-96x96-v3.png",
  "/favicon-v3.ico",
  "/favicon-v3.svg",
  "/oc-theme-preload.js",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

const VITE_DEV_UI_PATHS = new Set<string>(["/@react-refresh", "/@vite/client", "/__vite_ping"])

const VITE_DEV_UI_PREFIXES = ["/@fs/", "/@id/", "/@vite/", "/node_modules/", "/src/"]

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && (PUBLIC_UI_PATHS.has(pathname) || isViteDevUIPath(pathname))
}

function isViteDevUIPath(pathname: string) {
  if (!hasLocalDevUIUpstream()) return false
  return VITE_DEV_UI_PATHS.has(pathname) || VITE_DEV_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function hasLocalDevUIUpstream() {
  const upstream = process.env.OPENCODE_WEB_UI_UPSTREAM
  if (!upstream) return false

  try {
    const url = new URL(upstream)
    // Only local/private Vite dev servers should expose source-module paths
    // without server auth; embedded and hosted UI fallbacks must stay narrow.
    if (url.protocol !== "http:") return false
    return isPrivateDevHost(url.hostname)
  } catch {
    return false
  }
}

function isPrivateDevHost(hostname: string) {
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1") return true
  if (hostname.startsWith("127.") || hostname.startsWith("10.") || hostname.startsWith("192.168.")) return true

  const match = /^172\.(\d+)\./.exec(hostname)
  if (!match) return false
  const second = Number(match[1])
  return second >= 16 && second <= 31
}
