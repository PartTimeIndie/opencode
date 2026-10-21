import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { importModule } from "../auth"

export async function CursorAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "cursor",
      methods: [
        {
          type: "oauth",
          label: "Cursor account (browser login)",
          async authorize() {
            const auth = await importModule()
            const params = auth.generatePkceParams()
            const challenge = await auth.generatePkceChallenge(params.verifier)
            const websiteUrl = process.env.CURSOR_WEBSITE_URL ?? "https://cursor.com"
            const apiBaseUrl = process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh"
            return {
              url: auth.buildLoginUrl(challenge, params.uuid, websiteUrl),
              instructions: "Open this URL in a browser to sign in to Cursor",
              method: "auto" as const,
              async callback() {
                const result = await auth.pollForTokens(params.uuid, params.verifier, apiBaseUrl)
                return {
                  type: "success" as const,
                  provider: "cursor",
                  access: result.accessToken,
                  refresh: result.refreshToken,
                  expires: auth.decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API key (cursor.com/settings)",
          prompts: [
            {
              type: "text" as const,
              key: "apiKey",
              message: "Cursor API key",
              placeholder: "crsr_...",
              validate(value: string) {
                if (!value.startsWith("crsr_")) return "API key should start with crsr_"
              },
            },
          ],
          async authorize(inputs?: Record<string, string>) {
            const apiKey = inputs?.apiKey
            if (!apiKey) return { type: "failed" as const }
            const auth = await importModule()
            const result = await auth.exchangeApiKey(apiKey, process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh")
            return {
              type: "success" as const,
              key: result.accessToken,
              provider: "cursor",
              metadata: { refreshToken: result.refreshToken },
            }
          },
        },
      ],
    },
  }
}
