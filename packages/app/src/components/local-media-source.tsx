import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export function LocalMediaSource(props: {
  source?: string
  fallback: JSX.Element
  children: (src: () => string) => JSX.Element
}) {
  const platform = usePlatform()
  const sdk = useSDK()
  const server = useServer()
  const [url, setUrl] = createSignal<string>()
  const source = createMemo(() => props.source?.trim() ?? "")

  createEffect(() => {
    const current = source()
    let objectUrl: string | undefined
    const controller = new AbortController()
    if (!current) {
      setUrl(undefined)
      return
    }
    if (/^(https?|data|blob):/i.test(current)) {
      setUrl(current)
      return
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(current) && !current.startsWith("file://") && !/^[A-Za-z]:[\\/]/.test(current)) {
      setUrl(undefined)
      return
    }

    const request = new URL("/app/media", sdk().url)
    request.searchParams.set("path", current)
    request.searchParams.set("directory", sdk().directory)
    const headers = new Headers({ "x-opencode-directory": sdk().directory })
    const http = server.current?.http
    if (http?.password) {
      headers.set(
        "authorization",
        `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}`,
      )
    }
    setUrl(undefined)
    void (platform.fetch ?? fetch)(request, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.statusText)
        objectUrl = URL.createObjectURL(await response.blob())
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setUrl(undefined)
      })
    onCleanup(() => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    })
  })

  return (
    <Show when={url()} fallback={props.fallback}>
      {(src) => props.children(src)}
    </Show>
  )
}
