type PendingModule = {
  signal: AbortSignal
  importer: () => Promise<unknown>
  resolve: (value: unknown | undefined) => void
  reject: (reason: unknown) => void
  abort: () => void
}

export function createPluginModuleLoader(concurrency: number) {
  const pending: PendingModule[] = []
  const active = { value: 0 }
  const limit = Math.max(1, concurrency)

  const drain = () => {
    while (active.value < limit) {
      const job = pending.shift()
      if (!job) return
      job.signal.removeEventListener("abort", job.abort)
      if (job.signal.aborted) {
        job.resolve(undefined)
        continue
      }

      active.value += 1
      void Promise.resolve()
        .then(job.importer)
        .then(job.resolve, job.reject)
        .finally(() => {
          active.value -= 1
          drain()
        })
    }
  }

  return {
    load<T>(signal: AbortSignal, importer: () => Promise<T>) {
      if (signal.aborted) return Promise.resolve(undefined)
      return new Promise<T | undefined>((resolve, reject) => {
        const job: PendingModule = {
          signal,
          importer,
          resolve: (value) => resolve(value as T | undefined),
          reject,
          abort: () => {
            const index = pending.indexOf(job)
            if (index === -1) return
            pending.splice(index, 1)
            signal.removeEventListener("abort", job.abort)
            resolve(undefined)
          },
        }
        signal.addEventListener("abort", job.abort, { once: true })
        pending.push(job)
        drain()
      })
    },
  }
}
