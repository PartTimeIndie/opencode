export function collectDeepLinkArgs(argv: readonly string[]) {
  return argv.filter((arg) => arg.startsWith("opencode://"))
}

export function createDeepLinkDelivery(initial: readonly string[] = []) {
  const state = {
    pending: [...initial],
    ready: false,
  }

  const emit = (urls: readonly string[], deliver: (urls: string[]) => void) => {
    if (urls.length === 0) return
    if (state.ready) {
      deliver([...urls])
      return
    }
    state.pending.push(...urls)
  }

  const consume = () => {
    state.ready = true
    return state.pending.splice(0)
  }

  const suspend = () => {
    state.ready = false
  }

  return { emit, consume, suspend }
}
