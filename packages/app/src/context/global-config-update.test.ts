import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { updateGlobalConfig } from "./global-config-update"

test("global config update sends the safety-review patch in the request body", async () => {
  const requests: Request[] = []
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4098",
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(request instanceof Request ? request : new Request(request))
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const patch = { access_control: { safety_review: { auto_save: true } } }

  await updateGlobalConfig(client, patch)

  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("PATCH")
  expect(new URL(requests[0].url).pathname).toBe("/global/config")
  expect(await requests[0].json()).toEqual(patch)
})
