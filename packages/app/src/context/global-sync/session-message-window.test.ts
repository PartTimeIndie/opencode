import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, SessionMessage } from "@opencode-ai/sdk/v2/client"
import { adaptSessionMessages } from "./session-message-adapter"
import { dropMessageParts, mergePartsPreservingText, windowRawSessionMessages, windowSessionMessages } from "./session-message-window"

const message = (id: number) => ({
  id: `msg_${String(id).padStart(3, "0")}`,
  sessionID: "ses_1",
  role: "user",
  time: { created: id },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt" },
}) as Message

const part = (id: string, messageID: string) => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text: id,
}) as Part

const assistant = (id: number, parentID: string) => ({
  id: `msg_${String(id).padStart(3, "0")}`,
  sessionID: "ses_1",
  role: "assistant",
  parentID,
  time: { created: id },
  path: { cwd: "", root: "" },
  modelID: "gpt",
  providerID: "openai",
  mode: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}) as AssistantMessage

describe("session message window", () => {
  test.each(["replace", "prepend"] as const)("raw %s bounds more than 900 V2 rows by chronology while preserving ID indexing", (mode) => {
    const messages: SessionMessage[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `msg_06_${String(1000 - index).padStart(4, "0")}`,
      type: "user",
      time: { created: 1788544435744 + index },
      text: `Review turn ${index}`,
    }))
    const root: SessionMessage = {
      id: "msg_80daf1f1f62f000994c26e3603",
      type: "user",
      time: { created: 1788418804026 },
      text: "Start the morning review",
    }
    const result = windowRawSessionMessages([root, ...messages], mode)
    const expected = mode === "replace"
      ? messages.slice(-900)
      : [root, ...messages.slice(0, 449), ...messages.slice(-450)]

    expect(result.map((item) => item.id)).toEqual(expected.map((item) => item.id).sort())
    expect(result).toHaveLength(900)
    expect(result).toContain(messages.at(-1)!)
    expect(messages).toHaveLength(1000)
  })

  test.each(["replace", "append"] as const)("%s keeps chronological recent turns with mixed ID generations", (mode) => {
    const messages = Array.from({ length: 180 }, (_, index) => ({
      ...message(index),
      id: `msg_06_${String(180 - index).padStart(3, "0")}`,
      time: { created: 1788544435744 + index },
    }))
    const root = { ...message(0), id: "msg_80daf1f1f62f000994c26e3603", time: { created: 1788418804026 } }
    const result = windowSessionMessages([root, ...messages], { limit: 20, mode })
    const ids = result.messages.map((item) => item.id)

    expect(ids).toEqual(messages.slice(-20).map((item) => item.id).sort())
    expect(result.dropped).toContain(root.id)
    expect(ids).toEqual([...ids].sort())
  })

  test("prepend retains chronological history and recent edges with protected assistant companions", () => {
    const messages = Array.from({ length: 180 }, (_, index) => ({
      ...message(index),
      id: `msg_06_${String(180 - index).padStart(3, "0")}`,
      time: { created: 1788544435744 + index },
    }))
    const root = { ...message(0), id: "msg_80daf1f1f62f000994c26e3603", time: { created: 1788418804026 } }
    const protectedParent = messages[90]!
    const companion = {
      ...assistant(500, protectedParent.id),
      id: "msg_07_protected_assistant",
      time: { created: protectedParent.time.created + 0.5 },
    }
    const result = windowSessionMessages([root, ...messages, companion], {
      limit: 20,
      edge: 10,
      mode: "prepend",
      protect: [protectedParent.id],
    })

    expect(result.messages.map((item) => item.id)).toEqual([
      root.id,
      ...messages.slice(0, 9).map((item) => item.id),
      ...messages.slice(-10).map((item) => item.id),
      protectedParent.id,
      companion.id,
    ].sort())
    expect(result.dropped).not.toContain(protectedParent.id)
    expect(result.dropped).not.toContain(companion.id)
  })

  test("replace mode keeps the latest bounded messages", () => {
    const result = windowSessionMessages(Array.from({ length: 8 }, (_, index) => message(index + 1)), { limit: 4 })

    expect(result.messages.map((item) => item.id)).toEqual(["msg_005", "msg_006", "msg_007", "msg_008"])
    expect(result.dropped).toEqual(["msg_001", "msg_002", "msg_003", "msg_004"])
  })

  test("prepend mode keeps old and latest edges", () => {
    const result = windowSessionMessages(Array.from({ length: 10 }, (_, index) => message(index + 1)), {
      limit: 6,
      edge: 3,
      mode: "prepend",
    })

    expect(result.messages.map((item) => item.id)).toEqual([
      "msg_001",
      "msg_002",
      "msg_003",
      "msg_008",
      "msg_009",
      "msg_010",
    ])
    expect(result.dropped).toEqual(["msg_004", "msg_005", "msg_006", "msg_007"])
  })

  test("keeps assistant and parent companions across a window boundary", () => {
    const parent = message(2)
    const result = windowSessionMessages([message(1), parent, assistant(3, parent.id), message(4)], {
      limit: 2,
    })

    expect(result.messages.map((item) => item.id)).toEqual(["msg_002", "msg_003", "msg_004"])
    expect(result.dropped).toEqual(["msg_001"])
  })

  test("keeps assistant companions for protected parent messages", () => {
    const parent = message(2)
    const result = windowSessionMessages([message(1), parent, assistant(3, parent.id), message(4), message(5)], {
      limit: 2,
      protect: [parent.id],
    })

    expect(result.messages.map((item) => item.id)).toEqual(["msg_002", "msg_003", "msg_004", "msg_005"])
    expect(result.dropped).toEqual(["msg_001"])
  })

  test("dropMessageParts clears parts and accumulated deltas", () => {
    const store = {
      message: {},
      part: { msg_001: [part("part_1", "msg_001")] },
      part_text_accum_delta: { part_1: "stream" },
    }

    dropMessageParts(store, ["msg_001"])

    expect(store.part.msg_001).toBeUndefined()
    expect(store.part_text_accum_delta.part_1).toBeUndefined()
  })

  test("mergePartsPreservingText keeps accumulated text over stale snapshots", () => {
    const merged = mergePartsPreservingText(
      [{ ...part("part_1", "msg_001"), text: "visible streamed text" } as Part],
      [{ ...part("part_1", "msg_001"), text: "visible" } as Part],
      { part_1: "visible streamed text" },
    )

    expect((merged[0] as Extract<Part, { type: "text" }>).text).toBe("visible streamed text")
  })

  test("reconciles clipboard aliases with V2 file slots before and after optimistic confirmation", () => {
    const files = [
      { uri: "attachment://att_red", mime: "image/png", name: "image.png" },
      { uri: "attachment://att_blue", mime: "image/png", name: "image.png" },
    ]
    const projected = adaptSessionMessages("ses_1", [{
      id: "msg_001", type: "user", time: { created: 1 }, text: "Two images", files,
    }]).parts[0]!.part
    const aliases: Part[] = files.map((file, index) => ({
      id: `prt_clipboard_${index}`, sessionID: "ses_1", messageID: "msg_001", type: "file",
      mime: file.mime, filename: file.name, url: `data:image/png;base64,${index}`,
    }))
    const merged = mergePartsPreservingText(aliases, projected, {})
    expect(merged.filter((part) => part.type === "file")).toEqual(projected.filter((part) => part.type === "file"))
    expect(mergePartsPreservingText(merged, aliases, {})).toEqual(merged)
    expect(mergePartsPreservingText([...merged, ...aliases], projected, {})).toEqual(merged)
  })

  test("keeps distinct V2 file slots even when their names and URLs match", () => {
    const file = { uri: "attachment://att_1", mime: "image/png", name: "image.png" }
    const projected = adaptSessionMessages("ses_1", [{
      id: "msg_001", type: "user", time: { created: 1 }, text: "Two files", files: [file, file],
    }]).parts[0]!.part
    expect(mergePartsPreservingText([], projected, {}).filter((part) => part.type === "file")).toHaveLength(2)
  })

  test("preserves legacy-only files and files from other messages", () => {
    const file: Part = {
      id: "prt_clipboard", sessionID: "ses_1", messageID: "msg_001", type: "file",
      mime: "image/png", filename: "image.png", url: "data:image/png;base64,AA==",
    }
    const other = { ...file, id: "msg_002:file:0", messageID: "msg_002" }
    const malformed = { ...file, id: "msg_001:file:invalid" }
    expect(mergePartsPreservingText([file], [other, malformed], {})).toHaveLength(3)
    expect(mergePartsPreservingText([], [file], {})).toEqual([file])
  })

  test("uses V2 slots rather than guessing extra files from unmatched compatibility aliases", () => {
    const first: Part = {
      id: "msg_001:file:0", sessionID: "ses_1", messageID: "msg_001", type: "file",
      mime: "image/png", filename: "image.png", url: "attachment://att_1",
    }
    const alias = { ...first, id: "prt_alias", filename: "renamed.png", url: "data:image/png;base64,AA==" }
    expect(mergePartsPreservingText([first], [alias], {})).toEqual([first])
    const second = { ...first, id: "msg_001:file:1", url: "attachment://att_2" }
    expect(mergePartsPreservingText([first, second], [first], {})).toEqual([first, second])
    expect(mergePartsPreservingText([first], [second], {})).toEqual([first, second])
  })

  test("mergePartsPreservingText accepts snapshots that catch up", () => {
    const merged = mergePartsPreservingText(
      [{ ...part("part_1", "msg_001"), text: "visible streamed text" } as Part],
      [{ ...part("part_1", "msg_001"), text: "visible streamed text done" } as Part],
      { part_1: "visible streamed text" },
    )

    expect((merged[0] as Extract<Part, { type: "text" }>).text).toBe("visible streamed text done")
  })

  test("mergePartsPreservingText drops a divergent stale accum snippet", () => {
    const merged = mergePartsPreservingText(
      [{ ...part("part_1", "msg_001"), text: "Docker bleibt ein Blocker." } as Part],
      [{ ...part("part_1", "msg_001"), text: "Docker bleibt ein Blocker." } as Part],
      { part_1: "Loading messages..." },
    )

    expect((merged[0] as Extract<Part, { type: "text" }>).text).toBe("Docker bleibt ein Blocker.")
  })
})
