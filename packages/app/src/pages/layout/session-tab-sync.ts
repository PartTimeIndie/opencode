import type { ServerSync } from "@/context/server-sync"

export function selectSessionTabSync(input: {
  context: ServerSync
  injected?: ServerSync
}) {
  return input.injected ?? input.context
}

export function selectSessionTabStore(input: {
  directory: string
  sync: Pick<ServerSync, "existing" | "peek">
}) {
  return input.sync.existing(input.directory)?.[0] ?? input.sync.peek(input.directory, { bootstrap: false })[0]
}
