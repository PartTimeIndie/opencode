import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage } from "./sync"

type Text = Extract<Part, { type: "text" }>
type File = Extract<Part, { type: "file" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

const filePart = (id: string, sessionID: string, messageID: string, url: string): File => ({
  id,
  sessionID,
  messageID,
  type: "file",
  mime: "image/png",
  filename: "image.png",
  url,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticAdd replaces an existing message id instead of duplicating it", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID)] },
      part: { msg_1: [textPart("prt_old", sessionID, "msg_1")] } as Record<string, Part[] | undefined>,
    }
    const replacement = { ...userMessage("msg_1", sessionID), time: { created: 2 } }

    applyOptimisticAdd(draft, {
      sessionID,
      message: replacement,
      parts: [textPart("prt_new", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]).toEqual([replacement])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_new"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("mergeOptimisticPage reconciles an authoritative attachment with its optimistic data URL", () => {
    const sessionID = "ses_1"
    const messageID = "msg_2"
    const page = mergeOptimisticPage(
      {
        session: [userMessage(messageID, sessionID)],
        part: [
          {
            id: messageID,
            part: [
              { ...textPart(`${messageID}:text`, sessionID, messageID), text: "What is shown?" },
              filePart(`${messageID}:file:0`, sessionID, messageID, "attachment://att_1"),
            ],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage(messageID, sessionID),
          parts: [
            { ...textPart("part_1", sessionID, messageID), text: "What is shown?" },
            filePart("part_2", sessionID, messageID, "data:image/png;base64,aGVsbG8="),
          ],
        },
      ],
    )

    expect(page.confirmed).toEqual([messageID])
    expect(page.part.find((item) => item.id === messageID)?.part).toHaveLength(2)
    expect(page.part.find((item) => item.id === messageID)?.part.filter((part) => part.type === "file")).toEqual([
      expect.objectContaining({ id: `${messageID}:file:0`, url: "attachment://att_1" }),
    ])
  })

  test("mergeOptimisticPage consumes each authoritative attachment only once", () => {
    const sessionID = "ses_1"
    const messageID = "msg_2"
    const page = mergeOptimisticPage(
      {
        session: [userMessage(messageID, sessionID)],
        part: [
          {
            id: messageID,
            part: [filePart(`${messageID}:file:0`, sessionID, messageID, "attachment://att_1")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage(messageID, sessionID),
          parts: [
            filePart("part_1", sessionID, messageID, "data:image/png;base64,b25l"),
            filePart("part_2", sessionID, messageID, "data:image/png;base64,dHdv"),
          ],
        },
      ],
    )

    expect(page.confirmed).toEqual([])
    expect(page.part.find((item) => item.id === messageID)?.part.filter((part) => part.type === "file")).toHaveLength(2)
  })
})
