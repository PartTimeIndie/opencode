import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"

const info = {
  id: SessionID.descending(),
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  workspaceID: undefined,
  directory: "/tmp/opencode",
  parentID: undefined,
  summary: undefined,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  share: undefined,
  title: "Test session",
  version: "1.0.0",
  time: {
    created: 1,
    updated: 2,
    compacting: undefined,
    archived: undefined,
  },
  permission: undefined,
  revert: undefined,
} satisfies Session.Info

describe("Session schema", () => {
  test("encodes undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)(info) as Record<string, unknown>

    for (const key of ["workspaceID", "parentID", "summary", "share", "permission", "revert"]) {
      expect(Object.hasOwn(encoded, key)).toBe(false)
    }
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "compacting")).toBe(false)
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "archived")).toBe(false)
    expect(JSON.stringify(encoded)).not.toContain("parentID")
  })

  test("encodes undefined optional global session project fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.GlobalInfo)({
      ...info,
      project: {
        id: ProjectV2.ID.global,
        name: undefined,
        worktree: "/tmp/opencode",
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded, "parentID")).toBe(false)
    expect(Object.hasOwn(encoded.project as Record<string, unknown>, "name")).toBe(false)
  })

  test("encodes nested undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...info,
      summary: {
        additions: 1,
        deletions: 2,
        files: 3,
        diffs: undefined,
      },
      revert: {
        messageID: MessageID.ascending(),
        partID: undefined,
        snapshot: undefined,
        diff: undefined,
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded.summary as Record<string, unknown>, "diffs")).toBe(false)
    for (const key of ["partID", "snapshot", "diff"]) {
      expect(Object.hasOwn(encoded.revert as Record<string, unknown>, key)).toBe(false)
    }
  })

  test("keeps the persisted model chain in the session projection", () => {
    const model = {
      id: ModelV2.ID.make("gpt-5.6-luna"),
      providerID: ProviderV2.ID.make("openai"),
      variant: ModelV2.VariantID.make("high"),
      chain: {
        id: "luna-free-qa",
        name: "Luna Free QA",
        active: 0,
        steps: [
          {
            id: ModelV2.ID.make("gpt-5.6-luna"),
            providerID: ProviderV2.ID.make("openai"),
            variant: ModelV2.VariantID.make("high"),
          },
          { id: ModelV2.ID.make("openrouter/free"), providerID: ProviderV2.ID.make("openrouter") },
        ],
      },
    }
    const projected = Session.fromRow({
      ...Session.toRow({ ...info, model }),
      agent_policy: null,
      fork_dispatch_digest: null,
      fork_history_seq: null,
      generation_ms: 0,
    } as Parameters<typeof Session.fromRow>[0])
    const encoded = Schema.encodeUnknownSync(Session.Info)(projected)

    expect(projected.model?.chain).toEqual(model.chain)
    expect(encoded.model?.chain).toEqual(model.chain)
  })

  test("preserves an explicit null model chain through the session projection", () => {
    const model = {
      id: ModelV2.ID.make("gpt-5.6-luna"),
      providerID: ProviderV2.ID.make("openai"),
      chain: null,
    }
    const projected = Session.fromRow({
      ...Session.toRow({ ...info, model }),
      agent_policy: null,
      fork_dispatch_digest: null,
      fork_history_seq: null,
      generation_ms: 0,
    } as Parameters<typeof Session.fromRow>[0])
    const encoded = Schema.encodeUnknownSync(Session.Info)(projected)

    expect(projected.model?.chain).toBeNull()
    expect(encoded.model?.chain).toBeNull()
  })
})
