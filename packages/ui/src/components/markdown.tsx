import { useMarked } from "../context/marked"
import { useI18n, type UiI18n } from "../context/i18n"
import { sanitizeMarkdown } from "./markdown-sanitize"
import { markdownPreviewHref } from "./markdown-links"
import {
  loadMarkdownPreview,
  loadMarkdownPreviewImage,
  markdownPreviewTarget,
  markdownPreviewFilename,
  markdownPreviewBody,
  MarkdownPreviewError,
  type MarkdownFileReader,
} from "./markdown-preview"
import { copyMarkdownText } from "./markdown-clipboard"
import { createMarkdownCache } from "./markdown-cache"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  splitProps,
} from "solid-js"
import { isServer } from "solid-js/web"
import { bundledLanguages } from "shiki"
import { canReusePendingBlock, project, type Block, type Projection } from "./markdown-stream"
import {
  disposeStreamingCode,
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"

type Entry = {
  raw: string
  hash: string
  html: string
}

type RenderedBlock =
  | (Entry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

const cache = createMarkdownCache<Entry>({ maxEntries: 200, maxBytes: 32 * 1024 * 1024 })
const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
  eye: '<path d="M2.91602 10.0007C4.58268 6.66732 6.94398 5.00065 9.99935 5.00065C13.0547 5.00065 15.416 6.66732 17.0827 10.0007C15.416 13.334 13.0547 15.0007 9.99935 15.0007C6.94398 15.0007 4.58268 13.334 2.91602 10.0007Z" stroke="currentColor" stroke-linejoin="round"/><path d="M10 12.084C11.1506 12.084 12.0833 11.1512 12.0833 10.0007C12.0833 8.85006 11.1506 7.91732 10 7.91732C8.84941 7.91732 7.91667 8.85006 7.91667 10.0007C7.91667 11.1512 8.84941 12.084 10 12.084Z" stroke="currentColor"/>',
  download:
    '<path d="M10 2.91602V12.0827M10 12.0827L13.75 8.33268M10 12.0827L6.25 8.33268M3.75 16.2493H16.25" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
}

function sanitize(html: string) {
  return sanitizeMarkdown(html)
}

export type MarkdownImageResolver = (input: { src: string; alt: string }) => string | undefined

function resolveImageSources(html: string, resolveImageSrc?: MarkdownImageResolver) {
  if (!resolveImageSrc) return html
  const template = document.createElement("template")
  template.innerHTML = html
  for (const image of Array.from(template.content.querySelectorAll("img"))) {
    const src = resolveImageSrc({ src: image.getAttribute("src") ?? "", alt: image.getAttribute("alt") ?? "" })
    if (src) image.setAttribute("src", src)
  }
  return template.innerHTML
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

async function code(text: string, language: string | undefined, key: string, complete = false) {
  const name = language && language in bundledLanguages ? language : "text"
  try {
    const result = await highlightStreamingCode(key, text, name, complete)
    return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
  preview?: string
}

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function createMarkdownPreviewButton(href: string, label: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-preview-button")
  button.setAttribute("data-href", href)
  button.setAttribute("aria-label", label)
  button.setAttribute("data-tooltip", label)
  button.appendChild(createIcon(iconPaths.eye, "preview-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function decorateMarkdownLinks(root: HTMLDivElement, label: string) {
  const links = Array.from(root.querySelectorAll("a[href]"))
  for (const link of links) {
    if (!(link instanceof HTMLAnchorElement)) continue
    const href = link.getAttribute("href") ?? ""
    if (!markdownPreviewHref(href, location.href)) continue
    const parent = link.parentElement
    if (parent?.getAttribute("data-component") === "markdown-preview-link") continue

    const wrapper = document.createElement("span")
    wrapper.setAttribute("data-component", "markdown-preview-link")
    link.replaceWith(wrapper)
    wrapper.appendChild(link)
    wrapper.appendChild(createMarkdownPreviewButton(href, label))
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
  decorateMarkdownLinks(root, labels.preview ?? "Preview markdown")
}

function createPreviewAction(label: string, path: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.textContent = label
  if (path) button.appendChild(createIcon(path, `${label.toLowerCase()}-icon`))
  return button
}

const previewStack: HTMLDivElement[] = []

function showMarkdownPreview(input: {
  href: string
  source?: string
  readFile?: MarkdownFileReader
  parse: (markdown: string) => string | Promise<string>
  getLabels: () => CopyLabels
  i18n: UiI18n
  onClose: () => void
}) {
  const overlay = document.createElement("div")
  overlay.setAttribute("data-component", "markdown-preview-overlay")
  overlay.setAttribute("role", "dialog")
  overlay.setAttribute("aria-modal", "true")
  overlay.setAttribute("aria-label", markdownPreviewFilename(input.href))

  const panel = document.createElement("div")
  panel.setAttribute("data-slot", "markdown-preview-panel")
  const header = document.createElement("div")
  header.setAttribute("data-slot", "markdown-preview-header")
  const title = document.createElement("div")
  title.setAttribute("data-slot", "markdown-preview-title")
  title.textContent = markdownPreviewFilename(input.href)
  const actions = document.createElement("div")
  actions.setAttribute("data-slot", "markdown-preview-actions")
  const copy = createPreviewAction(input.getLabels().copy, iconPaths.copy)
  const download = createPreviewAction(input.i18n.t("ui.markdown.download"), iconPaths.download)
  const close = createPreviewAction(input.i18n.t("ui.common.close"), "")
  copy.disabled = true
  download.disabled = true
  actions.appendChild(copy)
  actions.appendChild(download)
  actions.appendChild(close)
  header.appendChild(title)
  header.appendChild(actions)

  const body = document.createElement("div")
  body.setAttribute("data-component", "markdown")
  body.setAttribute("data-slot", "markdown-preview-body")
  body.setAttribute("aria-live", "polite")
  body.textContent = input.i18n.t("ui.markdown.loading")
  panel.appendChild(header)
  panel.appendChild(body)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  let raw = ""
  let settled = false
  const controller = new AbortController()
  const disposers: (() => void)[] = []
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const background = Array.from(document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
    .map((element) => ({ element, inert: element.inert }))
  const overflow = document.body.style.overflow
  background.forEach(({ element }) => {
    element.inert = true
  })
  document.body.style.overflow = "hidden"
  previewStack.push(overlay)
  const cleanup = () => {
    if (settled) return
    settled = true
    controller.abort()
    disposers.forEach((dispose) => dispose())
    document.removeEventListener("keydown", handleKey, true)
    const index = previewStack.indexOf(overlay)
    if (index >= 0) previewStack.splice(index, 1)
    background.forEach(({ element, inert }) => {
      element.inert = inert
    })
    document.body.style.overflow = overflow
    overlay.remove()
    if (trigger?.isConnected) trigger.focus()
    input.onClose()
  }
  const focusable = () =>
    Array.from(
      panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
    ).filter(
      (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0,
    )
  const handleKey = (event: KeyboardEvent) => {
    if (previewStack.at(-1) !== overlay) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopImmediatePropagation()
      cleanup()
      return
    }
    if (event.key !== "Tab") return
    const controls = focusable()
    if (controls.length === 0) {
      event.preventDefault()
      close.focus()
      return
    }
    const first = controls[0]!
    const last = controls.at(-1)!
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }
  document.addEventListener("keydown", handleKey, true)
  close.addEventListener("click", cleanup)
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) cleanup()
  })
  copy.addEventListener("click", async () => {
    if (!raw) return
    if (!(await copyMarkdownText(raw))) {
      copy.title = input.i18n.t("ui.markdown.copyFailed")
      return
    }
    if (controller.signal.aborted) return
    copy.removeAttribute("title")
    copy.textContent = input.getLabels().copied
    const timeout = setTimeout(() => {
      if (!overlay.isConnected) return
      copy.textContent = input.getLabels().copy
      copy.appendChild(createIcon(iconPaths.copy, "copy-icon"))
    }, 2000)
    disposers.push(() => clearTimeout(timeout))
  })
  download.addEventListener("click", () => {
    if (!raw) return
    const url = URL.createObjectURL(new Blob([raw], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = markdownPreviewFilename(input.href)
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  })

  close.focus()
  loadMarkdownPreview({ ...input, base: location.href, signal: controller.signal })
    .then(async (markdown) => {
      const html = sanitize(await Promise.resolve(input.parse(markdownPreviewBody(markdown))))
      if (controller.signal.aborted) return
      raw = markdown
      const source = markdownPreviewTarget(input.href, location.href, input.source).url?.toString()
      const template = document.createElement("template")
      template.innerHTML = html
      // Remove local sources before inserting into the document so the browser
      // cannot race a request against the renderer's current route.
      const images = Array.from(template.content.querySelectorAll("img")).map((image) => {
        const href = image.getAttribute("src") ?? ""
        const inline = /^(?:data|blob|attachment):/i.test(href)
        if (!inline) image.removeAttribute("src")
        image.removeAttribute("srcset")
        return { image, href, inline }
      })
      body.replaceChildren(template.content)
      decorate(body as HTMLDivElement, input.getLabels())
      copy.disabled = false
      download.disabled = false
      images
        .filter((item) => !item.inline)
        .forEach(({ image, href }) => {
          void loadMarkdownPreviewImage({
            href,
            base: location.href,
            source,
            signal: controller.signal,
            readFile: source ? undefined : input.readFile,
          })
            .then((src) => {
              if (!controller.signal.aborted) image.src = src
            })
            .catch(() => {
              if (controller.signal.aborted) return
              image.replaceWith(
                document.createTextNode(input.i18n.t("ui.markdown.imageFailed", { name: image.alt || href })),
              )
            })
        })
      disposers.push(
        setupCodeCopy(body as HTMLDivElement, input.getLabels, () => input.i18n.t("ui.markdown.copyFailed")),
      )
      disposers.push(
        setupMarkdownPreview(
          body as HTMLDivElement,
          input.parse,
          input.getLabels,
          () => (source ? undefined : input.readFile),
          input.i18n,
          source,
        ),
      )
    })
    .catch((error) => {
      if (controller.signal.aborted) return
      const detail =
        error instanceof MarkdownPreviewError
          ? input.i18n.t(`ui.markdown.${error.code}`, { status: error.status ?? "" })
          : error instanceof Error
            ? error.message
            : String(error)
      body.textContent = input.i18n.t("ui.markdown.failed", { error: detail })
    })
  return cleanup
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels, copyFailed?: () => string) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    if (!(await copyMarkdownText(content))) {
      if (copyFailed) button.title = copyFailed()
      return
    }
    if (!root.isConnected) return
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}

function setupMarkdownPreview(
  root: HTMLDivElement,
  parse: (markdown: string) => string | Promise<string>,
  getLabels: () => CopyLabels,
  readFile: () => MarkdownFileReader | undefined,
  i18n: UiI18n,
  source?: string,
) {
  const previews = new Set<() => void>()
  const handleClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('[data-slot="markdown-preview-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    event.preventDefault()
    event.stopPropagation()
    const href = button.getAttribute("data-href")
    if (!href) return
    const cleanup = showMarkdownPreview({
      href,
      source,
      parse,
      getLabels,
      readFile: readFile(),
      i18n,
      onClose: () => previews.delete(cleanup),
    })
    previews.add(cleanup)
  }

  root.addEventListener("click", handleClick)
  return () => {
    root.removeEventListener("click", handleClick)
    Array.from(previews)
      .reverse()
      .forEach((cleanup) => cleanup())
    previews.clear()
  }
}

function initialResult(
  text: string,
  key: string | undefined,
  projection: Projection,
  owner: string,
  resolveImageSrc?: MarkdownImageResolver,
): RenderResult {
  if (!text) return { text, blocks: [] }
  const base = resolveImageSrc ? undefined : (key ?? checksum(text))
  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = cache.get(cacheKey)
      if (cached?.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })
    if (blocks.length === projection.blocks.length) return { text, blocks }
  }
  return {
    text,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
    resolveImageSrc?: MarkdownImageResolver
    readFile?: MarkdownFileReader
  },
) {
  const [local, others] = splitProps(props, [
    "text",
    "cacheKey",
    "streaming",
    "class",
    "classList",
    "resolveImageSrc",
    "readFile",
  ])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  const completedCode = new Map<string, Extract<RenderedBlock, { mode: "code" }>>()
  const projection = createMemo((previous: Projection | undefined) =>
    project(previous, local.text, local.streaming ?? false),
  )
  const [html] = createResource(
    () => {
      return {
        text: local.text,
        key: local.cacheKey,
        resolveImageSrc: local.resolveImageSrc,
        projection: projection(),
      }
    },
    async (src) => {
      if (isServer)
        return {
          text: src.text,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

      const base = src.resolveImageSrc ? undefined : (src.key ?? checksum(src.text))
      return Promise.all(
        src.projection.blocks.map(async (block, index) => {
          const key = base ? `${base}:${index}:${block.mode}` : undefined
          const blockKey = markdownBlockKey(owner, src.key, index, block.mode)

          if (block.mode === "code") {
            const cached = completedCode.get(blockKey)
            if (block.complete && cached?.raw === block.raw) return cached
            const result = await code(block.src, block.language, blockKey, block.complete)
            const rendered = {
              key: blockKey,
              mode: block.mode,
              raw: block.raw,
              hash: String(block.raw.length),
              complete: !!block.complete,
              ...result,
            }
            if (block.complete) completedCode.set(blockKey, rendered)
            return rendered
          }

          if (key) {
            const cached = cache.get(key)
            if (cached?.raw === block.raw) {
              return { key: blockKey, mode: block.mode, ...cached }
            }
          }

          const safe = sanitize(
            resolveImageSources(await Promise.resolve(marked.parse(block.src)), src.resolveImageSrc),
          )
          const hash = checksum(src.resolveImageSrc ? safe : block.raw)
          if (key && hash) cache.set(key, { raw: block.raw, hash, html: safe })
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: hash ?? "", html: safe }
        }),
      )
        .then((blocks) => ({ text: src.text, blocks }) satisfies RenderResult)
        .catch(
          () =>
            ({
              text: src.text,
              blocks: [
                {
                  key: base ?? "fallback",
                  mode: "full" as const,
                  raw: src.text,
                  hash: checksum(src.text) ?? "",
                  html: fallback(src.text),
                },
              ],
            }) satisfies RenderResult,
        )
    },
    {
      initialValue: initialResult(local.text, local.cacheKey, projection(), owner, local.resolveImageSrc),
    },
  )

  let copyCleanup: (() => void) | undefined
  let previewCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const result = html.latest ?? html()
    const projected = projection()
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner) : []
    if (!container) return
    if (isServer) return
    if (content.length === 0) {
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
      preview: i18n.t("ui.markdown.preview"),
    }
    const nextCodeKeys = new Set(content.filter((block) => block.mode === "code").map((block) => block.key))
    activeCodeKeys.forEach((key) => {
      if (!nextCodeKeys.has(key)) disposeCode(key)
    })
    activeCodeKeys.clear()
    nextCodeKeys.forEach((key) => activeCodeKeys.add(key))
    content.forEach((block, index) => updateBlock(container, index, block, labels))
    while (container.children.length > content.length) container.lastElementChild?.remove()
    container
      .querySelectorAll<HTMLButtonElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    if (!previewCleanup)
      previewCleanup = setupMarkdownPreview(
        container,
        (markdown) => marked.parse(markdown),
        () => ({
          copy: i18n.t("ui.message.copy"),
          copied: i18n.t("ui.message.copied"),
          preview: i18n.t("ui.markdown.preview"),
        }),
        () => local.readFile,
        i18n,
      )
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    if (previewCleanup) previewCleanup()
    activeCodeKeys.forEach(disposeCode)
    completedCode.clear()
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]
    if (current && canReusePendingBlock(current, block)) return current
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)
    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }
    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(container: HTMLDivElement, index: number, block: RenderedBlock, labels: CopyLabels) {
  const current = container.children[index]
  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels)
    return
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  )
    return

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  next.innerHTML = block.html
  decorate(next, labels)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLButtonElement &&
        toEl instanceof HTMLButtonElement &&
        fromEl.getAttribute("data-slot") === toEl.getAttribute("data-slot") &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
  })
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
) {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")
  if (code instanceof HTMLElement) {
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    while (code.children.length > keep) code.lastElementChild?.remove()
    tail
      .slice(keep - stableCount)
      .map(createTokenSpan)
      .forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    return
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  ;[...block.stable, ...block.unstable].map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (current) current.replaceWith(next)
  else container.appendChild(next)
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}
