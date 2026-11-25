import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "./platform"
import { createWebDockStore } from "./web-dock-store"

export const { use: useWebDocks, provider: WebDocksProvider } = createSimpleContext({
  name: "WebDocks",
  gate: false,
  init: () => createWebDockStore(usePlatform()),
})
