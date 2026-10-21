import { Icon } from "@opencode-ai/ui/v2/icon"

/** Shared tab control: keep favorite clicks out of activation and native drag handling. */
export function SessionFavoriteButton(props: {
  picked: boolean
  label: string
  disabled?: boolean
  mobile?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-action="session-tab-favorite"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.picked}
      disabled={props.disabled}
      class="relative z-10 flex shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-40"
      classList={{
        "size-7": !props.mobile,
        "size-11": !!props.mobile,
        "text-icon-info-base": props.picked,
        "text-icon-weak": !props.picked,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onToggle()
      }}
    >
      <Icon name="pin" class="size-3.5" />
    </button>
  )
}
