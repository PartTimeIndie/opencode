import { expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createServerEventQueue, type SyncServerEvent } from "./server-sdk"

const delta = (text: string): Event => ({
  id: `evt_delta_${text}`,
  type: "session.next.text.delta",
  properties: { sessionID: "ses", assistantMessageID: "msg", textID: "text", timestamp: 1, delta: text },
})
const ended = {
  id: "evt_sync_end",
  type: "sync",
  syncEvent: { id: "evt_end", aggregateID: "ses", seq: 6, type: "session.next.text.ended.1", data: { sessionID: "ses", assistantMessageID: "msg", textID: "text", timestamp: 2, text: "Guten Tag." } },
} satisfies SyncServerEvent

test("delivers buffered text before its durable final snapshot without duplicating the answer", () => {
  let text = ""
  const order: string[] = []
  const queue = createServerEventQueue({
    signal: new AbortController().signal,
    emit(_, event) {
      if (event.type !== "session.next.text.delta") return
      order.push("delta")
      text += event.properties.delta
    },
    sync(_, event) {
      order.push("ended")
      text = (event.syncEvent.data as { text: string }).text
    },
  })
  try {
    queue.push("C:/Repo", delta("Guten "))
    queue.push("C:/Repo", delta("Tag."))
    queue.push("C:/Repo", ended)
    queue.flush()
    expect(text).toBe("Guten Tag.")
    expect(order).toEqual(["delta", "ended"])
  } finally {
    queue.discard()
  }
})

test("durable boundaries stay behind queued events across the flush budget and are discarded on cleanup", () => {
  const order: string[] = []
  const queue = createServerEventQueue({
    signal: new AbortController().signal,
    emit(_, event) { order.push(event.id!) },
    sync(_, event) { order.push(event.syncEvent.id) },
  })
  try {
    for (let index = 0; index < 80; index++) queue.push("C:/Repo", { ...delta("x"), id: `evt_${index}`, properties: { ...delta("x").properties, textID: `text_${index}` } } as Event)
    queue.push("C:/Repo", ended)
    expect(order).toEqual([])
    // The production queue intentionally limits each flush to 64 events / 8ms.
    for (let index = 0; index < 81 && order.length < 81; index++) queue.flush()
    expect(order).toEqual([...Array.from({ length: 80 }, (_, index) => `evt_${index}`), "evt_end"])
    queue.push("C:/Repo", { ...ended, id: "evt_sync_discarded", syncEvent: { ...ended.syncEvent, id: "evt_discarded" } })
    queue.discard()
    queue.flush()
    expect(order).toHaveLength(81)
  } finally {
    queue.discard()
  }
})
