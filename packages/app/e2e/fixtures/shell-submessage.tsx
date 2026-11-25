import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ShellSubmessage } from "@opencode-ai/ui/shell-submessage"
import "@opencode-ai/ui/styles"

export function mount(element: HTMLElement) {
  return render(() => {
    const [visible, setVisible] = createSignal(false)
    return (
      <main style={{ padding: "24px" }}>
        <h1>Tool update lifecycle</h1>
        <button onClick={() => setVisible(true)}>Show tool update</button>
        <button onClick={() => setVisible(false)}>Switch away</button>
        <div role="status">{visible() ? "Tool view open" : "Tool view closed"}</div>
        <Show when={visible()}>
          <ShellSubmessage text="Explored 4 reads, 2 searches" animate />
        </Show>
      </main>
    )
  }, element)
}
