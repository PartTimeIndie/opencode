export function createHashNavigationGate() {
  let appliedSessionKey = ""
  return {
    shouldApply(hash: string, sessionKey: string) {
      // A present hash is an explicit navigation target and applies on every change.
      // Without one, only a session change needs the initial bottom anchor; ready
      // flips from background reloads must not yank the viewport.
      const apply = !!hash || sessionKey !== appliedSessionKey
      appliedSessionKey = sessionKey
      return apply
    },
  }
}
