import { Effect, Option } from "effect"
import { Catalog } from "../../src/catalog"
import { Credential } from "../../src/credential"
import { Global } from "../../src/global"
import { Integration } from "../../src/integration"
import { Npm } from "../../src/npm"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { providerRegistration } from "../../src/plugin/provider-host"

function unused<T>(name: string): T {
  return new Proxy({}, { get: (_target, key) => { throw new Error(`Unexpected fixture service ${name}.${String(key)}`) } }) as T
}

/** Domain regressions use public package sources so transport SDK fixtures remain interceptable.
 * Manifest and detached-artifact tests separately exercise the release entrypoints. */
async function registration(name: string) {
  const module: ProviderPluginModule = (await import(new URL(`../../../provider-plugins/${name}/src/index.ts`, import.meta.url).href)).default
  if (!module) throw new Error(`Missing public provider package ${name}`)
  const input = providerRegistration(module)
  return { ...input, effect: Effect.gen(function* () {
    const catalog = Option.getOrElse(yield* Effect.serviceOption(Catalog.Service), () => unused<Catalog.Interface>("catalog"))
    const credentials = Option.getOrElse(yield* Effect.serviceOption(Credential.Service), () => unused<Credential.Interface>("credentials"))
    const integrations = Option.getOrElse(yield* Effect.serviceOption(Integration.Service), () => unused<Integration.Interface>("integrations"))
    const npm = Option.getOrElse(yield* Effect.serviceOption(Npm.Service), () => unused<Npm.Interface>("npm"))
    return yield* input.effect.pipe(
      Effect.provideService(Catalog.Service, catalog), Effect.provideService(Credential.Service, credentials),
      Effect.provideService(Integration.Service, integrations), Effect.provideService(Npm.Service, npm),
      Effect.provideService(Global.Service, Global.make()),
    )
  }) }
}

export const AlibabaPlugin = await registration("alibaba")
export const AmazonBedrockPlugin = await registration("amazon-bedrock")
export const AnthropicPlugin = await registration("anthropic")
export const AzurePlugin = await registration("azure")
export const AzureCognitiveServicesPlugin = await registration("azure-cognitive-services")
export const CerebrasPlugin = await registration("cerebras")
export const CloudflareAIGatewayPlugin = await registration("cloudflare-ai-gateway")
export const CloudflareWorkersAIPlugin = await registration("cloudflare-workers-ai")
export const CoherePlugin = await registration("cohere")
export const DeepInfraPlugin = await registration("deepinfra")
export const DynamicProviderPlugin = await registration("dynamic")
export const GatewayPlugin = await registration("gateway")
export const GithubCopilotPlugin = await registration("github-copilot")
export const GitLabPlugin = await registration("gitlab")
export const GooglePlugin = await registration("google")
export const GoogleVertexPlugin = await registration("google-vertex")
export const GoogleVertexAnthropicPlugin = await registration("google-vertex-anthropic")
export const GroqPlugin = await registration("groq")
export const KiloPlugin = await registration("kilo")
export const LLMGatewayPlugin = await registration("llmgateway")
export const LMStudioPlugin = await registration("lmstudio")
export const MistralPlugin = await registration("mistral")
export const NvidiaPlugin = await registration("nvidia")
export const OpenAIPlugin = await registration("openai")
export const OpenAICompatiblePlugin = await registration("openai-compatible")
export const OpencodePlugin = await registration("opencode")
export const OpenRouterPlugin = await registration("openrouter")
export const PerplexityPlugin = await registration("perplexity")
export const SapAICorePlugin = await registration("sap-ai-core")
export const SnowflakeCortexPlugin = await registration("snowflake-cortex")
export const TogetherAIPlugin = await registration("togetherai")
export const VenicePlugin = await registration("venice")
export const VercelPlugin = await registration("vercel")
export const XAIPlugin = await registration("xai")
export const ZenmuxPlugin = await registration("zenmux")
