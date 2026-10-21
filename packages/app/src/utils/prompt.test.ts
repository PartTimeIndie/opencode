import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("ignores legacy appended slash command content", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please use /effect here",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "text_2",
        type: "text",
        text: "\n\n/effect:\nFull skill description that is longer than the prompt",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toEqual([
      { type: "text", content: "please use /effect here", start: 0, end: 23 },
    ])
  })

  test("restores only the visible slash command text", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "/init",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "text_2",
        type: "text",
        text: "\n\n/init:\nLong generated command prompt body that was not visible in chat.",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toEqual([{ type: "text", content: "/init", start: 0, end: 5 }])
  })

  test("ignores normalized slash command bodies without leading blank lines", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "/init",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "text_2",
        type: "text",
        text: "/init:\nLong generated command prompt body that was not visible in chat.",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toEqual([{ type: "text", content: "/init", start: 0, end: 5 }])
  })

  test("trims appended slash command bodies from combined text parts", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "/init\n\n/init:\nLong generated command prompt body that was not visible in chat.",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toEqual([{ type: "text", content: "/init", start: 0, end: 5 }])
  })

  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })

  test("restores source-backed attachments as file references", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check this",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "file:///C:/Temp/img.png",
        filename: "C:\\Temp\\img.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toMatchObject([
      { type: "text", content: "check this" },
      { type: "image", filename: "C:\\Temp\\img.png", sourcePath: "C:/Temp/img.png", mime: "image/png" },
    ])
  })
})
