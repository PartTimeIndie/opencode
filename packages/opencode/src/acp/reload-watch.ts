const ignoredSegments = new Set(["node_modules", ".git"])
const generatedRoots = new Set(["scheduler", "logs"])

export function shouldReloadPath(
  value: string | Buffer | null,
  options: { readonly generatedRoot?: boolean; readonly prefix?: string } = {},
) {
  const normalized = [options.prefix, value?.toString()]
    .filter((part): part is string => !!part)
    .join("/")
    .replaceAll("\\", "/")
  if (!normalized) return options.generatedRoot !== true
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  if (segments.some((segment) => ignoredSegments.has(segment))) return false
  return options.generatedRoot !== true || !generatedRoots.has(segments[0] ?? "")
}

export function createReloadBatch(input: {
  readonly delay: number
  readonly run: (entries: ReadonlyMap<string, string>) => Promise<void>
  readonly onError: (error: unknown) => void
}) {
  const state = {
    closed: false,
    entries: new Map<string, { readonly reason: string; readonly version: number }>(),
    running: Promise.resolve(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    versions: new Map<string, number>(),
  }

  const clearTimer = () => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  const flush = () => {
    clearTimer()
    if (state.closed || state.entries.size === 0) return state.running
    const entries = new Map(state.entries)
    state.entries.clear()
    state.running = state.running
      .then(async () => {
        if (state.closed) return
        const active = new Map(
          Array.from(entries).flatMap(([directory, entry]) =>
            state.versions.get(directory) === entry.version ? [[directory, entry.reason] as const] : [],
          ),
        )
        if (active.size === 0) return
        await input.run(active)
      })
      .catch((error) => {
        if (!state.closed) input.onError(error)
      })
    return state.running
  }

  const schedule = (directory: string, reason: string) => {
    if (state.closed) return
    const version = (state.versions.get(directory) ?? 0) + 1
    state.versions.set(directory, version)
    state.entries.set(directory, { reason, version })
    clearTimer()
    state.timer = setTimeout(() => {
      state.timer = undefined
      void flush()
    }, input.delay)
    state.timer.unref?.()
  }

  const cancel = (directory: string) => {
    state.versions.set(directory, (state.versions.get(directory) ?? 0) + 1)
    state.entries.delete(directory)
    if (state.entries.size === 0) clearTimer()
  }

  const dispose = async () => {
    if (state.closed) return state.running
    state.closed = true
    state.entries.clear()
    state.versions.clear()
    clearTimer()
    await state.running
  }

  return { schedule, cancel, flush, dispose }
}
