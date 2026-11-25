import { resultContract, resultContractMarker } from "./result-contract.js"
async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}
export function shouldReuseScheduledJobSession(input) {
  return input.strategy === "job" && !!input.existing && !input.resetHistory
}
export function isCompletedScheduledJobRun(input) {
  return input.lastRunID === input.runID && input.lastRunStatus === "success"
}
export function scheduledJobPollingState(status, activityID, trackedActivityID) {
  if (status !== "running" && status !== "pending" && status !== "awaiting_input") return
  return {
    status: "running",
    activityID: activityID ?? trackedActivityID,
    continuePolling: true,
  }
}
export async function scheduledJobMessageID(input) {
  const digest = await hash(JSON.stringify([input.scopeId, input.slug, input.runId]))
  return `msg_${digest.slice(0, 26)}`
}
export async function scheduledJobSessionID(input) {
  const digest = await hash(JSON.stringify([input.scopeId, input.slug, input.runId]))
  return `ses_${digest.slice(0, 26)}`
}
export function scheduledJobModelSelection(run, resolve) {
  if (!run) return
  if (run.modelChain !== undefined) {
    if (typeof run.modelChain !== "string" || !run.modelChain.trim())
      throw new Error("Scheduled app job has an invalid model-chain reference.")
    const model = resolve(`chain:${run.modelChain.trim()}`)
    if (!model) throw new Error(`Scheduled app job model chain "${run.modelChain.trim()}" is not configured.`)
    return model
  }
  if (typeof run.model !== "string" || !run.model) return
  const model = resolve(run.model.startsWith("model:") ? run.model : `model:${run.model}`)
  if (!model) throw new Error(`Scheduled app job model "${run.model}" is unavailable.`)
  return { ...model, ...(typeof run.variant === "string" && run.variant ? { variant: run.variant } : {}) }
}
export function scheduledJobTaskPrompt(job) {
  const candidates = [job?.prompt, job?.run?.prompt]
  return candidates.find((value) => {
    if (typeof value !== "string" || !value.trim()) return false
    const text = value.trim()
    return text !== resultContractMarker && !text.startsWith(`${resultContractMarker}\n`)
  })?.trim()
}
export const scheduledJobPrompt = (prompt) => `${prompt}

${resultContract}`
