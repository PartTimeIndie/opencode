import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "./path"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi; directory?: string }) {
  const theme = () => props.api.theme.current
  const paths = props.api.state.path
  const dir = createMemo(() => {
    const directory = props.directory
    if (!directory) return
    const out = abbreviateHome(directory, paths.home)
    const branch = directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    if (branch) return out + ":" + branch
    return out
  })

  return <Show when={dir()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
}

function Mcp(props: { api: TuiPluginApi; directory?: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi; directory?: string }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi; directory?: string }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} directory={props.directory} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer(_ctx, props) {
        return <View api={api} directory={props.directory} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id,
  tui,
}

export default plugin
