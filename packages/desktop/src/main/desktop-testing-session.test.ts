import { afterEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import type { Server } from "node:http"
import { createServer } from "node:http"
import {
  parseDesktopTestingSessionModel,
  resumeDesktopTestingSession,
  runDesktopTestingSession,
} from "./desktop-testing-session"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe("runDesktopTestingSession", () => {
  test("validates renderer model chains before crossing into the sidecar", () => {
    expect(parseDesktopTestingSessionModel({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3",
      chain: {
        id: "glm-codex",
        name: "GLM Codex",
        active: 0,
        steps: [{ providerID: "zhipuai-coding-plan", id: "glm-5.3" }],
      },
    })).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3",
      chain: {
        id: "glm-codex",
        name: "GLM Codex",
        active: 0,
        steps: [{ providerID: "zhipuai-coding-plan", id: "glm-5.3" }],
      },
    })
    expect(parseDesktopTestingSessionModel({ providerID: "cursor", id: "gpt-5.6-luna", chain: { steps: [] } })).toBeUndefined()
  })

  test("admits a prompt through the current sidecar and opens the durable session", async () => {
    const requests: Array<{ method?: string; url?: string; directory?: string; authorization?: string; body: unknown }> = []
    const sidecar = await startServer(async (request, response) => {
      const body = await readBody(request)
      requests.push({
        method: request.method,
        url: request.url,
        directory: stringHeader(request.headers["x-opencode-directory"]),
        authorization: stringHeader(request.headers.authorization),
        body,
      })
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url === "/api/session" ? { data: { id: "ses_test" } } : { data: { id: (body as { id: string }).id } }))
    })
    const opened: string[] = []

    const result = await runDesktopTestingSession({
      sidecar: { url: sidecar, username: "opencode", password: "secret" },
      directory: "C:\\repo",
      agent: "build",
      model: {
        providerID: "zhipuai-coding-plan",
        id: "glm-5.3",
        chain: {
          id: "glm-codex",
          name: "GLM Codex",
          active: 0,
          steps: [
            { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
            { providerID: "cursor", id: "gpt-5.6-sol", variant: "medium" },
          ],
        },
      },
      prompt: "continue the work",
      openSession: async (sessionID) => {
        opened.push(sessionID)
      },
    })

    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      sessionID: "ses_test",
      directory: "C:\\repo",
      visible: true,
    })
    expect((result as { inputID: string }).inputID).toMatch(/^msg_desktop_testing_[a-f0-9]{32}$/)
    expect(requests[1].body).toMatchObject({ id: (result as { inputID: string }).inputID })
    expect(opened).toEqual(["ses_test"])
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/session",
        directory: "C:\\repo",
        authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
        body: {
          agent: "build",
          model: {
            providerID: "zhipuai-coding-plan",
            id: "glm-5.3",
            chain: {
              id: "glm-codex",
              name: "GLM Codex",
              active: 0,
              steps: [
                { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
                { providerID: "cursor", id: "gpt-5.6-sol", variant: "medium" },
              ],
            },
          },
          location: { directory: "C:\\repo" },
        },
      },
      {
        method: "POST",
        url: "/api/session/ses_test/prompt",
        directory: "C:\\repo",
        authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
        body: {
          id: (result as { inputID: string }).inputID,
          agent: "build",
          model: {
            providerID: "zhipuai-coding-plan",
            id: "glm-5.3",
            chain: {
              id: "glm-codex",
              name: "GLM Codex",
              active: 0,
              steps: [
                { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
                { providerID: "cursor", id: "gpt-5.6-sol", variant: "medium" },
              ],
            },
          },
          prompt: { text: "continue the work" },
        },
      },
    ])
  })

  test("stops waiting without interrupting admitted work", async () => {
    const requests: Array<{ url?: string; body?: unknown }> = []
    const sidecar = await startServer(async (request, response) => {
      const body = await readBody(request)
      requests.push({ url: request.url ?? "", body })
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify(
          request.url === "/api/session"
            ? { data: { id: "ses_wait" } }
            : request.url === "/api/session/ses_wait/activity"
              ? { data: { type: "busy", activityID: "activity_wait", activityStatus: "running" } }
              : { data: { id: (body as { id: string }).id } },
        ),
      )
    })

    const result = await runDesktopTestingSession({
      sidecar: { url: sidecar, username: null, password: null },
      directory: "C:\\repo",
      prompt: "long task",
      waitMs: 20,
    })

    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      sessionID: "ses_wait",
      directory: "C:\\repo",
      timedOut: true,
    })
    expect((result as { inputID: string }).inputID).toMatch(/^msg_desktop_testing_[a-f0-9]{32}$/)
    expect(requests.map((r) => r.url)).toEqual(["/api/session", "/api/session/ses_wait/prompt", "/api/session/ses_wait/activity"])
    expect((requests[1].body as { id: string }).id).toBe((result as { inputID: string }).inputID)
  })

  test("reports a terminal provider failure instead of claiming completion", async () => {
    const sidecar = await startServer(async (request, response) => {
      const body = await readBody(request)
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify(
          request.url === "/api/session"
            ? { data: { id: "ses_failed" } }
            : request.url === "/api/session/ses_failed/activity"
              ? {
                  data: {
                    type: "idle",
                    activityID: "activity_failed",
                    activityStatus: "failed",
                    lastError: "Integration.Authorization: Request failed: 401",
                  },
                }
              : { data: { id: (body as { id: string }).id } },
        ),
      )
    })

    await expect(
      runDesktopTestingSession({
        sidecar: { url: sidecar, username: null, password: null },
        directory: "C:\\repo",
        prompt: "fail honestly",
        waitMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      sessionID: "ses_failed",
      directory: "C:\\repo",
      failed: true,
      activityID: "activity_failed",
      error: "Integration.Authorization: Request failed: 401",
    })
  })

  test("rejects a foreign admission instead of adopting it", async () => {
    const sidecar = await startServer(async (request, response) => {
      await readBody(request)
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify(
          request.url === "/api/session" ? { data: { id: "ses_foreign" } } : { data: { id: "msg_foreign_admission" } },
        ),
      )
    })

    await expect(
      runDesktopTestingSession({
        sidecar: { url: sidecar, username: null, password: null },
        directory: "C:\\repo",
        prompt: "foreign admission",
      }),
    ).rejects.toThrow("Desktop sidecar admitted a different session input than requested")
  })

  test("retries a lost 5xx prompt acknowledgement with the same input ID", async () => {
    const requests: Array<{ url?: string; body?: unknown }> = []
    const sidecar = await startServer(async (request, response) => {
      const body = await readBody(request)
      requests.push({ url: request.url ?? "", body })
      if ((request.url ?? "").endsWith("/prompt") && requests.filter((r) => r.url === request.url).length === 1) {
        response.statusCode = 500
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ error: "lost acknowledgement" }))
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify(
          request.url === "/api/session" ? { data: { id: "ses_retry" } } : { data: { id: (body as { id: string }).id } },
        ),
      )
    })

    const result = await runDesktopTestingSession({
      sidecar: { url: sidecar, username: null, password: null },
      directory: "C:\\repo",
      prompt: "retry the same durable admission",
    })
    const prompts = requests.filter((r) => r.url === "/api/session/ses_retry/prompt")
    expect(prompts).toHaveLength(2)
    const first = (prompts[0].body as { id: string }).id
    const second = (prompts[1].body as { id: string }).id
    expect(first).toMatch(/^msg_desktop_testing_[a-f0-9]{32}$/)
    expect(second).toBe(first)
    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      sessionID: "ses_retry",
      inputID: first,
      directory: "C:\\repo",
    })
  })

  test("resumes the exact durable session through the current sidecar", async () => {
    const requests: Array<{ url?: string; directory?: string }> = []
    const sidecar = await startServer(async (request, response) => {
      requests.push({ url: request.url, directory: stringHeader(request.headers["x-opencode-directory"]) })
      response.setHeader("content-type", "application/json")
      response.end("{}")
    })

    await expect(
      resumeDesktopTestingSession({
        sidecar: { url: sidecar, username: null, password: null },
        directory: "C:\\repo",
        sessionID: "ses_resume",
      }),
    ).resolves.toEqual({ ok: true, accepted: true, sessionID: "ses_resume", directory: "C:\\repo" })
    expect(requests).toEqual([{ url: "/api/session/ses_resume/resume", directory: "C:\\repo" }])
  })
})

async function startServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port")
  return `http://127.0.0.1:${address.port}`
}

async function readBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : undefined
}

function stringHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}
