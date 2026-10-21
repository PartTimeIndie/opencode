import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { registerReviewerSettings as registerReview } from "../../../../.opencode/plugin-sources/multi-agent-review-app/settings.js"
import { registerReviewerSettings as registerSolver } from "../../../../.opencode/plugin-sources/multi-agent-problem-solver-app/settings.js"

for (const [key, register] of [["review", registerReview], ["problem_solver", registerSolver]]) {
  test(`${key} reviewer settings save a valid global config patch`, async () => {
    const config = { multi_agent: { [key]: { reviewers: [{ model: "example/old" }], enabled: true } } }
    const requests = []
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4098",
      fetch: Object.assign(async (request) => {
        requests.push(request)
        if (request.method === "GET") return Response.json(config)
        const body = await request.clone().text()
        if (!body) return Response.json({ error: "Expected ConfigUpdate, got undefined" }, { status: 400 })
        config.multi_agent = { ...config.multi_agent, ...JSON.parse(body).multi_agent }
        return Response.json(config)
      }, { preconnect: fetch.preconnect }),
    })
    let settings
    const api = {
      client,
      signal: new AbortController().signal,
      settings: { register: (item) => { settings = item; return () => {} } },
    }
    await register(api, key, key, key).ready

    await settings.storage.update("reviewers", () => [{ selection: { model: "example/new", variant: "high" } }])

    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PATCH"])
    expect(await requests[2].json()).toEqual({ multi_agent: {
      [key]: { enabled: true, reviewers: [{ model: "example/new", variant: "high" }] },
    } })
    expect(settings.storage.read("reviewers", [])).toEqual([{ selection: { model: "example/new", variant: "high" } }])
  })
}
