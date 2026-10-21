import { Show, type JSX, type ParentProps } from "solid-js"

export function SettingsContributionV2(
  props: ParentProps<{
    id: string
    kind: "skill" | "plugin"
    title: string
    description?: string
    actions?: JSX.Element
    pluginID?: string
    revision?: number
  }>,
) {
  return (
    <div
      class="settings-v2-section"
      data-action={props.id}
      data-settings-contribution={props.id}
      data-settings-contribution-kind={props.kind}
      data-plugin-settings={props.pluginID}
      data-settings-revision={props.revision}
    >
      <div class="settings-v2-skill-section-header">
        <div>
          <h3 class="settings-v2-section-title">{props.title}</h3>
          <Show when={props.description}>{(description) => <p>{description()}</p>}</Show>
        </div>
        {props.actions}
      </div>
      {props.children}
    </div>
  )
}
