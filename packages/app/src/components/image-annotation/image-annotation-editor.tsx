import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { path, imagePoint, move, rotate, validGesture } from "./geometry"
import { commit, undo, redo, type Mark, type Point, type Scene, type Tool, type History } from "./model"
import { textTile, clearTextTiles } from "./render"
import { emojiCatalog, frequentEmojis, searchEmojis, type EmojiUsage } from "./emoji-catalog"
import "./image-annotation.css"

export type AnnotationLabels = Record<"title" | "apply" | "cancel" | "discard" | "keep" | "unsaved" | "saving" | "color" | "width" | "size" | "search" | "all" | "undo" | "redo" | "delete" | "text" | "select" | "pan" | "freehand" | "line" | "arrow" | "rectangle" | "ellipse" | "emoji" | "zoomIn" | "zoomOut" | "fit" | "closePicker", string>
export function ImageAnnotationEditor(props: { scene: Scene; original: Blob; usage: EmojiUsage; labels: AnnotationLabels; onSave: (scene: Scene) => Promise<void>; onClose: () => void }) {
  const [history, setHistory] = createSignal<History>({ past: [], present: props.scene, future: [] })
  const [draft, setDraft] = createSignal<Scene>()
  const scene = () => draft() ?? history().present
  const [tool, setTool] = createSignal<Tool>("select")
  const [selected, setSelected] = createSignal<string>()
  const selection = createMemo(() => scene().marks.find((mark) => mark.id === selected()))
  const [color, setColor] = createSignal("#ef4444")
  const [width, setWidth] = createSignal(4)
  const [size, setSize] = createSignal(32)
  const [text, setText] = createSignal("")
  const [emoji, setEmoji] = createSignal("👉")
  const [picker, setPicker] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [category, setCategory] = createSignal("")
  const [zoom, setZoom] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [closing, setClosing] = createSignal(false)
  let svg: SVGSVGElement | undefined
  let viewport: HTMLDivElement | undefined
  const [fitWidth, setFitWidth] = createSignal(800)
  onMount(() => {
    const resize = () => { if (viewport) setFitWidth(Math.min(viewport.clientWidth, viewport.clientHeight * props.scene.width / props.scene.height)) }
    const observer = new ResizeObserver(resize)
    if (viewport) observer.observe(viewport)
    resize()
    onCleanup(() => observer.disconnect())
  })
  let gesture: { pointer: number; origin: Point; mark?: Mark; handle?: string; scene: Scene; pan: Point } | undefined
  const url = URL.createObjectURL(props.original)
  onCleanup(() => { URL.revokeObjectURL(url); clearTextTiles() })
  const dirty = () => JSON.stringify(history().present) !== JSON.stringify(props.scene)
  const close = () => { if (busy()) return; if (dirty()) setClosing(true); else props.onClose() }
  const apply = (value: Scene) => { setHistory((old) => commit(old, value)); setDraft(undefined) }
  const change = (values: Partial<Mark>) => {
    const id = selected()
    if (id) apply({ ...scene(), marks: scene().marks.map((mark) => mark.id === id ? { ...mark, ...values } : mark) })
  }
  const remove = () => { apply({ ...scene(), marks: scene().marks.filter((mark) => mark.id !== selected()) }); setSelected(undefined) }
  const point = (event: PointerEvent) => imagePoint({ x: event.clientX, y: event.clientY }, svg!.getBoundingClientRect(), scene().width, scene().height)
  const pick = (id: string) => {
    const mark = scene().marks.find((value) => value.id === id)
    setSelected(id)
    if (!mark) return
    setColor(mark.color); setWidth(mark.width); setSize(mark.size); setText(mark.text)
  }
  const down = (event: PointerEvent) => {
    if (busy() || closing() || gesture || event.button !== 0 || !svg) return
    const target = event.target as Element
    const origin = point(event)
    const id = target.closest("[data-mark]")?.getAttribute("data-mark")
    const handle = target.getAttribute("data-handle") ?? undefined
    if (tool() === "pan") {
      gesture = { pointer: event.pointerId, origin: { x: event.clientX, y: event.clientY }, scene: history().present, pan: pan() }
    } else if (tool() === "select") {
      if (id) pick(id)
      else if (!handle) setSelected(undefined)
      const mark = history().present.marks.find((value) => value.id === (id ?? selected()))
      if (!mark) return
      gesture = { pointer: event.pointerId, origin, mark, handle, scene: history().present, pan: pan() }
    } else {
      if (tool() === "text" && !text().trim()) { setError(props.labels.text); return }
      const mark: Mark = { id: crypto.randomUUID(), kind: tool() as Mark["kind"], start: origin, end: origin, points: [origin], color: color(), width: width(), size: size(), text: tool() === "emoji" ? emoji() : text() }
      gesture = { pointer: event.pointerId, origin, mark, scene: history().present, pan: pan() }
      setDraft({ ...history().present, marks: [...history().present.marks, mark] })
    }
    svg.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const moving = (event: PointerEvent) => {
    const current = gesture
    if (!current || current.pointer !== event.pointerId) return
    if (tool() === "pan") { setPan({ x: current.pan.x + event.clientX - current.origin.x, y: current.pan.y + event.clientY - current.origin.y }); return }
    const p = point(event)
    const mark = current.mark!
    const transformed = () => {
      if (tool() !== "select") return { ...mark, end: p, points: mark.kind === "freehand" ? [...(draft()?.marks.at(-1)?.points ?? mark.points), p] : mark.points }
      if (current.handle === "start") return { ...mark, start: p }
      if (current.handle === "end") return { ...mark, end: p }
      if (current.handle === "size") return { ...mark, size: Math.max(8, Math.min(512, Math.abs(p.y - mark.start.y))) }
      if (current.handle === "rotate") {
        const center = { x: (mark.start.x + mark.end.x) / 2, y: (mark.start.y + mark.end.y) / 2 }
        return rotate(mark, Math.atan2(p.y - center.y, p.x - center.x) - Math.atan2(current.origin.y - center.y, current.origin.x - center.x))
      }
      return move(mark, { x: p.x - current.origin.x, y: p.y - current.origin.y })
    }
    const changed = transformed()
    setDraft({ ...current.scene, marks: tool() === "select" ? current.scene.marks.map((value) => value.id === mark.id ? changed : value) : [...current.scene.marks, changed] })
  }
  const up = (event: PointerEvent) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    moving(event)
    const current = gesture
    if (tool() !== "pan") {
      const value = draft()
      if (value && (tool() === "select" || validGesture(value.marks.at(-1)!))) { apply(value); setSelected(current.mark?.id) }
      else setDraft(undefined)
      if (tool() === "text" || tool() === "emoji") setTool("select")
    }
    gesture = undefined
    svg?.releasePointerCapture(event.pointerId)
  }
  const cancelGesture = (event: PointerEvent) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    if (tool() === "pan") setPan(gesture.pan)
    gesture = undefined
    setDraft(undefined)
  }
  const save = async () => {
    if (busy() || gesture) return
    setBusy(true); setError("")
    await props.onSave(history().present).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
  }
  const tools: Tool[] = ["select", "pan", "freehand", "line", "arrow", "text", "rectangle", "ellipse", "emoji"]
  const handleRadius = () => Math.max(4, scene().width / Math.max(1, svg?.getBoundingClientRect().width ?? 800) * 7)
  const handle = (name: string, p: Point) => <circle data-handle={name} cx={p.x} cy={p.y} r={handleRadius()} fill={name === "rotate" ? "#22c55e" : "white"} stroke="#2563eb" stroke-width={handleRadius() / 3} />
  return <Dialog open modal onOpenChange={(open) => { if (!open) close() }}>
    <Dialog.Portal><Dialog.Overlay class="annotation-overlay" />
      <Dialog.Content class="annotation-editor" data-component="image-annotation-editor" onEscapeKeyDown={(event) => { event.preventDefault(); close() }} onInteractOutside={(event) => event.preventDefault()} onKeyDown={(event) => {
        if (busy() || closing() || gesture || (event.target as HTMLElement).matches("input,textarea,select")) return
        if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); setDraft(undefined); setHistory((value) => event.shiftKey || event.key.toLowerCase() === "y" ? redo(value) : undo(value)) }
        if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); remove() }
        const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
        const delta = directions[event.key]
        const mark = selection()
        if (delta && mark) { event.preventDefault(); change(move(mark, { x: delta.x * (event.shiftKey ? 10 : 1), y: delta.y * (event.shiftKey ? 10 : 1) })) }
      }}>
        <header><Dialog.Title>{props.labels.title}</Dialog.Title><span>{Math.round(zoom() * 100)}%</span></header>
        <div class="annotation-toolbar" role="toolbar" aria-label={props.labels.title}>
          <For each={tools}>{(value) => <button type="button" data-tool={value} aria-pressed={tool() === value} disabled={busy()} onClick={() => { setTool(value); if (value !== "select") setSelected(undefined); if (value === "emoji") setPicker(true) }}>{props.labels[value]}</button>}</For>
          <For each={frequentEmojis(props.usage)}>{(entry) => <button type="button" data-slot="emoji-shortcut" title={entry.name} aria-label={entry.name} disabled={busy()} onClick={() => { setEmoji(entry.glyph); setTool("emoji"); setSelected(undefined); setPicker(false) }}>{entry.glyph}</button>}</For>
          <button type="button" disabled={!history().past.length || busy()} onClick={() => setHistory(undo)}>{props.labels.undo}</button>
          <button type="button" disabled={!history().future.length || busy()} onClick={() => setHistory(redo)}>{props.labels.redo}</button>
          <button type="button" disabled={!selection() || busy()} onClick={remove}>{props.labels.delete}</button>
           <label>{props.labels.color}<input type="color" disabled={busy()} aria-label={props.labels.color} value={color()} onInput={(e) => { setColor(e.currentTarget.value); change({ color: e.currentTarget.value }) }} /></label>
           <label>{props.labels.width}<input type="number" disabled={busy()} aria-label={props.labels.width} min="1" max="64" value={width()} onChange={(e) => { const value = Math.max(1, Math.min(64, +e.currentTarget.value || 4)); setWidth(value); change({ width: value }) }} /></label>
           <label>{props.labels.size}<input type="number" disabled={busy()} aria-label={props.labels.size} min="8" max="512" value={size()} onChange={(e) => { const value = Math.max(8, Math.min(512, +e.currentTarget.value || 32)); setSize(value); change({ size: value }) }} /></label>
          <button type="button" disabled={busy()} aria-label={props.labels.zoomOut} onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))}>−</button>
          <button type="button" disabled={busy()} aria-label={props.labels.fit} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>100%</button>
          <button type="button" disabled={busy()} aria-label={props.labels.zoomIn} onClick={() => setZoom((value) => Math.min(8, value * 1.25))}>+</button>
        </div>
        <Show when={tool() === "text" || selection()?.kind === "text"}><textarea class="annotation-text" aria-label={props.labels.text} value={text()} onInput={(e) => setText(e.currentTarget.value)} onChange={() => { if (selection()?.kind === "text") change({ text: text() }) }} /></Show>
        <Show when={picker()}><section class="annotation-picker" aria-label={props.labels.emoji}>
          <div><input aria-label={props.labels.search} placeholder={props.labels.search} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} /><select aria-label={props.labels.emoji} value={category()} onChange={(e) => setCategory(e.currentTarget.value)}><option value="">{props.labels.all}</option><For each={[...new Set(emojiCatalog.map((entry) => entry.category))]}>{(value) => <option value={value}>{value}</option>}</For></select><button type="button" disabled={busy()} aria-label={props.labels.closePicker} onClick={() => setPicker(false)}>×</button></div>
          <div class="annotation-frequent"><For each={frequentEmojis(props.usage)}>{(entry) => <button type="button" title={entry.name} onClick={() => { setEmoji(entry.glyph); setTool("emoji"); setPicker(false) }}>{entry.glyph}</button>}</For></div>
          <div class="annotation-emoji-grid"><For each={searchEmojis(query(), category())}>{(entry) => <button type="button" title={entry.name} aria-label={entry.name} onClick={() => { setEmoji(entry.glyph); setTool("emoji"); setPicker(false) }}>{entry.glyph}</button>}</For></div>
        </section></Show>
        <div class="annotation-viewport" ref={viewport}>
          <svg ref={svg} data-slot="annotation-canvas" viewBox={`0 0 ${scene().width} ${scene().height}`} style={{ width: `${fitWidth() * zoom()}px`, height: `${fitWidth() * zoom() * scene().height / scene().width}px`, transform: `translate(${pan().x}px, ${pan().y}px)`, cursor: tool() === "pan" ? "grab" : tool() === "select" ? "default" : "crosshair" }} onPointerDown={down} onPointerMove={moving} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
            <image href={url} width={scene().width} height={scene().height} />
            <For each={scene().marks}>{(mark) => <g data-mark={mark.id} onDblClick={() => { if (mark.kind === "text") { pick(mark.id); setTool("select") } }}>
              <Show when={mark.kind === "text" || mark.kind === "emoji"} fallback={<><path d={path(mark)} fill="none" stroke="transparent" stroke-width={Math.max(mark.width, handleRadius() * 2)} /><path d={path(mark)} fill="none" stroke={mark.color} stroke-width={mark.width} stroke-linecap="round" stroke-linejoin="round" /></>}>
                <image href={textTile(mark).url} x={mark.start.x} y={mark.start.y} width={textTile(mark).width} height={textTile(mark).height} />
              </Show>
            </g>}</For>
            <Show when={selection()}>{(mark) => <g data-slot="annotation-handles">
              {handle("start", mark().start)}
              {mark().kind === "text" || mark().kind === "emoji" ? handle("size", { x: mark().start.x + textTile(mark()).width, y: mark().start.y + mark().size }) : handle("end", mark().end)}
              <Show when={mark().kind === "arrow"}>{handle("rotate", { x: (mark().start.x + mark().end.x) / 2, y: (mark().start.y + mark().end.y) / 2 - handleRadius() * 4 })}</Show>
            </g>}</Show>
          </svg>
        </div>
        <Show when={error()}><div role="alert" class="annotation-error">{error()}</div></Show>
        <Show when={closing()}><div class="annotation-confirm" role="alertdialog" aria-label={props.labels.unsaved}><p>{props.labels.unsaved}</p><button type="button" onClick={() => setClosing(false)}>{props.labels.keep}</button><button type="button" onClick={props.onClose}>{props.labels.discard}</button></div></Show>
        <footer><button type="button" disabled={busy()} onClick={close}>{props.labels.cancel}</button><button type="button" data-action="apply-annotation" disabled={busy()} onClick={() => void save()}>{busy() ? props.labels.saving : props.labels.apply}</button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>
}
