import { useServerSync } from "@/context/server-sync"
import { useSessionRoute } from "@/context/session-route"
import { decode64 } from "@/utils/base64"
import { createMemo } from "solid-js"
import { popularProviderSet, popularProviders, sortProviderList } from "./provider-ordering"

export { popularProviders }

export function useProviders() {
  const serverSync = useServerSync()
  const params = useSessionRoute()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = serverSync().child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return serverSync().data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => sortProviderList(Array.from(providers().all.values()).filter((p) => popularProviderSet.has(p.id))),
    connected: () => {
      const connected = new Set(providers().connected)
      return sortProviderList(Array.from(providers().all.values()).filter((p) => connected.has(p.id)))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return sortProviderList(
        Array.from(providers().all.values()).filter(
          (p) => connected.has(p.id) && (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
        ),
      )
    },
  }
}
