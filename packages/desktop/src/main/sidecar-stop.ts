// A deadline reports uncertainty; it is never authority to kill a live writer.
export function createSidecarStop(input: {
  requestStop: () => void
  exited: Promise<number>
  isExited: () => boolean
  timeoutMs?: number
}) {
  let stopping: Promise<void> | undefined
  return () => {
    if (stopping) return stopping
    stopping = (async () => {
      if (input.isExited()) return
      input.requestStop()
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          input.exited,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("Sidecar exit unconfirmed; shutdown and replacement blocked")), input.timeoutMs ?? 12_000)
          }),
        ])
      } finally { clearTimeout(deadline) }
    })().catch((error) => {
      stopping = undefined
      throw error
    })
    return stopping
  }
}

// Only called after the desktop main process obtains explicit user consent.
export async function forceSidecarStop(input: {
  kill: () => void
  exited: Promise<number>
  isExited: () => boolean
  timeoutMs?: number
}) {
  if (input.isExited()) return
  input.kill()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      input.exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Forced sidecar exit unconfirmed")), input.timeoutMs ?? 12_000)
      }),
    ])
  } finally {
    clearTimeout(deadline)
  }
}
