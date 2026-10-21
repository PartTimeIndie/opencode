import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { withSessionMessageRequestTimeout } from "../../../app/src/context/session-message-request"

test("an actual abort during 503 body reading stays an AbortError, not an empty decoded-body error", async () => {
  const controller = new AbortController()
  const statuses: number[] = []
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("{"))
      },
    }), { status: 503, headers: { "content-type": "application/json" } }),
  })
  try {
    const client = createOpencodeClient({
      baseUrl: server.url.href,
      throwOnError: true,
      fetch: async (request) => {
        const response = await fetch(request)
        statuses.push(response.status)
        controller.abort()
        return response
      },
    })
    const error = await client.session.status(undefined, { signal: controller.signal }).catch((error: unknown) => error)
    expect(statuses).toEqual([503])
    expect(controller.signal.aborted).toBe(true)
    expect(error).toMatchObject({ name: "AbortError" })
    expect(String(error)).not.toContain("(empty response body)")
  } finally {
    server.stop(true)
  }
})

test("503 wire bodies and decoded causes are distinct from cancellation", async () => {
  const bodies = ["", "{}", "null", '""', '{"name":"InstanceUnavailable","data":{"message":"boot deadline"}}']
  const server = Bun.serve({
    port: 0,
    fetch: (request) => new Response(bodies[Number(new URL(request.url).searchParams.get("directory"))], {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "1" },
    }),
  })
  try {
    for (const [index, wire] of bodies.entries()) {
      const captures: Array<{ body: string; aborted: boolean; status: number }> = []
      const client = createOpencodeClient({
        baseUrl: server.url.href,
        directory: String(index),
        throwOnError: true,
        fetch: async (input) => {
          const request = input as Request
          const response = await fetch(request)
          captures.push({ body: await response.clone().text(), aborted: request.signal.aborted, status: response.status })
          return response
        },
      })
      const error = await client.session.status().catch((error: unknown) => error)
      expect(captures).toEqual([{ body: wire, aborted: false, status: 503 }])
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("Expected SDK Error")
      // JSON null falls back to the original text in the generated decoder.
      expect(error.cause).toEqual({ body: index === 0 ? "" : index === 2 ? "null" : JSON.parse(wire), status: 503 })
      expect(error.message.includes("(empty response body)")).toBe(index === 0 || index === 1 || index === 3)
    }
  } finally {
    server.stop(true)
  }
})

test("messages deadline aborts only messages while status retains its real 503 body", async () => {
  const release = Promise.withResolvers<void>()
  const signals = new Map<string, AbortSignal>()
  const captures: Array<{ body: string; status: number; aborted: boolean }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await release.promise
      return new URL(request.url).pathname === "/session/status"
        ? new Response("{}", { status: 503, headers: { "content-type": "application/json" } })
        : Response.json([])
    },
  })
  try {
    const client = createOpencodeClient({
      baseUrl: server.url.href,
      throwOnError: true,
      fetch: async (input) => {
        const request = input as Request
        const path = new URL(request.url).pathname
        signals.set(path, request.signal)
        const response = await fetch(request)
        captures.push({ body: await response.clone().text(), status: response.status, aborted: request.signal.aborted })
        return response
      },
    })
    const status = client.session.status().catch((error: unknown) => error)
    const messages = withSessionMessageRequestTimeout({
      signal: new AbortController().signal,
      retries: 0,
      timeoutMs: 50,
      task: (signal) => client.session.messages({ sessionID: "ses_evidence", limit: 20 }, { signal }),
    }).catch((error: unknown) => error)
    expect(await messages).toMatchObject({ name: "SessionMessageRequestTimeout" })
    expect(signals.get("/session/ses_evidence/message")?.aborted).toBe(true)
    expect(signals.get("/session/status")?.aborted).toBe(false)
    expect(signals.get("/session/status")).not.toBe(signals.get("/session/ses_evidence/message"))
    release.resolve()
    const error = await status
    expect(error).toMatchObject({ cause: { body: {}, status: 503 } })
    expect(captures).toEqual([{ body: "{}", status: 503, aborted: false }])
  } finally {
    release.resolve()
    server.stop(true)
  }
})
