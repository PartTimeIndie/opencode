import type { FilePart } from "@opencode-ai/sdk/v2"
import { authTokenFromCredentials } from "@/utils/server"

export function managedMediaRequest(input: {
  part: FilePart
  representation: "content" | "preview"
  serverUrl: string
  directory: string
  username?: string
  password?: string
}) {
  if (/^(https?|data|blob):/i.test(input.part.url)) return { direct: input.part.url } as const

  const url = new URL("/app/media", input.serverUrl)
  if (input.part.url.startsWith("attachment://")) {
    url.pathname = `/app/attachment/${input.representation}/${encodeURIComponent(input.part.url.slice("attachment://".length))}`
    url.searchParams.set("sessionID", input.part.sessionID)
  } else {
    url.searchParams.set("path", input.part.url)
    url.searchParams.set("directory", input.directory)
  }

  const headers = new Headers({ "x-opencode-directory": input.directory })
  if (input.password) {
    headers.set(
      "authorization",
      `Basic ${authTokenFromCredentials({ username: input.username, password: input.password })}`,
    )
  }
  return { url, headers } as const
}
