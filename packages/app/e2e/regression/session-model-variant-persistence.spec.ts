import { expect, test } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionModelVariantPersistence"
const projectID = "proj_session_model_variant_persistence"
const primaryID = "ses_session_model_variant_primary"
const secondaryID = "ses_session_model_variant_secondary"

test("restores max after late model hydration and session tab switches", async ({ page }) => {
  let hydrated = false
  let emitted = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-model-variant-persistence",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.6-sol": {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              family: "gpt",
              release_date: "2026-07-09",
              limit: { context: 400_000, output: 128_000 },
              cost: { input: 1, output: 8 },
              capabilities: { reasoning: true, tool_call: true, attachment: true },
              variants: { medium: {}, high: {}, max: {} },
            },
          },
        },
      ],
      connected: ["openai"],
      default: { providerID: "openai", modelID: "gpt-5.6-sol" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(primaryID, "Primary max session"), session(secondaryID, "Secondary medium session")],
    pageMessages: (sessionID) => {
      if (sessionID === secondaryID) return { items: [userMessage(secondaryID, "medium", true)] }
      return {
        items: [
          userMessage(primaryID, "max", hydrated),
          ...(hydrated
            ? [
                {
                  info: {
                    id: "msg_primary_assistant",
                    sessionID: primaryID,
                    role: "assistant",
                    parentID: "msg_primary_user",
                    time: { created: 1_700_000_000_200, completed: 1_700_000_000_300 },
                    agent: "build",
                    mode: "build",
                    modelID: "gpt-5.6-sol",
                    providerID: "openai",
                    variant: "max",
                    path: { cwd: directory, root: directory },
                    cost: 0,
                    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                    finish: "stop",
                  },
                  parts: [
                    {
                      id: "prt_primary_assistant",
                      sessionID: primaryID,
                      messageID: "msg_primary_assistant",
                      type: "text",
                      text: "PRIMARY_MAX_COMPLETE",
                    },
                  ],
                },
              ]
            : []),
        ],
      }
    },
    sessionStatus: () => (hydrated ? {} : { [primaryID]: { type: "busy" } }),
    eventDelay: 500,
    events: () => {
      if (emitted) return []
      emitted = true
      hydrated = true
      return [
        {
          directory,
          payload: {
            id: "evt_primary_complete",
            type: "session.next.activity.completed",
            properties: { sessionID: primaryID, activityID: "activity_primary" },
          },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ dir, dirBase64, first, second, selectionKey }) => {
      localStorage.clear()
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: first },
          { type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: second },
        ]),
      )
      localStorage.setItem(
        selectionKey,
        JSON.stringify({
          workspace: {
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5.6-sol" },
            variant: "max",
          },
          session: {
            [first]: {
              agent: "assistant",
              model: { providerID: "", modelID: "" },
              variant: "medium",
            },
          },
        }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      first: primaryID,
      second: secondaryID,
      selectionKey: `${workspaceStorage(directory)}:workspace:model-selection`,
    },
  )

  await page.goto(`/${base64Encode(directory)}/session/${primaryID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Primary max session" }))
  await expect(page.getByText("PRIMARY_MAX_COMPLETE", { exact: true })).toBeVisible()
  await expectVariant(page, "max")

  await page
    .locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${secondaryID}"]`)
    .getByRole("tab")
    .click()
  await expectAppVisible(page.getByRole("heading", { name: "Secondary medium session" }))
  await expectVariant(page, "medium")

  await page
    .locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${primaryID}"]`)
    .getByRole("tab")
    .click()
  await expectAppVisible(page.getByRole("heading", { name: "Primary max session" }))
  await expectVariant(page, "max")
})

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function userMessage(sessionID: string, variant: string, complete: boolean) {
  return {
    info: {
      id: sessionID === primaryID ? "msg_primary_user" : "msg_secondary_user",
      sessionID,
      role: "user",
      time: { created: 1_700_000_000_100 },
      agent: "build",
      model: complete
        ? { providerID: "openai", modelID: "gpt-5.6-sol", variant }
        : { providerID: "", modelID: "" },
    },
    parts: [
      {
        id: sessionID === primaryID ? "prt_primary_user" : "prt_secondary_user",
        sessionID,
        messageID: sessionID === primaryID ? "msg_primary_user" : "msg_secondary_user",
        type: "text",
        text: "Model selection persistence regression",
      },
    ],
  }
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `opencode.workspace.${head}.${checksum(dir) ?? "0"}.dat`
}

async function expectVariant(page: Parameters<typeof mockOpenCodeServer>[0], variant: string) {
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("GPT-5.6 Sol")
  await expect(composer.locator('[data-action="prompt-model-variant"]')).toContainText(variant)
}
