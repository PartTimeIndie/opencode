import { Icon } from "@opencode-ai/ui/icon"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createMemo, createSignal, createUniqueId, For, Show, type JSX } from "solid-js"

export type SelectFieldOption = {
  id?: string
  label?: string
  tooltip?: string
}

export type SelectFieldComboboxProps = {
  options: SelectFieldOption[]
  value?: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  /** id of the element labelling this combobox, for aria-labelledby */
  labelledBy?: string
  onChange?: (key: string) => void
}

const optionKey = (option: SelectFieldOption) => option.id ?? option.label ?? ""
const optionLabel = (option: SelectFieldOption) => option.label ?? option.id ?? ""

function compareOptions(a: SelectFieldOption, b: SelectFieldOption) {
  const result = optionLabel(a).localeCompare(optionLabel(b), undefined, { sensitivity: "base", numeric: true })
  return result
}

/**
 * Searchable select for question/control-panel forms.
 * Renders a trigger button; the opened panel shows a small search input above an
 * alphabetically sorted listbox. Selection reports the option key (id ?? label),
 * mirroring the previous native <select> value semantics.
 */
export function SelectFieldCombobox(props: SelectFieldComboboxProps) {
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let search: HTMLInputElement | undefined

  const uid = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)

  const listboxId = `${uid}:listbox`

  const sorted = createMemo(() => [...props.options].sort(compareOptions))

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return sorted()
    return sorted().filter((option) => optionLabel(option).toLowerCase().includes(needle))
  })

  const selectedKey = () => props.value ?? ""
  const selectedLabel = () => {
    const key = selectedKey()
    const match = sorted().find((option) => optionKey(option) === key)
    return match ? optionLabel(match) : key
  }

  const activeId = (index: number) => `${uid}:option:${index}`

  createEffect(() => {
    const count = filtered().length
    setActive((current) => {
      if (!count) return 0
      if (current >= count) return count - 1
      return current
    })
  })

  createEffect(() => {
    if (!open()) return
    const index = active()
    document.getElementById(activeId(index))?.scrollIntoView({ block: "nearest" })
  })

  const openPanel = () => {
    if (props.disabled || !sorted().length) return
    const key = selectedKey()
    const index = Math.max(
      0,
      sorted().findIndex((option) => optionKey(option) === key),
    )
    setQuery("")
    setActive(index)
    setOpen(true)
    queueMicrotask(() => search?.focus())
  }

  const closePanel = (focusTrigger = false) => {
    if (!open()) return
    setOpen(false)
    setQuery("")
    if (focusTrigger) queueMicrotask(() => trigger?.focus())
  }

  const pick = (option: SelectFieldOption | undefined) => {
    if (!option) return
    props.onChange?.(optionKey(option))
    closePanel(true)
  }

  const moveActive = (step: number) => {
    const count = filtered().length
    if (!count) return
    setActive((current) => (current + step + count) % count)
  }

  const handleSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
      return
    }
    if (event.key === "Tab") {
      closePanel(false)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveActive(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(-1)
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setActive(Math.max(0, filtered().length - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      pick(filtered()[active()])
    }
  }

  makeEventListener(document, "pointerdown", (event) => {
    if (!open()) return
    if (root && event.target instanceof Node && root.contains(event.target)) return
    closePanel(false)
  })

  const triggerContent = (): JSX.Element => (
    <>
      <span data-slot="question-form-select-value" data-placeholder={!selectedLabel() ? "true" : undefined}>
        {selectedLabel() || props.placeholder || ""}
      </span>
      <Icon name="chevron-down" size="small" />
    </>
  )

  return (
    <div ref={(el) => (root = el)} data-slot="question-form-select">
      <button
        ref={(el) => (trigger = el)}
        type="button"
        data-slot="question-form-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? listboxId : undefined}
        aria-labelledby={props.labelledBy}
        aria-required={props.required ? "true" : undefined}
        disabled={props.disabled}
        title={selectedLabel() || props.placeholder}
        onClick={() => (open() ? closePanel(false) : openPanel())}
      >
        {triggerContent()}
      </button>
      <Show when={open()}>
        <div
          data-slot="question-form-select-popover"
          role="dialog"
          aria-modal="false"
          aria-label={optionLabel(sorted().find((option) => optionKey(option) === selectedKey()) as never) || props.placeholder}
        >
          <div data-slot="question-form-select-search">
            <input
              ref={(el) => (search = el)}
              type="text"
              role="combobox"
              autocomplete="off"
              aria-expanded="true"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-labelledby={props.labelledBy}
              aria-describedby={`${uid}:hint`}
              aria-controls={listboxId}
              aria-activedescendant={filtered().length ? activeId(active()) : undefined}
              placeholder="Suchen…"
              data-slot="question-form-select-search-input"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <span id={`${uid}:hint`} hidden>
              Filtern mit Text; Pfeiltasten zum Navigieren; Enter wählt aus.
            </span>
          </div>
          <ul id={listboxId} role="listbox" data-slot="question-form-select-listbox" aria-required={props.required ? "true" : undefined}>
            <For each={filtered()}>
              {(option, index) => (
                <li
                  id={activeId(index())}
                  role="option"
                  data-slot="question-form-select-option"
                  data-active={index() === active() ? "true" : undefined}
                  aria-selected={index() === active() ? "true" : undefined}
                  title={option.tooltip}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index())}
                  onClick={() => pick(option)}
                >
                  <span>{optionLabel(option)}</span>
                  <Show when={optionKey(option) === selectedKey()}>
                    <Icon name="check-small" size="small" />
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={!filtered().length}>
            <div data-slot="question-form-select-empty">Keine Treffer</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default SelectFieldCombobox
