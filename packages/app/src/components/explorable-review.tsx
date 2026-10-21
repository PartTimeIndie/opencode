import { Markdown } from "@opencode-ai/ui/markdown"
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { visibleReviewSections, type ExplorableSection } from "./explorable-review-model"
import "./explorable-review.css"

export type { ExplorableSection } from "./explorable-review-model"

export type ExplorableVariant = "review" | "accordion" | "details" | "tabs" | "object_tree" | "table"

type DeferredJob = {
  active: boolean
  priority: boolean
  queuedPriority: boolean
  run: () => void
}

type DeferredQueue = {
  items: DeferredJob[]
  head: number
}

const deferredPriorityJobs: DeferredQueue = { items: [], head: 0 }
const deferredNormalJobs: DeferredQueue = { items: [], head: 0 }
let deferredHandle: number | undefined
let deferredPriorityBurst = 0

function takeDeferredJob(queue: DeferredQueue, priority: boolean) {
  while (queue.head < queue.items.length) {
    const job = queue.items[queue.head++]!
    if (job.active && job.priority === priority) return job
  }
  queue.items = []
  queue.head = 0
}

function pumpDeferredMarkdown() {
  if (deferredHandle !== undefined) return
  const hasPriority = deferredPriorityJobs.head < deferredPriorityJobs.items.length
  const hasNormal = deferredNormalJobs.head < deferredNormalJobs.items.length
  if (!hasPriority && !hasNormal) return
  const run = (deadline?: IdleDeadline) => {
    deferredHandle = undefined
    if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 4) {
      pumpDeferredMarkdown()
      return
    }
    const priority = deferredPriorityBurst < 2 ? takeDeferredJob(deferredPriorityJobs, true) : undefined
    const job = priority ?? takeDeferredJob(deferredNormalJobs, false) ?? takeDeferredJob(deferredPriorityJobs, true)
    if (!job) return
    deferredPriorityBurst = job.priority ? deferredPriorityBurst + 1 : 0
    job.active = false
    job.run()
    pumpDeferredMarkdown()
  }
  if (typeof requestIdleCallback === "function") {
    deferredHandle = hasPriority ? requestIdleCallback(run, { timeout: 100 }) : requestIdleCallback(run)
    return
  }
  deferredHandle = requestAnimationFrame(() => run())
}

function scheduleDeferredMarkdown(run: () => void) {
  const job: DeferredJob = { active: true, priority: false, queuedPriority: false, run }
  deferredNormalJobs.items.push(job)
  pumpDeferredMarkdown()
  return {
    prioritize() {
      if (!job.active || job.queuedPriority) return
      job.priority = true
      job.queuedPriority = true
      deferredPriorityJobs.items.push(job)
      if (deferredHandle !== undefined && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(deferredHandle)
        deferredHandle = undefined
      }
      pumpDeferredMarkdown()
    },
    cancel() {
      job.active = false
    },
  }
}

function DeferredMarkdown(props: { text: string; cacheKey: string }) {
  const [visible, setVisible] = createSignal(false)
  let root: HTMLDivElement | undefined
  let observer: IntersectionObserver | undefined
  let scheduled: ReturnType<typeof scheduleDeferredMarkdown> | undefined

  onMount(() => {
    scheduled = scheduleDeferredMarkdown(() => {
      observer?.disconnect()
      observer = undefined
      setVisible(true)
    })
    if (!root || typeof IntersectionObserver === "undefined") return
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        scheduled?.prioritize()
        observer?.disconnect()
        observer = undefined
      },
      { rootMargin: "240px" },
    )
    observer.observe(root)
  })

  onCleanup(() => {
    observer?.disconnect()
    scheduled?.cancel()
  })

  return (
    <div ref={root} data-slot="explorable-deferred-markdown" data-ready={visible()} aria-busy={!visible()}>
      <Show when={visible()} fallback={<div data-slot="explorable-markdown-preview">{previewText(props.text)}</div>}>
        <Markdown text={props.text} cacheKey={props.cacheKey} />
      </Show>
    </div>
  )
}

export function ExplorableReview(props: {
  markdown?: string
  content?: string
  sections?: ExplorableSection[]
  variant?: ExplorableVariant
  cacheKey?: string
}) {
  const variant = () => props.variant ?? "review"
  const cacheKey = () => props.cacheKey ?? "explorable"
  const content = createMemo(() => props.markdown ?? props.content)
  const reviewContent = createMemo(() => (variant() === "review" ? content() : undefined))
  const introContent = createMemo(() => (variant() === "review" ? undefined : content()))
  return (
    <div data-slot="explorable-review" data-variant={variant()}>
      <Show when={reviewContent()}>
        {(md) => <div data-slot="explorable-review-md"><DeferredMarkdown text={md()} cacheKey={`${cacheKey()}:md`} /></div>}
      </Show>
      <Show when={introContent()}>
        {(md) => <div data-slot="explorable-review-intro"><DeferredMarkdown text={md()} cacheKey={`${cacheKey()}:intro`} /></div>}
      </Show>
      <Show when={variant() !== "review" || !reviewContent()}>
        <Switch fallback={<ReviewSections sections={props.sections ?? []} cacheKey={cacheKey()} />}>
          <Match when={variant() === "accordion" || variant() === "details"}>
            <AccordionSections sections={props.sections ?? []} variant={variant()} cacheKey={cacheKey()} />
          </Match>
          <Match when={variant() === "tabs"}>
            <TabsSections sections={props.sections ?? []} cacheKey={cacheKey()} />
          </Match>
          <Match when={variant() === "table"}>
            <TableSections sections={props.sections ?? []} cacheKey={cacheKey()} />
          </Match>
          <Match when={variant() === "object_tree"}>
            <TreeView sections={props.sections ?? []} cacheKey={cacheKey()} />
          </Match>
        </Switch>
      </Show>
    </div>
  )
}

function ReviewSections(props: { sections: ExplorableSection[]; cacheKey: string }) {
  return (
    <For each={props.sections}>
      {(section) => (
        <section data-slot="explorable-section">
          <h4>{section.title}</h4>
          <DeferredMarkdown text={section.content} cacheKey={`${props.cacheKey}:${section.id}`} />
          <Show when={section.children?.length}>
            <ReviewSections sections={section.children ?? []} cacheKey={`${props.cacheKey}:${section.id}`} />
          </Show>
        </section>
      )}
    </For>
  )
}

function AccordionSections(props: {
  sections: ExplorableSection[]
  variant: string
  cacheKey: string
  depth?: number
}) {
  const depth = () => props.depth ?? 0
  const [open, setOpen] = createStore<Record<string, boolean>>({})
  const toggle = (id: string) => {
    if (props.variant === "details") {
      const wasOpen = open[id] === true
      for (const key of Object.keys(open)) setOpen(key, false)
      setOpen(id, !wasOpen)
      return
    }
    setOpen(id, open[id] !== true)
  }
  return (
    <For each={props.sections}>
      {(section) => {
        const panelID = `${props.cacheKey}:${section.id}:panel`
        return (
          <div data-slot="explorable-accordion" data-open={open[section.id] === true} data-depth={depth()}>
            <button
              type="button"
              data-slot="explorable-accordion-header"
              aria-expanded={open[section.id] === true}
              aria-controls={panelID}
              onClick={() => toggle(section.id)}
            >
              <span data-slot="explorable-caret" aria-hidden="true">▸</span>
              <span data-slot="explorable-accordion-title">{section.title}</span>
            </button>
            <Show when={open[section.id] === true}>
              <div id={panelID} role="region" data-slot="explorable-accordion-panel">
                <Show when={section.content}>
                  <DeferredMarkdown text={section.content} cacheKey={`${props.cacheKey}:${section.id}`} />
                </Show>
                <Show when={section.children?.length}>
                  <AccordionSections
                    sections={section.children ?? []}
                    variant={props.variant}
                    cacheKey={`${props.cacheKey}:${section.id}`}
                    depth={depth() + 1}
                  />
                </Show>
              </div>
            </Show>
          </div>
        )
      }}
    </For>
  )
}

function TabsSections(props: { sections: ExplorableSection[]; cacheKey: string }) {
  const [active, setActive] = createSignal(props.sections[0]?.id ?? "")
  const current = createMemo(() => props.sections.find((s) => s.id === active()) ?? props.sections[0])
  return (
    <div data-slot="explorable-tabs">
      <div role="tablist" data-slot="explorable-tablist">
        <For each={props.sections}>
          {(section) => (
            <button
              type="button"
              role="tab"
              data-slot="explorable-tab"
              data-active={section.id === active()}
              onClick={() => setActive(section.id)}
            >
              {section.title}
            </button>
          )}
        </For>
      </div>
      <Show when={current()}>
        {(section) => (
          <div role="tabpanel" data-slot="explorable-tabpanel">
            <Show when={section().content}>
              <DeferredMarkdown text={section().content} cacheKey={`${props.cacheKey}:${section().id}`} />
            </Show>
            <Show when={section().children?.length}>
              <AccordionSections sections={section().children ?? []} variant="accordion" cacheKey={`${props.cacheKey}:${section().id}`} />
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

function TableSections(props: { sections: ExplorableSection[]; cacheKey: string }) {
  return (
    <For each={props.sections}>
      {(section) => {
        const meta = () => section.meta as { columns?: string[]; rows?: string[][] } | undefined
        const hasTable = () => !!meta()?.columns?.length && !!meta()?.rows?.length
        return (
          <div data-slot="explorable-table-wrap">
            <Show when={section.title}>
              <h4>{section.title}</h4>
            </Show>
            <Show
              when={hasTable()}
              fallback={<Markdown text={section.content} cacheKey={`${props.cacheKey}:${section.id}`} />}
            >
              <table data-slot="explorable-table">
                <thead>
                  <tr>
                    <For each={meta()!.columns!}>{(col) => <th>{col}</th>}</For>
                  </tr>
                </thead>
                <tbody>
                  <For each={meta()!.rows!}>
                    {(row) => (
                      <tr>
                        <For each={row}>{(cell) => <td>{cell}</td>}</For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        )
      }}
    </For>
  )
}

function previewText(content: string) {
  const text = content.slice(0, 2_048).replace(/\s+/g, " ").trim()
  if (text.length <= 360 && content.length <= 2_048) return text
  return `${text.slice(0, 357)}...`
}

function sectionPreview(section: ExplorableSection) {
  const meta = section.meta as { preview?: string } | undefined
  return previewText(meta?.preview ?? section.content)
}

function sectionChildren(section: ExplorableSection) {
  return section.children ?? []
}

function TreeNodeButton(props: { section: ExplorableSection; childCount: number; onClick: () => void }) {
  return (
    <button type="button" data-slot="explorable-node" onClick={props.onClick}>
      <span data-slot="explorable-node-copy">
        <span data-slot="explorable-node-title">{props.section.title}</span>
        <Show when={sectionPreview(props.section)}>
          {(preview) => <span data-slot="explorable-node-preview">{preview()}</span>}
        </Show>
      </span>
      <span data-slot="explorable-node-hint" data-has-children="true">
        {props.childCount} tiefer
      </span>
    </button>
  )
}

function TreeLeafCard(props: { section: ExplorableSection; cacheKey: string }) {
  return (
    <article data-slot="explorable-leaf">
      <span data-slot="explorable-leaf-copy">
        <span data-slot="explorable-leaf-title">{props.section.title}</span>
        <Show when={props.section.content}>
          <DeferredMarkdown text={props.section.content} cacheKey={`${props.cacheKey}:${props.section.id}:leaf`} />
        </Show>
      </span>
    </article>
  )
}

function TreeSectionItem(props: { section: ExplorableSection; cacheKey: string; onDrill: (id: string) => void }) {
  const children = createMemo(() => sectionChildren(props.section))
  return (
    <Show
      when={children().length > 0}
      fallback={<TreeLeafCard section={props.section} cacheKey={props.cacheKey} />}
    >
      <TreeNodeButton section={props.section} childCount={children().length} onClick={() => props.onDrill(props.section.id)} />
    </Show>
  )
}

function TreeView(props: { sections: ExplorableSection[]; cacheKey: string }) {
  const [path, setPath] = createSignal<string[]>([])
  const rootSections = createMemo(() => visibleReviewSections(props.sections))
  const current = createMemo(() => {
    const p = path()
    if (p.length === 0) return undefined
    let nodes = rootSections()
    let node: ExplorableSection | undefined
    for (const id of p) {
      node = nodes.find((n) => n.id === id)
      if (!node) return undefined
      nodes = sectionChildren(node)
    }
    return node
  })
  const crumbs = createMemo(() => {
    const labels: { title: string }[] = []
    let nodes = rootSections()
    for (const id of path()) {
      const node = nodes.find((n) => n.id === id)
      if (!node) break
      labels.push({ title: node.title })
      nodes = sectionChildren(node)
    }
    return labels
  })
  const drill = (id: string) => setPath((p) => [...p, id])
  const back = () => setPath((p) => p.slice(0, -1))
  const jumpTo = (index: number) => setPath((p) => p.slice(0, index + 1))
  return (
    <div data-slot="explorable-tree">
      <Show when={path().length > 0}>
        <nav data-slot="explorable-breadcrumb">
          <button type="button" data-slot="explorable-back" onClick={back}>
            <span aria-hidden="true">←</span> Back
          </button>
          <button type="button" data-slot="explorable-crumb" data-root="true" onClick={() => setPath([])}>
            Übersicht
          </button>
          <For each={crumbs()}>
            {(crumb, i) => (
              <>
                <span data-slot="explorable-crumb-sep" aria-hidden="true">/</span>
                <button
                  type="button"
                  data-slot="explorable-crumb"
                  data-last={i() === crumbs().length - 1}
                  onClick={() => jumpTo(i())}
                >
                  {crumb.title}
                </button>
              </>
            )}
          </For>
        </nav>
      </Show>
      <Show
        when={current()}
        fallback={
          <For each={rootSections()}>
            {(section) => <TreeSectionItem section={section} cacheKey={props.cacheKey} onDrill={drill} />}
          </For>
        }
      >
        {(node) => (
          <article data-slot="explorable-detail">
            <h4>{node().title}</h4>
            <Show when={node().content}>
              <DeferredMarkdown text={node().content!} cacheKey={`${props.cacheKey}:${node().id}`} />
            </Show>
            <Show when={sectionChildren(node()).length}>
              <div data-slot="explorable-subnodes">
                <For each={sectionChildren(node())}>
                  {(child) => <TreeSectionItem section={child} cacheKey={`${props.cacheKey}:${node().id}`} onDrill={drill} />}
                </For>
              </div>
            </Show>
          </article>
        )}
      </Show>
    </div>
  )
}
