import { getStore } from "./store"
import { BROWSER_AUTOMATION_ENABLED_KEY } from "./store-keys"

export function getBrowserAutomationEnabled() {
  return getStore().get(BROWSER_AUTOMATION_ENABLED_KEY) !== false
}

export function setBrowserAutomationEnabled(enabled: boolean) {
  getStore().set(BROWSER_AUTOMATION_ENABLED_KEY, enabled)
}
