import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { resolveFileDiff } from "@opencode-ai/ui/session-diff"

export function OnDemandDiff(props: { filePath?: string; before?: string; after?: string }) {
  const fileComponent = useFileComponent()
  const file = () => props.filePath?.trim() || "diff"
  const before = () => props.before ?? ""
  const after = () => props.after ?? ""
  const hasContent = () => before().length > 0 || after().length > 0
  const fileDiff = createMemo(() => resolveFileDiff({ file: file(), before: before(), after: after() }))

  return (
    <div data-slot="on-demand-diff">
      <div data-slot="on-demand-diff-head">
        <span data-slot="on-demand-diff-title">{file()}</span>
        <span data-slot="on-demand-diff-meta">Before / After</span>
      </div>
      <Show when={hasContent()} fallback={<div data-slot="on-demand-diff-empty">No diff content</div>}>
        <div data-slot="on-demand-diff-view" data-scrollable>
          <Dynamic
            component={fileComponent}
            mode="diff"
            fileDiff={fileDiff()}
            diffStyle="split"
            virtualize={false}
            hunkSeparators={fileDiff().isPartial ? "simple" : "line-info-basic"}
          />
        </div>
      </Show>
    </div>
  )
}
