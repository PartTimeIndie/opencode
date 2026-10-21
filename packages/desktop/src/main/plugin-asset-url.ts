const rendererProtocol = "oc:"
const rendererHost = "renderer"
const pluginHost = "plugin"

export function pluginAssetTarget(serverURL: string, requestURL: string) {
  if (!URL.canParse(serverURL) || !URL.canParse(requestURL)) return undefined

  const request = new URL(requestURL)
  if (request.protocol !== rendererProtocol || request.username || request.password || request.port) return undefined

  const match = requestURL.match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i)
  if (!match) return undefined

  const end = [requestURL.indexOf("?", match[0].length), requestURL.indexOf("#", match[0].length)]
    .filter((index) => index !== -1)
    .reduce((lowest, index) => Math.min(lowest, index), requestURL.length)
  const rawSegments = requestURL.slice(match[0].length, end).split("/").slice(1)
  const assetSegments =
    request.host === rendererHost && rawSegments[0] === "app" && rawSegments[1] === "plugin"
      ? rawSegments.slice(2)
      : request.host === pluginHost
        ? rawSegments
        : undefined
  if (!assetSegments || assetSegments.length < 3 || assetSegments.some((segment) => !segment)) return undefined

  const segments = assetSegments.flatMap((segment) => {
    const decoded = decodeSegment(segment)
    return decoded === undefined ? [] : [decoded]
  })
  if (
    segments.length !== assetSegments.length ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    return undefined
  }

  const server = new URL(serverURL)
  server.pathname = `${server.pathname.replace(/\/+$/, "")}/app/plugin/${segments.map(encodeURIComponent).join("/")}`
  server.search = ""
  server.hash = ""
  return server.toString()
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}
