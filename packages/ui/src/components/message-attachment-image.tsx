import type { FilePart } from "@opencode-ai/sdk/v2"
import { createResource, type Component } from "solid-js"
import { useData } from "../context"
import { previewUrl } from "./message-file"

export const MessageAttachmentImage: Component<{
  part: FilePart
  alt: string
  class?: string
  slot?: string
}> = (props) => {
  const data = useData()
  const [src] = createResource(
    () => props.part,
    (part) => data.resolveMediaUrl?.(part, "preview") ?? previewUrl(part),
  )
  return <img data-slot={props.slot} class={props.class} src={src()} alt={props.alt} />
}
