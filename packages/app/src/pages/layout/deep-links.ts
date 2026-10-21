import type { AppHostHandoff } from "@opencode-ai/plugin/app"
import { validateHandoff } from "@/plugin/navigation-handoff"

export const deepLinkEvent = "opencode:deep-link"

const parseUrl = (input: string) => {
  if (!input.startsWith("opencode://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const parsePluginHandoffDeepLink = (input: string): AppHostHandoff | undefined => {
  if (input.length > 100000) return
  const url = parseUrl(input)
  // Windows protocol activation normalizes an empty authority path to `/`.
  // Treat both representations as the same root handoff while continuing to
  // reject every non-root path.
  if (
    !url ||
    url.hostname !== "plugin-handoff" ||
    (url.pathname && url.pathname !== "/") ||
    url.hash ||
    url.username ||
    url.password
  )
    return
  if ([...url.searchParams.keys()].sort().join(",") !== "directory,handlerID,payload,pluginID") return
  try {
    const handoff = {
      pluginID: url.searchParams.get("pluginID")!,
      handlerID: url.searchParams.get("handlerID")!,
      directory: url.searchParams.get("directory")!,
      payload: JSON.parse(url.searchParams.get("payload")!),
    }
    if (!validateHandoff(handoff)) return handoff
  } catch {
    return
  }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is { directory: string; prompt?: string } => !!link)

export const collectPluginHandoffDeepLinks = (urls: string[]) =>
  urls.map(parsePluginHandoffDeepLink).filter((link): link is AppHostHandoff => !!link)

type OpenCodeWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: OpenCodeWindow) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}

export const consumeDeepLinkEvent = (target: OpenCodeWindow, urls: string[]) =>
  Array.from(new Set([...drainPendingDeepLinks(target), ...urls]))
