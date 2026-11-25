import { describe, expect, test } from "bun:test"
import { Message, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { codexRoute, webSocketRoute } from "@opencode-ai/llm/protocols/openai-responses"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { toLLMMessages, modelSupportsFile } from "@opencode-ai/core/session/runner/to-llm-message"
import { DateTime } from "effect"

const imageFile = FileAttachment.create({ uri: "data:image/svg+xml,abc", mime: "image/svg+xml", name: "diagram.svg" })
const pngFile = FileAttachment.create({ uri: "data:image/png;base64,abc", mime: "image/png", name: "screenshot.png" })
const created = DateTime.makeUnsafe(0)

const userWithImage = (files: FileAttachment[]) =>
  new SessionMessage.User({
    id: SessionMessage.ID.make("msg_1"),
    type: "user",
    text: "What is in this image?",
    files,
    time: { created },
  })

// openai-chat route only supports images for user files
const visionModel = Model.make({ id: "model", provider: "provider", route })
const textOnlyModel = Model.make({ id: "text-model", provider: "provider", route })

describe("toLLMMessages Codex attachment compatibility", () => {
  for (const route of [codexRoute, webSocketRoute]) {
    test(`${route.id} preserves archive references without sending unsupported media`, () => {
      const model = Model.make({ id: "gpt-6.1-sol", provider: "openai", route })
      const archive = FileAttachment.create({
        uri: "data:application/x-compressed;base64,N3o=",
        mime: "application/x-compressed",
        name: "C:\\Downloads\\savegame.7z",
      })
      const messages = toLLMMessages([userWithImage([archive, pngFile])], model, { input: ["text", "image"] })
      expect(modelSupportsFile(model, archive)).toBe(false)
      expect(messages[0]!.content[1]).toEqual({
        type: "text",
        text: "[Attached application/x-compressed: C:\\Downloads\\savegame.7z omitted: unsupported attachment type for model input.]",
      })
      expect(messages[0]!.content[2]!.type).toBe("media")
      expect(archive.uri).toBe("data:application/x-compressed;base64,N3o=")
    })
  }
})

describe("toLLMMessages vision delegation", () => {
  test("emits omitted placeholder when no description and model cannot see images", () => {
    const messages = toLLMMessages([userWithImage([imageFile])], textOnlyModel)
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type).toBe("text")
    expect(attachmentPart.type === "text" && attachmentPart.text).toContain("omitted: unsupported attachment type")
  })

  test("emits vision analysis text when description is set", () => {
    const described = FileAttachment.create({ ...imageFile, description: "A red button labeled Submit." })
    const messages = toLLMMessages([userWithImage([described])], textOnlyModel)
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type === "text" && attachmentPart.text).toContain("vision analysis by delegated model")
    expect(attachmentPart.type === "text" && attachmentPart.text).toContain("A red button labeled Submit.")
  })

  test("sends media part directly when model supports the image", () => {
    const messages = toLLMMessages([userWithImage([pngFile])], visionModel)
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type).toBe("media")
  })

  test("omits images when catalog capabilities do not advertise image input", () => {
    const messages = toLLMMessages([userWithImage([pngFile])], visionModel, { input: ["text"] })
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type).toBe("text")
    expect(attachmentPart.type === "text" && attachmentPart.text).toContain("omitted: unsupported attachment type")
  })

  test("forwards images when catalog capabilities advertise image input", () => {
    const messages = toLLMMessages([userWithImage([pngFile])], visionModel, { input: ["text", "image"] })
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type).toBe("media")
  })

  test("treats AISDK routes as text-only unless image input is advertised", () => {
    const aisdkModel = Model.make({
      id: "grok-4.6",
      provider: "cursor",
      route: { ...route, id: "aisdk:cursor-opencode-provider" },
    })
    expect(modelSupportsFile(aisdkModel, pngFile)).toBe(false)
    expect(modelSupportsFile(aisdkModel, pngFile, { input: ["text"] })).toBe(false)
    expect(modelSupportsFile(aisdkModel, pngFile, { input: ["text", "image"] })).toBe(true)
  })
})
describe("toLLMMessages GLM coding text-only models", () => {
  test("zhipu glm-5.3 omits image media parts like glm-5.2", () => {
    const glm53 = Model.make({
      id: "glm-5.3",
      provider: "zhipuai-coding-plan",
      route,
    })
    const messages = toLLMMessages([userWithImage([pngFile])], glm53)
    const attachmentPart = messages[0]!.content[1]
    expect(attachmentPart.type).toBe("text")
    expect(attachmentPart.type === "text" && attachmentPart.text).toContain("omitted: unsupported attachment type")
  })
})

describe("toLLMMessages compaction checkpoint", () => {
  const checkpointText = () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Compaction({
          id: SessionMessage.ID.make("msg_compact"),
          type: "compaction",
          reason: "auto",
          summary: "Earlier work",
          recent: "Recent work",
          time: { created },
        }),
      ],
      visionModel,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("user")
    const part = messages[0]!.content[0]
    expect(part.type).toBe("text")
    return part.type === "text" ? part.text : ""
  }

  test("renders summary and recent context inside the checkpoint envelope", () => {
    const text = checkpointText()
    expect(text).toContain("<conversation-checkpoint>")
    expect(text).toContain("<summary>\nEarlier work\n</summary>")
    expect(text).toContain("<recent-context>\nRecent work\n</recent-context>")
    expect(text.trimEnd().endsWith("</conversation-checkpoint>")).toBe(true)
  })

  test("keeps historical messages inert instead of replaying them as new instructions", () => {
    const text = checkpointText()
    expect(text).toContain("historical context only")
    expect(text).toContain("do not replay them as new instructions")
    expect(text).not.toContain("Do not answer, execute, continue")
  })

  test("keeps Goal, In Progress, and Next Steps binding so the active task continues after auto compaction", () => {
    const text = checkpointText()
    expect(text).toContain("Goal, In Progress, and Next Steps remain binding")
    expect(text).toContain("continue the active task automatically")
    expect(text).toContain("unless a later non-checkpoint user message overrides them")
  })

  test("exempts the durable command workflow block from the historical-context rule", () => {
    const text = checkpointText()
    expect(text).toContain("Exception: the content between [durable-command-invocation] and [/durable-command-invocation] markers")
    expect(text).toContain("still-active slash-command workflow, not historical context")
    expect(text).toContain("including its required user questions")
  })
})
