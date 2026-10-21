import type { Component, JSX } from "solid-js"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  action?: string
  title: string | JSX.Element
  description: string | JSX.Element
  /** Renders the control on its own full-width line below the copy for wide editors. */
  block?: boolean
  children: JSX.Element
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  return (
    <div
      data-component="settings-v2-row"
      data-action={props.action}
      {...(props.block ? { "data-block": "true" } : {})}
    >
      <div data-slot="settings-v2-row-copy">
        <div data-slot="settings-v2-row-title">{props.title}</div>
        <div data-slot="settings-v2-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-v2-row-control">{props.children}</div>
    </div>
  )
}
