import { Show, createUniqueId, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { LayoutRegions } from "@/components/surface/layout-regions"

export function OnDemandExpectation(props: {
  text: string
  actionNeeded: boolean
  slot: "question-expectation" | "control-panel-expectation"
}) {
  return (
    <div data-component="on-demand-expectation" data-slot={props.slot} data-action-needed={props.actionNeeded}>
      {props.text}
    </div>
  )
}

export function OnDemandPopup(props: {
  kind: "question" | "control-panel"
  title: JSX.Element
  description?: JSX.Element
  actions?: JSX.Element
  children: JSX.Element
  onDismiss?: () => void
  restoreFocus?: boolean
}) {
  const titleID = createUniqueId()
  const descriptionID = createUniqueId()
  const restoreFocus = props.restoreFocus === true
  let region: HTMLDivElement | undefined
  let restoreTarget: HTMLElement | undefined
  let restoreAfterDismiss = false

  onMount(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !region?.contains(active)) restoreTarget = active

    const rememberOutsideFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || region?.contains(event.target)) return
      restoreTarget = event.target
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !props.onDismiss) return
      if (!region?.contains(document.activeElement)) return
      event.preventDefault()
      restoreAfterDismiss = restoreFocus
      props.onDismiss()
    }

    document.addEventListener("focusin", rememberOutsideFocus)
    document.addEventListener("keydown", dismiss)
    onCleanup(() => {
      const shouldRestore = restoreAfterDismiss || (restoreFocus && !!region?.contains(document.activeElement))
      document.removeEventListener("focusin", rememberOutsideFocus)
      document.removeEventListener("keydown", dismiss)
      if (!shouldRestore || !restoreTarget?.isConnected) return
      queueMicrotask(() => restoreTarget?.focus())
    })
  })

  return (
    <Portal mount={document.body}>
      <div
        ref={region}
        data-component={`${props.kind}-popup-region`}
        data-surface="on-demand-popup-region"
        data-surface-region={LayoutRegions.popupFirst(false)}
        aria-live="polite"
        aria-relevant="additions text"
      >
        <section
          data-component={`${props.kind}-popup`}
          data-surface="on-demand-popup"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleID}
          aria-describedby={props.description ? descriptionID : undefined}
        >
          <div data-slot={`${props.kind}-popup-header`}>
            <div data-slot={`${props.kind}-popup-copy`} class="min-w-0 flex-1">
              <div id={titleID} data-slot={`${props.kind}-popup-title`}>
                {props.title}
              </div>
              <Show when={props.description}>
                <div id={descriptionID} data-slot={`${props.kind}-popup-description`}>
                  {props.description}
                </div>
              </Show>
            </div>
            <Show when={props.actions}>
              <div data-slot={`${props.kind}-popup-actions`} class="shrink-0 flex items-center gap-2">
                {props.actions}
              </div>
            </Show>
          </div>
          {props.children}
        </section>
      </div>
    </Portal>
  )
}
