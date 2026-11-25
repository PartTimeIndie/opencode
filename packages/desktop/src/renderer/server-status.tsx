import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { serverStateLabel, type ServerState } from "../preload/server-state"

export function ServerStatus() {
  const [state, setState] = createSignal<ServerState>({ phase: "starting", attempt: 0 })
  const [error, setError] = createSignal<string>()
  onMount(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void window.api.serverStatus.subscribe(setState).then((stop) => {
      if (disposed) stop()
      else unsubscribe = stop
    }).catch(() => setError("Serverstatus konnte nicht geladen werden."))
    onCleanup(() => { disposed = true; unsubscribe?.() })
  })
  return <Show when={state().phase !== "healthy" || error()}>
    <div role="status" aria-live="polite" class="fixed bottom-4 left-4 right-4 z-50 flex items-center gap-3 rounded-md border border-border-base bg-background-base p-3 text-text-base shadow-lg">
      <span class="flex-1 text-12-regular">{error() ?? serverStateLabel(state())}</span>
      <Show when={state().phase === "exhausted"}>
        <Button onClick={() => {
          setError(undefined)
          void window.api.serverStatus.retry().catch(() => setError("Erneuter Serverstart konnte nicht angefordert werden."))
        }}>Server erneut starten</Button>
      </Show>
    </div>
  </Show>
}
