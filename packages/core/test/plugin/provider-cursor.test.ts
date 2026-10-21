import { describe, expect, test } from "bun:test"
import { cursorLabel, cursorModelsFromCache } from "../../../provider-plugins/cursor/src/models"
import { applyToken, tokenFromCredential } from "../../../provider-plugins/cursor/src/credentials"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"

describe("cursor catalog cache", () => {
  test("loads grok models and strips markup from variants", () => {
    const models = cursorModelsFromCache({
      schemaVersion: 3,
      models: [
        {
          id: "grok-4.6",
          displayName: "Cursor Grok 4.6",
          supportsImages: true,
          maxContext: 256000,
          variants: [
            {
              displayName: 'Cursor Grok 4.6 <span style="color: x">High Fast\u200b\u200b</span>',
              key: "grok-4.6",
              parameterValues: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
            },
            {
              displayName: "Cursor Grok 4.6 High Fast",
              key: "grok-4.6",
              parameterValues: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
            },
          ],
        },
        { id: "composer-2.5", displayName: "Composer 2.5" },
      ],
    })

    expect(models.map((model) => model.id)).toEqual(["grok-4.6", "composer-2.5"])
    expect(models[0]?.name).toBe("Cursor Grok 4.6")
    expect(models[0]?.context).toBe(256000)
    expect(models[0]?.images).toBe(true)
    expect(models[0]?.variants.map((variant) => variant.id)).toEqual([
      "Cursor Grok 4.6 High Fast",
      "Cursor Grok 4.6 High Fast 2",
    ])
    expect(models[0]?.variants[0]?.parameters).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ])
  })

  test("ignores invalid cache payloads", () => {
    expect(cursorModelsFromCache(undefined)).toEqual([])
    expect(cursorModelsFromCache({ models: [{ id: 1 }] })).toEqual([])
    expect(cursorModelsFromCache({
      models: [{ id: "broken", variants: [{ displayName: "Broken", parameterValues: [{ id: "effort" }] }] }],
    })[0]?.variants).toEqual([])
    expect(cursorLabel('Cursor Grok 4.6 <span>High Fast\u200b\u200b</span>')).toBe("Cursor Grok 4.6 High Fast")
  })
})

describe("cursor credentials", () => {
  test("reads oauth and api-key tokens", () => {
    expect(
      tokenFromCredential(
        new Credential.OAuth({
          type: "oauth",
          methodID: Integration.MethodID.make("cursor-oauth"),
          access: "jwt-token",
          refresh: "refresh-token",
          expires: 1,
        }),
      ),
    ).toBe("jwt-token")
    expect(tokenFromCredential(new Credential.Key({ type: "key", key: "crsr_secret" }))).toBe("crsr_secret")
    expect(tokenFromCredential(undefined)).toBeUndefined()
  })

  test("passes JWTs as accessToken and Cursor API keys as apiKey", () => {
    const jwt = {}
    applyToken(jwt, "eyJhbGciOiJIUzI1NiJ9.e30.sig")
    expect(jwt).toEqual({ accessToken: "eyJhbGciOiJIUzI1NiJ9.e30.sig" })

    const key = {}
    applyToken(key, "crsr_secret")
    expect(key).toEqual({ apiKey: "crsr_secret" })
  })
})
