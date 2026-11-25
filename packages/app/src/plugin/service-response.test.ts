import { expect, test } from "bun:test"
import { pluginServiceResponse } from "./service-response"

test("preserves service data and application-level failures", async () => {
  expect(await pluginServiceResponse(Response.json({ ok: true, data: { jobs: [] } }))).toEqual({ ok: true, data: { jobs: [] } })
  expect(await pluginServiceResponse(Response.json({ ok: false, message: "Refused" }))).toEqual({ ok: false, error: "Refused" })
})

for (const status of [401, 403, 503]) {
  test(`preserves HTTP ${status} even when the response is not JSON`, async () => {
    expect(await pluginServiceResponse(Response.json({ message: "Unavailable" }, { status }))).toEqual({ ok: false, error: "Unavailable", status })
    expect(await pluginServiceResponse(new Response("Service unavailable", { status }))).toEqual({ ok: false, error: "Plugin service failed", status })
  })
}

test("malformed successful responses do not become retryable transport failures", async () => {
  expect(await pluginServiceResponse(new Response("not JSON"))).toEqual({ ok: false, error: "Plugin service failed" })
})
