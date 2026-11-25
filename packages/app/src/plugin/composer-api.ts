import type { AppPluginApi } from "@opencode-ai/plugin/app"
import { composerRegistry } from "./composer-registry"
import { composerSendIntents } from "./composer-send-intent"

type Composer = AppPluginApi["host"]["composer"]

export function createComposerApi(input: {
  serverID: string
  currentServer(): string
  active(): boolean
  signal: AbortSignal
  track(dispose: () => void): () => void
  insertText: Composer["insertText"]
  submitText: Composer["submitText"]
}, registry = composerRegistry): Composer {
  const available = () => input.active() && !input.signal.aborted && input.serverID === input.currentServer()
  return {
    registerSendPreparation(target, preparation) {
      if (!available()) return () => {}
      return input.track(composerSendIntents.register({ ...target, serverID: input.serverID }, preparation, input.signal))
    },
    read(target) {
      if (!available()) return
      return registry.read({ ...target, serverID: input.serverID })
    },
    change(target) {
      if (!available()) return { ok: false, error: "Composer is not available" }
      return registry.change({ ...target, serverID: input.serverID })
    },
    beforeSubmit(target, handler) {
      if (!available()) return () => {}
      return input.track(registry.beforeSubmit({ ...target, serverID: input.serverID }, handler, input.signal))
    },
    insertText(target) {
      if (!available()) return Promise.resolve({ ok: false, error: "The composer server is no longer active" })
      return input.insertText(target)
    },
    submitText(target) {
      if (!available()) return Promise.resolve({ ok: false, error: "The composer server is no longer active" })
      return input.submitText(target)
    },
  }
}
