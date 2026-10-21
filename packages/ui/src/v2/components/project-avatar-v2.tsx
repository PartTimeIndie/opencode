import { type ComponentProps, splitProps, Show } from "solid-js"
import "./project-avatar-v2.css"

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

function first(value: string) {
  if (!value) return ""
  if (!segmenter) return Array.from(value)[0] ?? ""
  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}

export const PROJECT_AVATAR_VARIANTS = [
  "orange",
  "yellow",
  "cyan",
  "green",
  "red",
  "pink",
  "blue",
  "purple",
  "gray",
] as const

export type ProjectAvatarVariant = (typeof PROJECT_AVATAR_VARIANTS)[number]

export interface ProjectAvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  variant?: ProjectAvatarVariant
  unread?: boolean
  loading?: boolean
  status?: "done" | "incomplete" | "question" | "unknown"
  monochrome?: boolean
}

export function ProjectAvatar(props: ProjectAvatarProps) {
  const [split, rest] = splitProps(props, [
    "fallback",
    "src",
    "variant",
    "unread",
    "loading",
    "status",
    "monochrome",
    "class",
    "classList",
    "style",
  ])
  return (
    <div
      {...rest}
      data-component="project-avatar-v2"
      data-unread={split.loading || split.unread || split.status ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={typeof split.style === "object" ? split.style : undefined}
    >
      <div
        data-slot="project-avatar-surface"
        data-variant={split.variant ?? "gray"}
        data-has-image={split.src ? "" : undefined}
        data-monochrome={split.monochrome ? "" : undefined}
        data-loading={split.loading ? "" : undefined}
      >
        <Show when={split.src} fallback={first(split.fallback)}>
          {(value) =>
            split.monochrome ? (
              <span
                data-slot="project-avatar-mask"
                style={{ "--project-avatar-mask-src": cssUrl(value()) }}
                aria-hidden="true"
              />
            ) : (
              <img src={value()} draggable={false} data-slot="project-avatar-image" />
            )
          }
        </Show>
      </div>
      <Show when={split.loading && !split.status}>
        <span data-slot="project-avatar-loader" role="status" aria-label="Session is running" />
      </Show>
      <Show when={split.status || (!split.loading && split.unread)}>
        <span data-slot="project-avatar-unread-dot" data-status={split.status} aria-hidden="true" />
      </Show>
    </div>
  )
}

function cssUrl(src: string) {
  return `url("${src.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, "")}")`
}
