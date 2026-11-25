import { ok, strictEqual } from "node:assert/strict"
import { test } from "node:test"
import type { BotMessageEvent, GenericMessageEvent, MessageChangedEvent } from "@slack/bolt"
import { isAllowedSender, senderUserId } from "../src/allow-list"

const userMessage: GenericMessageEvent = {
  type: "message",
  subtype: undefined,
  event_ts: "1700000000.000100",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text: "hello",
  ts: "1700000000.000100",
}

test("senderUserId returns the user of a plain message", () => {
  strictEqual(senderUserId(userMessage), "U1")
})

test("senderUserId is undefined when the event carries no user", () => {
  const botMessage: BotMessageEvent = {
    type: "message",
    subtype: "bot_message",
    event_ts: "1700000000.000200",
    channel: "C1",
    channel_type: "channel",
    text: "beep",
    bot_id: "B1",
    ts: "1700000000.000200",
  }
  const messageChanged: MessageChangedEvent = {
    type: "message",
    subtype: "message_changed",
    event_ts: "1700000000.000300",
    hidden: true,
    channel: "C1",
    channel_type: "channel",
    ts: "1700000000.000300",
    message: userMessage,
    previous_message: userMessage,
  }
  strictEqual(senderUserId(botMessage), undefined)
  strictEqual(senderUserId(messageChanged), undefined)
})

test("an empty allow-list admits everyone, including unknown users", () => {
  ok(isAllowedSender(undefined, []))
  ok(isAllowedSender("U1", []))
})

test("an allow-list rejects unknown and unlisted users", () => {
  ok(!isAllowedSender(undefined, ["U1"]))
  ok(!isAllowedSender("U2", ["U1"]))
})

test("an allow-list admits listed users", () => {
  ok(isAllowedSender("U1", ["U1", "U2"]))
})
