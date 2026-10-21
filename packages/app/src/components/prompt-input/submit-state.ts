import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ContextItem, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"

export type PromptSubmitOwner = {
  clearInput: () => void
  restoreInput: () => void
  activateCreatedSession: () => void
  onGoal?: (input: { sessionID: string; sessionDirectory: string; goal: string }) => void
}

export type SharedPromptSubmit = {
  key: string
  draftID?: string
  signature: string
  sessionID: string
  messageID: string
  projectDirectory: string
  sessionDirectory: string
  worktreeSelection: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  images: ImageAttachmentPart[]
  mode: "normal" | "shell"
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] }
  session?: Session
  clearedPrompt?: Prompt
  pendingPrompt?: { prompt: Prompt; cursor: number }
  owner?: PromptSubmitOwner
  inFlight?: Promise<void>
  resolveInFlight?: () => void
  operation: "prompt" | "command" | "shell"
  commandIntent?: string
  commandUnknown?: boolean
  shellUnknown?: boolean
  finalized?: boolean
  historyAdded?: boolean
}

export type PromptRetry = {
  operation: "prompt" | "command" | "shell"
  signature: string
  messageID: string
  commandIntent?: string
  commandUnknown?: boolean
  shellUnknown?: boolean
}

const shared = new Map<string, SharedPromptSubmit>()
const retries = new Map<string, PromptRetry>()

export function sharedPromptSubmit(key: string) {
  return shared.get(key)
}

export function setSharedPromptSubmit(value: SharedPromptSubmit) {
  shared.set(value.key, value)
}

export function deleteSharedPromptSubmit(value: SharedPromptSubmit) {
  if (shared.get(value.key) === value) shared.delete(value.key)
}

export function promptRetry(
  key: string,
  input: Pick<PromptRetry, "operation" | "signature" | "commandIntent">,
): PromptRetry {
  const current = retries.get(key)
  if (current?.operation === input.operation && current.signature === input.signature) return current
  const next: PromptRetry = { ...input, messageID: Identifier.ascending("message") }
  retries.set(key, next)
  return next
}

export function currentPromptRetry(key: string) {
  return retries.get(key)
}

export function deletePromptRetry(key: string, value: PromptRetry) {
  if (retries.get(key) === value) retries.delete(key)
}

export function clearDraftPromptSubmitState(draftID: string) {
  for (const [key, value] of shared) {
    if (value.draftID === draftID) shared.delete(key)
  }
}

export function clearPromptSubmitState() {
  shared.clear()
  retries.clear()
}
