import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

export interface TodoItemProps {
  theme: TuiThemeCurrent
  status: string
  content: string
}

export function TodoItem(props: TodoItemProps) {
  const theme = props.theme

  return (
    <box flexDirection="row" gap={0}>
      <text
        flexShrink={0}
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        [{props.status === "completed" ? "✓" : props.status === "in_progress" ? "•" : " "}]{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        {props.content}
      </text>
    </box>
  )
}
