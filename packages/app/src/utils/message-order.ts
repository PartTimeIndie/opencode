type TimedMessage = { id: string; time: { created: number } }

// Message IDs from different generators are not a chronological ordering.
export function compareMessageTime(a: TimedMessage, b: TimedMessage) {
  return a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function latestMessage<T extends TimedMessage>(messages: readonly T[]) {
  return messages.reduce<T | undefined>(
    (latest, message) => (!latest || compareMessageTime(latest, message) < 0 ? message : latest),
    undefined,
  )
}

export function didMessageTailAdvance(previous: TimedMessage | undefined, next: TimedMessage | undefined) {
  if (!previous || !next) return false
  return compareMessageTime(previous, next) < 0
}
