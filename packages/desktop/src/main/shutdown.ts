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
        .catch((error) => input.onCleanupError(error))
        .then(onComplete)
        .catch((error) => input.onCleanupError(error))
      return completion
    },
  }
}
