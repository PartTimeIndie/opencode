import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

test("preferences OpenAPI requires a patch body and preserves explicit null clears for SDK generation", () => {
  const operation = OpenApi.fromApi(PublicApi).paths["/session/{sessionID}/delegation-preferences"]?.patch
  expect(operation?.requestBody).toMatchObject({ required: true, content: { "application/json": { schema: {
    required: ["patch"], properties: { patch: { properties: {
      ordinaryQuestions: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      preferences: { anyOf: [expect.objectContaining({ type: "array" }), { type: "null" }] },
      rules: { anyOf: [expect.objectContaining({ type: "array" }), { type: "null" }] },
    } } },
  } } } })
})
