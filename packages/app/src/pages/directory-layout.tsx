import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@/utils/toast"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, type ParentProps, Show } from "solid-js"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { acquirePromptSession, type PromptAttachmentPart } from "@/context/prompt"
import { annotationScope } from "@/components/image-annotation/storage"
import { annotationLabels } from "@/components/image-annotation/labels"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useSessionRoute } from "@/context/session-route"
import { useTabs } from "@/context/tabs"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { managedMediaRequest } from "@/utils/managed-media"

export function DirectoryDataProvider(props: ParentProps<{ directory: string; draftID?: string }>) {
  const params = useSessionRoute()
  const server = useServer()
  const platform = usePlatform()
  const sync = useSync()
  const tabs = useTabs()
  const sdk = useSDK()
  const language = useLanguage()
  let annotating = false
  const media = new Map<string, Promise<string>>()
  const mediaControllers = new Set<AbortController>()
  const mediaUrls = new Set<string>()
  let mediaDisposed = false

  const resolveMediaUrl = (part: FilePart, representation: "content" | "preview") => {
    const http = server.current?.http
    if (!http) return Promise.resolve(part.url ?? "")
    const request = managedMediaRequest({
      part,
      representation,
      serverUrl: http.url,
      directory: props.directory,
      username: http.username,
      password: http.password,
    })
    if ("direct" in request) return Promise.resolve(request.direct ?? part.url ?? "")
    const key = `${representation}:${part.sessionID}:${part.url}`
    const existing = media.get(key)
    if (existing) return existing
    const controller = new AbortController()
    mediaControllers.add(controller)
    const task = (async () => {
      const response = await (platform.fetch ?? fetch)(request.url, {
        headers: request.headers,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Failed to load attachment preview: ${response.status}`)
      const objectUrl = URL.createObjectURL(await response.blob())
      if (mediaDisposed) {
        URL.revokeObjectURL(objectUrl)
        return part.url ?? ""
      }
      mediaUrls.add(objectUrl)
      return objectUrl
    })()
      .catch((error) => {
        media.delete(key)
        throw error
      })
      .finally(() => mediaControllers.delete(controller))
    media.set(key, task)
    return task
  }

  onCleanup(() => {
    mediaDisposed = true
    mediaControllers.forEach((controller) => controller.abort())
    mediaUrls.forEach(URL.revokeObjectURL)
    mediaControllers.clear()
    mediaUrls.clear()
    media.clear()
  })

  const annotateImage = (image: FilePart) => {
    if (annotating || !/^image\/(png|jpeg|webp)$/.test(image.mime) || image.url.startsWith("/app/attachment/proof/")) return
    annotating = true
    const host = sdk()
    const target = image.sessionID
    const capturedServer = server.key
    const reference = acquirePromptSession(host.scope, { dir: base64Encode(props.directory), id: target }, platform)
    const part: PromptAttachmentPart = { type: "image", id: crypto.randomUUID(), filename: image.filename ?? "image.png", mime: image.mime }
    const scope = annotationScope(host.scope, host.directory, target)
    const current = () => !mediaDisposed && server.key === capturedServer && sdk().directory === host.directory && params.id === target
    void import("@/components/image-annotation/open").then(({ editImage }) => editImage({
      part, scope, labels: annotationLabels(language.t), current,
      source: async () => {
        const url = await resolveMediaUrl(image, "content")
        const response = await (platform.fetch ?? fetch)(url)
        if (!response.ok) throw new Error(`Image could not be loaded (${response.status})`)
        return response.blob()
      },
      apply: (next) => {
        if (!current()) throw new Error("The target conversation changed")
        reference.value.set([...reference.value.current(), next], reference.value.cursor())
      },
    })).catch((error: unknown) => showToast({ title: language.t("common.error"), description: String(error) })).finally(() => { annotating = false; reference.dispose() })
  }

  const openSessionTab = (sessionID: string) => {
    tabs.openSessionTab({ server: server.key, dirBase64: base64Encode(props.directory), sessionId: sessionID })
  }

  createEffect(() => {
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    const next = sync().data.path.directory
    if (!next || next === props.directory) return
  })

  createResource(
    () => params.id,
    (id) => {
      if (!id) return
      return sync()
        .session.sync(id)
        .catch(() => {})
    },
  )

  return (
    <DataProvider
      data={sync().data}
      directory={props.directory}
      onNavigateToSession={openSessionTab}
      onSessionHref={() => "/"}
      resolveMediaUrl={resolveMediaUrl}
      onAnnotateImage={annotateImage}
      annotateImageLabel={language.t("imageAnnotation.copy")}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
