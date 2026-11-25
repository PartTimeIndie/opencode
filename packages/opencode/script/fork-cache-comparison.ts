import { createHash, randomBytes } from "node:crypto"

export type Observation = { inputTokens?: number; cacheReadInputTokens?: number; body: string }
export type Sample = { ordinal: number; pair: number; role: "main" | "child"; inputTokens: number | null;
  cachedTokens: number | null; ratio: number | null; elapsedMs: number; error?: string }

export function limits(maxRequests: number, targetInputTokens: number) {
  if (!Number.isInteger(maxRequests) || maxRequests < 2 || maxRequests > 16 ||
    !Number.isInteger(targetInputTokens) || targetInputTokens < 1024 || targetInputTokens > 8192)
    throw new Error("Use 2–16 total requests and 1024–8192 estimated input tokens")
  return { maxRequests, targetInputTokens }
}

/** These are actual serialized-body observations, not a cache-hit assertion. */
export function wirePrefix(main: string, child: string) {
  const left = JSON.parse(main)
  const right = JSON.parse(child)
  const { input: _leftInput, messages: _leftMessages, ...leftOptions } = left
  const { input: _rightInput, messages: _rightMessages, ...rightOptions } = right
  if (JSON.stringify(leftOptions) !== JSON.stringify(rightOptions))
    throw new Error("The pair changed its serialized model, instructions, tools or options")
  const a: unknown = left.input ?? left.messages
  const b: unknown = right.input ?? right.messages
  if (!Array.isArray(a) || !Array.isArray(b)) throw new Error("The adapter did not expose a chronological wire prompt")
  const shared: unknown[] = []
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) break
    shared.push(a[index])
  }
  const serialized = JSON.stringify(shared)
  if (!shared.length) throw new Error("Main and child do not share any serialized prompt entries")
  const bytes = Buffer.from(main)
  const other = Buffer.from(child)
  let commonBytes = 0
  while (commonBytes < Math.min(bytes.length, other.length) && bytes[commonBytes] === other[commonBytes]) commonBytes++
  return { entries: shared.length, promptBytes: Buffer.byteLength(serialized), rawBodyPrefixBytes: commonBytes,
    sha256: createHash("sha256").update(serialized).digest("hex") }
}

/** Each pair has one declared seed and one child. A miss, unknown usage, network
 * failure or wire drift stops the series; it never becomes a warm-up/retry lane. */
export async function compare(input: { maxRequests: number; targetInputTokens: number;
  send(input: { pair: number; role: "main" | "child"; family: string; prefix: string }): Promise<Observation> }) {
  const options = limits(input.maxRequests, input.targetInputTokens)
  const samples: Sample[] = []
  const prefixes: ReturnType<typeof wirePrefix>[] = []
  for (let pair = 0; pair < Math.floor(options.maxRequests / 2); pair++) {
    const family = `ocf_${randomBytes(16).toString("hex")}`
    // A fresh random first line isolates each declared pair from earlier pairs.
    const lead = `Synthetic cache comparison ${family}. This is not a commissioned child run.\n`
    const content = "Reference material for the isolated cache comparison. Preserve this exact common prefix.\n"
    const prefix = (lead + content.repeat(Math.ceil(options.targetInputTokens * 4 / content.length))).slice(0, options.targetInputTokens * 4)
    const observations: Observation[] = []
    for (const role of ["main", "child"] as const) {
      const started = performance.now()
      try {
        const observed = await input.send({ pair, role, family, prefix })
        observations.push(observed)
        const tokens = observed.inputTokens
        const cached = observed.cacheReadInputTokens
        const measured = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 &&
          typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0 && cached <= tokens
        const ratio = measured ? cached / tokens : null
        samples.push({ ordinal: samples.length + 1, pair, role, inputTokens: measured ? tokens : null,
          cachedTokens: measured ? cached : null, ratio, elapsedMs: Math.round(performance.now() - started) })
      } catch {
        // Never include a provider error body or credential-bearing request in a report.
        samples.push({ ordinal: samples.length + 1, pair, role, inputTokens: null, cachedTokens: null,
          ratio: null, elapsedMs: Math.round(performance.now() - started), error: "request-or-wire-verification-failed" })
        return { accepted: false, reason: "request-or-wire-verification-failed", samples, prefixes }
      }
      if (role === "child") {
        try { prefixes.push(wirePrefix(observations[0]!.body, observations[1]!.body)) }
        catch { return { accepted: false, reason: "wire-verification-failed", samples, prefixes } }
      }
      const ratio = samples.at(-1)!.ratio
      if (ratio === null) return { accepted: false, reason: "unknown-cache-usage", samples, prefixes }
      if (role === "child" && ratio < 0.8) return { accepted: false, reason: "low-cache-usage", samples, prefixes }
    }
  }
  return { accepted: true, reason: "measured", samples, prefixes }
}
