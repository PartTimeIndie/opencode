// A tab or dock can have only one ownership change in flight. Keep the lock
// across IPC awaits; a UI-only disabled state does not protect other callers.
export function createBrowserTransferLock() {
  const pending = new Set<string>()
  return {
    has: (key: string) => pending.has(key),
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      if (pending.has(key)) throw new Error("Browser transfer is already in progress")
      pending.add(key)
      try {
        return await operation()
      } finally {
        pending.delete(key)
      }
    },
  }
}
