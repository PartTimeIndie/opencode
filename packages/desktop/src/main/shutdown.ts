export function createShutdownCoordinator(input: {
  cleanup: () => Promise<void>
  onCleanupError: (error: unknown) => void
}) {
  let completion: Promise<void> | undefined

  return {
    request(onComplete: () => void) {
      if (completion) return completion
      completion = Promise.resolve()
        .then(input.cleanup)
        .then(onComplete)
        .catch((error) => {
          // An unconfirmed sidecar exit must not become a parent-process kill.
          completion = undefined
          input.onCleanupError(error)
        })
      return completion
    },
  }
}
