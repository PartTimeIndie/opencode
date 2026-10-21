export async function cancelSessionTool(
  client: {
    v2: { session: { cancelTool: (input: { sessionID: string; callID: string }) => Promise<{ data?: unknown }> } }
  },
  input: { sessionID: string; callID: string },
) {
  return client.v2.session.cancelTool(input)
}

// The desktop-testing bridge enforces a short renderer deadline. A prompt or
// resume that the server accepted starts a provider turn that can legitimately
// run for many minutes, so the action reports acceptance and lets the turn
// finish out of band; late failures must never surface as bridge errors.
export function acceptSessionTurn(turn: Promise<unknown>) {
  void turn.catch(() => undefined)
  return { accepted: true }
}

export type SessionPromptInput = {
  sessionID: string
  agent?: string
  model?: {
    providerID: string
    id: string
    variant?: string
    chain?: {
      id: string
      name: string
      active?: number
      steps: { providerID: string; id: string; variant?: string }[]
    }
  }
  prompt: { text: string }
}

export function startSessionPrompt(
  client: { v2: { session: { prompt: (input: SessionPromptInput) => Promise<unknown> } } },
  input: SessionPromptInput,
) {
  return acceptSessionTurn(client.v2.session.prompt(input))
}
