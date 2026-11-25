import { onCleanup, onMount } from "solid-js"
import { animate } from "motion"
import { scheduleAnimations } from "./animation-lifecycle"

export function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef!: HTMLSpanElement
  let valueRef!: HTMLSpanElement

  onMount(() => {
    if (!props.animate) return
    onCleanup(
      scheduleAnimations(() => [
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 }),
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] }),
      ]),
    )
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}
