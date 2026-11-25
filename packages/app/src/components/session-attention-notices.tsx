import { For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useServer } from "@/context/server"
import { useSessionAttention } from "@/context/session-attention"
import { useLanguage } from "@/context/language"

/** App-level, nonmodal reminder; it never steals focus from the active composer. */
export function SessionAttentionNotices() {
  const attention = useSessionAttention()
  const language = useLanguage()
  const server = useServer()
  const navigate = useNavigate()
  const pending = () => Object.entries(attention.entries()).flatMap(([key, entry]) => {
    if (!attention.enabled() || !key.startsWith(`${server.key}\n`) || !entry.enabled || !entry.directory) return []
    const target = { directory: entry.directory, sessionID: key.slice(key.lastIndexOf("\n") + 1) }
    if (attention.visible(target) || (!entry.count && !attention.question(target))) return []
    return [{ target, entry, question: attention.question(target) }]
  })
  return <Show when={pending().length > 0}>
    <aside aria-label={language.t("session.attention.title")} class="pointer-events-none fixed right-3 top-14 z-40 w-[min(480px,calc(100vw-24px))] rounded-xl border-2 border-border-strong bg-background-stronger p-3 shadow-xl">
      <div class="pointer-events-auto max-h-[40vh] overflow-y-auto">
        <div class="mb-2 text-14-medium">{language.t("session.attention.notices", { count: pending().length })}</div>
        <For each={pending()}>{({ target, entry, question }) => <div class="border-t border-border-weak-base py-2" data-session-attention={target.sessionID}>
          <div class="text-13-medium break-words">{entry.title}</div>
          <div class="text-12-regular text-text-muted">{question ? language.t("session.attention.question") : language.t(entry.error ? "session.attention.error" : "session.attention.completed")}{question && entry.count === 1 ? ` · ${language.t("session.attention.oneResult")}` : entry.count > 1 ? ` · ${language.t("session.attention.count", { count: entry.count })}` : ""}{entry.working && !question ? ` · ${language.t("session.attention.working")}` : ""}</div>
          <div class="mt-2 flex gap-3">
            <button type="button" class="text-12-medium text-text-interactive" onClick={() => navigate(`/${base64Encode(target.directory)}/session/${target.sessionID}`)}>{language.t("session.attention.open")}</button>
            <Show when={entry.count}><button type="button" class="text-12-medium text-text-muted" onClick={() => attention.acknowledge(target)}>{language.t("session.attention.seen")}</button></Show>
          </div>
        </div>}</For>
      </div>
    </aside>
  </Show>
}
