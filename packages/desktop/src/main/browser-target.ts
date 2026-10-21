export async function selectBrowserTarget<T>(input: {
  readonly targets: readonly T[]
  readonly url: string
  readonly targetID?: string
  readonly urlOf: (target: T) => string
  readonly targetIDOf: (target: T) => Promise<string | undefined>
}) {
  if (input.targetID) {
    for (const target of input.targets) {
      if ((await input.targetIDOf(target)) === input.targetID) return target
    }
    return
  }
  const matches = input.targets.filter((target) => input.urlOf(target) === input.url)
  if (matches.length === 1) return matches[0]
}

export function assertBrowserTargetURL(url: string, expectedOrigin?: string) {
  if (!URL.canParse(url)) throw new Error("Browser tools only control HTTP(S) pages in the active Browser Dock tab")
  const target = new URL(url)
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new Error("Browser tools only control HTTP(S) pages in the active Browser Dock tab")
  if (!expectedOrigin || target.origin === expectedOrigin) return
  throw new Error(`The active Browser Dock origin changed from ${expectedOrigin} to ${target.origin}; retry the action`)
}
