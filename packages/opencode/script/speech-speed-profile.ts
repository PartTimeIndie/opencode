export const SPEECH_POLISH_CHAIN_ID = "speech-polish-fast"
export const SPEECH_SPEED_TARGETS = {
  transcriptionChain: "model:openrouter/openai/gpt-4o-mini-transcribe",
  improvementChain: "model:openrouter/speech-polish-groq",
}

type Chain = {
  id: string
  name: string
  steps: ReadonlyArray<{ providerID: string; modelID: string; variant?: string }>
}

/** Keep speech tuning separate from the user's general-purpose text chains. */
export function speechSpeedProfile(chains: readonly Chain[], transcriptionChainID: string) {
  if (!chains.some((chain) => chain.id === transcriptionChainID))
    throw new Error("Transcription chain no longer exists")
  const transcriptionModels = [
    "openai/gpt-4o-mini-transcribe",
    "qwen/qwen3-asr-0.6b",
    "mistralai/voxtral-small-24b-2507-stt",
  ]
  return {
    provider: {
      openrouter: {
        models: {
          // OpenRouter's text catalog currently omits these audio endpoints.
          // Explicit capabilities also make the installed host admit them.
          ...Object.fromEntries(
            transcriptionModels.map((id) => [
              id,
              {
                id,
                name: id,
                attachment: true,
                tool_call: false,
                reasoning: false,
                modalities: { input: ["audio"], output: ["transcription"] },
                limit: { context: 0, output: 0 },
              },
            ]),
          ),
          "speech-polish-groq": {
            id: "openai/gpt-oss-20b",
            name: "Speech polish · GPT-OSS 20B · Groq",
            options: { provider: { only: ["groq"], allow_fallbacks: false }, reasoning: { effort: "minimal" } },
            modalities: { input: ["text"], output: ["text"] },
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 131072, output: 32768 },
          },
          "speech-polish-cerebras": {
            id: "openai/gpt-oss-120b",
            name: "Speech polish fallback · GPT-OSS 120B · Cerebras",
            options: { provider: { only: ["cerebras"], allow_fallbacks: false }, reasoning: { effort: "minimal" } },
            modalities: { input: ["text"], output: ["text"] },
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 131072, output: 32768 },
          },
        },
      },
    },
    model_chains: [
      ...chains
        .filter((chain) => chain.id !== SPEECH_POLISH_CHAIN_ID)
        .map((chain) =>
          chain.id === transcriptionChainID
            ? { ...chain, steps: transcriptionModels.map((modelID) => ({ providerID: "openrouter", modelID })) }
            : chain,
        ),
      {
        id: SPEECH_POLISH_CHAIN_ID,
        name: "Speech polish · low latency",
        steps: [
          { providerID: "openrouter", modelID: "speech-polish-groq" },
          { providerID: "openrouter", modelID: "speech-polish-cerebras" },
        ],
      },
    ],
  }
}
