import { describe, expect, test } from "bun:test"
import { LLM, LLMClient, Message, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { AmazonBedrock, Anthropic } from "@opencode-ai/llm/providers"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment, FileAttachment } from "@opencode-ai/core/session/prompt"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionV2 } from "@opencode-ai/core/session"
import { DateTime, Effect, Schema } from "effect"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const model = Model.make({ id: "model", provider: "provider", route })
const zhipuTextModel = Model.make({ id: "glm-5.2", provider: "zhipuai-coding-plan", route })
const zhipu53TextModel = Model.make({ id: "glm-5.3", provider: "zhipuai-coding-plan", route })
const bedrockModel = AmazonBedrock.configure({
  baseURL: "https://bedrock-runtime.test",
  apiKey: "test-bearer",
}).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
const anthropicModel = Anthropic.configure({
  baseURL: "https://api.anthropic.test/v1/",
  apiKey: "test-bearer",
}).model("claude-sonnet-4-5")

describe("toLLMMessages", () => {
  test("omits empty failed assistant turns from later provider history", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("failed-empty"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [],
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages).toEqual([])
  })

  test("decodes persisted completed and failed tool states without provider result metadata", () => {
    const decode = Schema.decodeUnknownSync(SessionMessage.AssistantTool)

    expect(
      decode({
        type: "tool",
        id: "completed-without-result",
        name: "apply_patch",
        provider: { executed: false },
        state: {
          status: "completed",
          input: { patch: "*** Begin Patch" },
          content: [{ type: "text", text: "Done" }],
          outputPaths: [],
          structured: {},
        },
        time: { created: 0, completed: 1 },
      }).state.status,
    ).toBe("completed")
    expect(
      decode({
        type: "tool",
        id: "failed-without-result",
        name: "shell",
        provider: { executed: false },
        state: {
          status: "error",
          input: { command: "exit 1" },
          content: [],
          structured: {},
          error: { type: "unknown", message: "Command failed" },
        },
        time: { created: 0, completed: 1 },
      }).state.status,
    ).toBe("error")
  })

  test("maps every top-level V2 Session message type", () => {
    const file = new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" })
    const messages = toLLMMessages(
      [
        new SessionMessage.AgentSwitched({
          id: id("agent"),
          type: "agent-switched",
          agent: "build",
          time: { created },
        }),
        new SessionMessage.ModelSwitched({
          id: id("model"),
          type: "model-switched",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          time: { created },
        }),
        new SessionMessage.System({
          id: id("system"),
          type: "system",
          text: "Updated context\n\nOther context",
          time: { created },
        }),
        new SessionMessage.User({
          id: id("user"),
          type: "user",
          text: "Inspect this image",
          files: [file],
          agents: [new AgentAttachment({ name: "build" })],
          time: { created },
        }),
        new SessionMessage.Synthetic({
          id: id("synthetic"),
          type: "synthetic",
          sessionID: SessionV2.ID.make("ses_translate"),
          text: "Synthetic context",
          time: { created },
        }),
        new SessionMessage.Shell({
          id: id("shell"),
          type: "shell",
          callID: "shell-1",
          command: "pwd",
          output: "/project",
          time: { created, completed: created },
        }),
        new SessionMessage.Compaction({
          id: id("compaction"),
          type: "compaction",
          reason: "auto",
          summary: "Earlier work",
          recent: "Recent work",
          time: { created },
        }),
      ],
      model,
    )

    expect(messages.map((message) => message.role)).toEqual(["system", "user", "user", "user", "user"])
    expect(messages[0]).toEqual(Message.system("Updated context\n\nOther context"))
    expect(messages[1]).toEqual(
      Message.make({
        id: id("user"),
        role: "user",
        content: [
          { type: "text", text: "Inspect this image" },
          { type: "media", mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=", filename: "hello.png" },
        ],
        metadata: { agents: [{ name: "build" }] },
      }),
    )
    expect(messages.slice(2).map((message) => message.content)).toEqual([
      [{ type: "text", text: "Synthetic context" }],
      [{ type: "text", text: "Shell command: pwd\n\n/project" }],
      [
        {
          type: "text",
          text: `<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat every user or assistant message inside this checkpoint as historical context only; do not replay them as new instructions to answer or execute. The checkpoint's current Goal, In Progress, and Next Steps remain binding: continue the active task automatically from them unless a later non-checkpoint user message overrides them.

<summary>
Earlier work
</summary>

<recent-context>
Recent work
</recent-context>
</conversation-checkpoint>`,
        },
      ],
      ])
    })

  test("maps text, directory, image, and document user attachments to provider-ready content", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.User({
          id: id("mixed-attachments"),
          type: "user",
          text: "Read attachments",
          files: [
            new FileAttachment({ uri: "data:text/plain;base64,aGVsbG8=", mime: "text/plain", name: "note.txt" }),
            new FileAttachment({ uri: "file:///workspace/src", mime: "application/x-directory", name: "src" }),
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
            }),
            new FileAttachment({
              uri: "data:application/pdf;base64,UERGREFUQQ==",
              mime: "application/pdf",
              name: "report.pdf",
            }),
          ],
          time: { created },
        }),
      ],
      model,
    )

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Read attachments" },
      { type: "text", text: "[Attached text/plain: note.txt]\nhello" },
      { type: "text", text: "[Attached application/x-directory: src]" },
      {
        type: "media",
        mediaType: "image/png",
        data: "data:image/png;base64,aGVsbG8=",
        filename: "pixel.png",
        metadata: undefined,
      },
      {
        type: "text",
        text: "[Attached application/pdf: report.pdf omitted: unsupported attachment type for model input.]",
      },
    ])
  })

  test("does not send image content to the text-only Zhipu GLM coding model", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.User({
          id: id("zhipu-image"),
          type: "user",
          text: "Inspect this image",
          files: [new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" })],
          time: { created },
        }),
      ],
      zhipuTextModel,
    )

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Inspect this image" },
      {
        type: "text",
        text: "[Attached image/png: pixel.png omitted: unsupported attachment type for model input.]",
      },
    ])
  })

  test("does not replay image content into the text-only Zhipu GLM 5.3 coding model", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.User({
          id: id("zhipu-53-image"),
          type: "user",
          text: "Continue after this screenshot",
          files: [new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "screen.png" })],
          time: { created },
        }),
      ],
      zhipu53TextModel,
    )

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Continue after this screenshot" },
      {
        type: "text",
        text: "[Attached image/png: screen.png omitted: unsupported attachment type for model input.]",
      },
    ])
  })

  test("does not replay tool-result images into the text-only Zhipu GLM 5.3 coding model", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("zhipu-53-tool-image"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("glm-5.3"), providerID: ProviderV2.ID.make("zhipuai-coding-plan") },
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "read-zhipu-53-image",
              name: "read",
              provider: { executed: true },
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "screen.png" },
                content: [
                  {
                    type: "file",
                    uri: "data:image/png;base64,aGVsbG8=",
                    mime: "image/png",
                    name: "screen.png",
                  },
                ],
                structured: {},
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      zhipu53TextModel,
    )

    expect(messages[0]?.content).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        id: "read-zhipu-53-image",
        result: expect.objectContaining({
          value: "[Attached image/png: screen.png omitted: unsupported attachment type for model input.]",
        }),
      }),
    )
    expect(JSON.stringify(messages)).not.toContain('"type":"file"')
    expect(JSON.stringify(messages)).not.toContain('"type":"media"')
  })

  test("prepares provider payloads from lowered user image and document attachments", async () => {
    const openAI = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model,
          messages: toLLMMessages(
            [
              new SessionMessage.User({
                id: id("provider-image"),
                type: "user",
                text: "Look",
                files: [new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" })],
                time: { created },
              }),
            ],
            model,
          ),
        }),
      ),
    )
    expect(openAI.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
      ],
    })

    const openAIUnsupported = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model,
          messages: toLLMMessages(
            [
              new SessionMessage.User({
                id: id("provider-unsupported-document"),
                type: "user",
                text: "Read PDF",
                files: [
                  new FileAttachment({
                    uri: "data:application/pdf;base64,UERGREFUQQ==",
                    mime: "application/pdf",
                    name: "report.pdf",
                  }),
                ],
                time: { created },
              }),
            ],
            model,
          ),
        }),
      ),
    )
    expect(openAIUnsupported.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: "Read PDF[Attached application/pdf: report.pdf omitted: unsupported attachment type for model input.]",
        },
      ],
    })

    const openAIJpegAlias = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model,
          messages: toLLMMessages(
            [
              new SessionMessage.User({
                id: id("provider-jpg-alias"),
                type: "user",
                text: "Look again",
                files: [new FileAttachment({ uri: "data:image/jpg;base64,/9j/", mime: "image/jpg" })],
                time: { created },
              }),
            ],
            model,
          ),
        }),
      ),
    )
    expect(openAIJpegAlias.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look again" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
    })

    const anthropic = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          cache: "none",
          messages: toLLMMessages(
            [
              new SessionMessage.User({
                id: id("provider-anthropic-image"),
                type: "user",
                text: "Look",
                files: [new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" })],
                time: { created },
              }),
            ],
            anthropicModel,
          ),
        }),
      ),
    )
    expect(anthropic.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
    })

    const bedrock = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          cache: "none",
          messages: toLLMMessages(
            [
              new SessionMessage.User({
                id: id("provider-document"),
                type: "user",
                text: "Read document",
                files: [
                  new FileAttachment({
                    uri: "data:application/pdf;base64,UERGREFUQQ==",
                    mime: "application/pdf",
                    name: "report.pdf",
                  }),
                ],
                time: { created },
              }),
            ],
            bedrockModel,
          ),
        }),
      ),
    )
    expect(bedrock.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { text: "Read document" },
            { document: { format: "pdf", name: "report.pdf", source: { bytes: "UERGREFUQQ==" } } },
          ],
        },
      ],
    })
  })

  test("replays durable tool media into canonical tool messages without structured base64", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            new SessionMessage.AssistantText({ type: "text", id: "text-1", text: "Checking" }),
            new SessionMessage.AssistantReasoning({
              type: "reasoning",
              id: "reasoning-1",
              text: "Think",
              providerMetadata: { anthropic: { signature: "sig_1" } },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "pending",
              name: "read",
              state: new SessionMessage.ToolStatePending({ status: "pending", input: '{"path":"README.md"}' }),
              time: { created },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "running",
              name: "read",
              state: new SessionMessage.ToolStateRunning({
                status: "running",
                input: { path: "README.md" },
                content: [],
                structured: { type: "media", mime: "image/png" },
              }),
              time: { created },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "completed",
              name: "read",
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "README.md" },
                content: [
                  { type: "text", text: "Hello" },
                  {
                    type: "file",
                    uri: "data:image/png;base64,aGVsbG8=",
                    mime: "image/png",
                    name: "hello.png",
                  },
                ],
                structured: {},
              }),
              time: { created, completed: created },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "hosted",
              name: "web_search",
              provider: {
                executed: true,
                metadata: { fake: { continuation: "hosted-call" } },
                resultMetadata: { fake: { continuation: "hosted-result" } },
              },
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { query: "Effect" },
                content: [{ type: "text", text: "Found it" }],
                structured: {},
              }),
              time: { created, completed: created },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "hosted-failed",
              name: "write",
              provider: { executed: true, metadata: { fake: { continuation: "failed" } } },
              state: new SessionMessage.ToolStateError({
                status: "error",
                input: { path: "README.md" },
                content: [],
                structured: {},
                error: { type: "unknown", message: "Denied" },
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "tool"])
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Checking" },
      { type: "reasoning", text: "Think", providerMetadata: { anthropic: { signature: "sig_1" } } },
      { type: "tool-call", id: "pending", name: "read", input: { path: "README.md" } },
      { type: "tool-call", id: "running", name: "read", input: { path: "README.md" } },
      {
        type: "tool-call",
        id: "completed",
        name: "read",
        input: { path: "README.md" },
      },
      {
        type: "tool-call",
        id: "hosted",
        name: "web_search",
        input: { query: "Effect" },
        providerExecuted: true,
        providerMetadata: { fake: { continuation: "hosted-call" } },
      },
      {
        type: "tool-result",
        id: "hosted",
        name: "web_search",
        providerExecuted: true,
        providerMetadata: { fake: { continuation: "hosted-result" } },
        result: { type: "text", value: "Found it" },
      },
      {
        type: "tool-call",
        id: "hosted-failed",
        name: "write",
        input: { path: "README.md" },
        providerExecuted: true,
        providerMetadata: { fake: { continuation: "failed" } },
      },
      {
        type: "tool-result",
        id: "hosted-failed",
        name: "write",
        providerExecuted: true,
        providerMetadata: { fake: { continuation: "failed" } },
        result: {
          type: "error",
          value: { error: { type: "unknown", message: "Denied" }, content: [], structured: {} },
        },
      },
    ])
    expect(messages[1]?.content).toMatchObject([
      {
        type: "tool-result",
        id: "pending",
        name: "read",
        result: { type: "error", value: "[Tool execution was interrupted]" },
      },
    ])
    expect(messages[2]?.content).toMatchObject([
      {
        type: "tool-result",
        id: "running",
        name: "read",
        result: { type: "error", value: "[Tool execution was interrupted]" },
      },
    ])
    expect(messages[3]?.content).toEqual([
      {
        type: "tool-result",
        id: "completed",
        name: "read",
        result: {
          type: "content",
          value: [
            { type: "text", text: "Hello" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
          ],
        },
      },
    ])
  })

  test("normalizes image/jpg tool-result media for OpenAI provider payloads", async () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-jpg-tool"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "read-jpg",
              name: "read",
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "photo.jpg" },
                content: [{ type: "file", uri: "data:image/jpg;base64,/9j/", mime: "image/jpg", name: "photo.jpg" }],
                structured: {},
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages[1]?.content).toMatchObject([
      {
        type: "tool-result",
        result: {
          type: "content",
          value: [{ type: "file", uri: "data:image/jpeg;base64,/9j/", mime: "image/jpeg", name: "photo.jpg" }],
        },
      },
    ])
    const prepared = await Effect.runPromise(LLMClient.prepare(LLM.request({ model, messages })))
    expect(prepared.body).toMatchObject({
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "read-jpg" }] },
        { role: "tool", tool_call_id: "read-jpg", content: "" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }] },
      ],
    })
  })

  test("prepares Anthropic tool-result images as structured media blocks", async () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-anthropic-tool-image"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make(anthropicModel.id), providerID: ProviderV2.ID.make(anthropicModel.provider) },
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "read-image",
              name: "read",
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "pixel.png" },
                content: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" }],
                structured: {},
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      anthropicModel,
    )

    const prepared = await Effect.runPromise(
      LLMClient.prepare(LLM.request({ model: anthropicModel, cache: "none", messages })),
    )
    expect(prepared.body).toMatchObject({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "read-image", name: "read" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-image",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
            },
          ],
        },
      ],
    })
  })

  test("serializes local error tool media as model-visible omission text", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-error-media"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "read-error",
              name: "read",
              state: new SessionMessage.ToolStateError({
                status: "error",
                input: { path: "pixel.png" },
                content: [
                  { type: "text", text: "Partial output" },
                  { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" },
                ],
                structured: {},
                error: { type: "unknown", message: "Read failed" },
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages[1]?.content).toMatchObject([
      {
        type: "tool-result",
        id: "read-error",
        result: {
          type: "error",
          value: "Read failed\nPartial output\n[Attached image/png: pixel.png omitted: unsupported attachment type for model input.]",
        },
      },
    ])
  })

  test("extracts Bedrock document tool attachments into synthetic user media", async () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-document-tool"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make(bedrockModel.id), providerID: ProviderV2.ID.make(bedrockModel.provider) },
          content: [
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "read-doc",
              name: "read",
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "report.pdf" },
                content: [
                  { type: "text", text: "Document read successfully" },
                  {
                    type: "file",
                    uri: "data:application/pdf;base64,UERGREFUQQ==",
                    mime: "application/pdf",
                    name: "report.pdf",
                  },
                  {
                    type: "file",
                    uri: "data:application/octet-stream;base64,AAAA",
                    mime: "application/octet-stream",
                    name: "archive.bin",
                  },
                ],
                structured: {},
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      bedrockModel,
    )

    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "user"])
    expect(messages[1]?.content).toMatchObject([
      {
        type: "tool-result",
        id: "read-doc",
        name: "read",
        result: {
          type: "content",
          value: [
            { type: "text", text: "Document read successfully" },
            {
              type: "text",
              text: "[Attached application/octet-stream: archive.bin omitted: unsupported attachment type for model input.]",
            },
          ],
        },
      },
    ])
    expect(messages[2]?.content).toEqual([
      { type: "text", text: "Attached media from tool result:" },
      {
        type: "media",
        mediaType: "application/pdf",
        data: "data:application/pdf;base64,UERGREFUQQ==",
        filename: "report.pdf",
        metadata: undefined,
      },
    ])

    const prepared = await Effect.runPromise(
      LLMClient.prepare(LLM.request({ model: bedrockModel, cache: "none", messages })),
    )
    expect(prepared.body).toMatchObject({
      messages: [
        { role: "assistant", content: [{ toolUse: { toolUseId: "read-doc", name: "read" } }] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "read-doc",
                content: [
                  { text: "Document read successfully" },
                  {
                    text: "[Attached application/octet-stream: archive.bin omitted: unsupported attachment type for model input.]",
                  },
                ],
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            { text: "Attached media from tool result:" },
            { document: { format: "pdf", name: "report.pdf", source: { bytes: "UERGREFUQQ==" } } },
          ],
        },
      ],
    })
  })

  test("restores OpenAI encrypted reasoning metadata", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-openai-reasoning"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            new SessionMessage.AssistantReasoning({
              type: "reasoning",
              id: "reasoning-openai",
              text: "Think",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages[0]?.content).toEqual([
      {
        type: "reasoning",
        text: "Think",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
      },
    ])
  })

  test("drops provider-native continuation metadata after a model switch", () => {
    const messages = toLLMMessages(
      [
        new SessionMessage.Assistant({
          id: id("assistant-old-model"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("old-model"), providerID: ProviderV2.ID.make("provider") },
          content: [
            new SessionMessage.AssistantReasoning({
              type: "reasoning",
              id: "reasoning-old-model",
              text: "Visible thought",
              providerMetadata: { anthropic: { signature: "sig_old" } },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "hosted-old-model",
              name: "web_search",
              provider: {
                executed: true,
                metadata: { openai: { itemId: "hosted-old-model" } },
                resultMetadata: { openai: { itemId: "hosted-old-model" } },
              },
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { query: "Effect" },
                content: [],
                structured: {},
                result: { type: "json", value: { status: "completed" } },
              }),
              time: { created, completed: created },
            }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "local-old-model",
              name: "read",
              provider: {
                executed: false,
                metadata: { fake: { call: "old" } },
                resultMetadata: { fake: { result: "old" } },
              },
              state: new SessionMessage.ToolStateCompleted({
                status: "completed",
                input: { path: "README.md" },
                content: [],
                structured: { text: "Hello" },
              }),
              time: { created, completed: created },
            }),
          ],
          time: { created, completed: created },
        }),
      ],
      model,
    )

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Visible thought" },
      {
        type: "tool-call",
        id: "hosted-old-model",
        name: "web_search",
        input: { query: "Effect" },
        providerExecuted: true,
        providerMetadata: undefined,
      },
      {
        type: "tool-result",
        id: "hosted-old-model",
        name: "web_search",
        result: { type: "json", value: { status: "completed" } },
        providerExecuted: true,
        cache: undefined,
        metadata: undefined,
        providerMetadata: undefined,
      },
      {
        type: "tool-call",
        id: "local-old-model",
        name: "read",
        input: { path: "README.md" },
        providerExecuted: false,
        providerMetadata: undefined,
      },
    ])
    expect(messages[1]?.content).toEqual([
      {
        type: "tool-result",
        id: "local-old-model",
        name: "read",
        result: { type: "json", value: { text: "Hello" } },
        providerExecuted: false,
        cache: undefined,
        metadata: undefined,
        providerMetadata: undefined,
      },
    ])
  })
})
