import { createHash } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"

/** A one-shot series, with immutable reservations fsynced before transport.
 * A crash consumes the series, not permission to restart it. Receipts contain no credentials. */
export function cacheBudget(input: {
  approval: string
  sessionID: string
  credentialID: string
  modelID: string
  variant: string
  maxRequests: number
  targetInputTokens: number
}) {
  const bytes = readFileSync(input.approval)
  const approval = JSON.parse(bytes.toString())
  const scope = approval.oauthException
  if (approval.version !== 1 || approval.sessionID !== input.sessionID ||
    scope?.providerID !== "openai" || scope.modelID !== input.modelID || scope.variant !== input.variant ||
    scope.credentialID !== input.credentialID || scope.externalRequestsUsed !== 0 ||
    !Number.isInteger(scope.maxRequests) || !Number.isInteger(scope.targetInputTokens) ||
    !Number.isInteger(input.maxRequests) || input.maxRequests < 2 || input.maxRequests > Math.min(16, scope.maxRequests) ||
    !Number.isInteger(input.targetInputTokens) || input.targetInputTokens < 1024 || input.targetInputTokens > Math.min(8192, scope.targetInputTokens))
    throw new Error("The exact once-authorized cache scope is missing or changed")
  const directory = `${input.approval}.cache-series`
  // Exclusive creation is the cross-process admission fence. Never remove this to retry.
  mkdirSync(directory)
  writeFileSync(path.join(directory, "scope.json"), JSON.stringify({
    approvalSHA256: createHash("sha256").update(bytes).digest("hex"),
    sessionID: input.sessionID, modelID: input.modelID, variant: input.variant,
    maxRequests: input.maxRequests, targetInputTokens: input.targetInputTokens,
  }), { flag: "wx" })
  let used = 0
  return {
    get used() { return used },
    reserve() {
      if (used >= input.maxRequests) throw new Error("Cache request budget exhausted")
      const ordinal = used + 1
      const file = openSync(path.join(directory, `request-${ordinal}.json`), "wx")
      try {
        writeSync(file, JSON.stringify({ ordinal, reservedAt: new Date().toISOString(), state: "consumed-before-transport" }))
        fsyncSync(file)
      } finally { closeSync(file) }
      used = ordinal
      return ordinal
    },
  }
}
