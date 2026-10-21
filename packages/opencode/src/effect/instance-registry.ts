export type DisposeReason = "dispose" | "reload" | "all"

const disposers = new Set<(directory: string, reason: DisposeReason) => Promise<void>>()

export function registerDisposer(disposer: (directory: string, reason: DisposeReason) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string, reason: DisposeReason = "dispose") {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory, reason)))
}
