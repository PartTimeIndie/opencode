export * as ToolReadBudget from "./tool-read-budget"

// Read-type tools whose call count is budgeted when the feature is enabled.
// These are the tools that caused the read-swarm loops (Pattern 1/2).
const READ_TOOLS = new Set(["read", "glob", "grep", "websearch", "webfetch"])

// Polling-type tools whose exact repetition indicates a self-loop (Pattern 4).
const POLL_TOOLS = new Set(["bash"])

// Default per-session ceiling for read-type tool calls. Generous enough that
// normal focused work is unaffected, but finite so an unbounded read-swarm
// is hard-stopped by the runner rather than running until a provider 429.
const DEFAULT_MAX_READ_CALLS = 30

// Repeating the exact same read request is never evidence gathering after the
// third identical result. Stop that loop well before the broader session cap.
const DEFAULT_MAX_IDENTICAL_READS = 3

// Default per-session ceiling for repeated identical polling-tool calls.
// Above this, the session is likely stuck in an observation-unchanged loop.
const DEFAULT_MAX_POLL_REPEATS = 8

type ReadTool = "read" | "glob" | "grep" | "websearch" | "webfetch"
export type BudgetCategory = "read" | "poll" | "other"
export type ReadLimits = Partial<Record<ReadTool, number>>

export type Budget = {
  readonly check: (
    category: BudgetCategory | string,
    args?: unknown,
  ) => { readonly exceeded: boolean; readonly remaining: number }
}

export interface SessionBudgetStore {
  readonly get: (sessionID: string) => Budget | undefined
  readonly acquire: (sessionID: string, create: () => Budget) => Budget
  readonly settle: (sessionID: string) => void
}

// Creates a per-session tool budget covering both read-swarm prevention (Pattern 1/2)
// and self-loop polling detection (Pattern 4). When disabled (feature toggle off),
// every check passes — identical to baseline behavior.
export function make(
  enabled: boolean,
  maxReads = DEFAULT_MAX_READ_CALLS,
  maxPollRepeats = DEFAULT_MAX_POLL_REPEATS,
  readLimits: ReadLimits = {},
): Budget {
  let readCount = 0
  const readCounts = new Map<ReadTool, number>()
  const readSignatures = new Map<string, number>()
  // Track recent argument signatures per polling tool to detect unchanged observation loops.
  const pollSignatures = new Map<string, number>()
  return {
    check: (inputCategory: BudgetCategory | string, args?: unknown) => {
      if (!enabled) return { exceeded: false, remaining: Infinity }
      const category = normalizeCategory(inputCategory)
      if (category === "read") {
        const readTool = isReadTool(inputCategory) ? inputCategory : "read"
        readCount++
        const toolCount = (readCounts.get(readTool) ?? 0) + 1
        readCounts.set(readTool, toolCount)
        const signature = pollSignature(readTool, args)
        const repeated = (readSignatures.get(signature) ?? 0) + 1
        readSignatures.set(signature, repeated)
        const toolLimit = readLimits[readTool] ?? Infinity
        // The identical-read ceiling bounds sessions without an explicit per-tool
        // ceiling. Explicit ceilings (review/task tool budgets) are the authoritative
        // contract and must permit legitimate re-reads, e.g. re-reading a file after
        // a patch was rejected for stale context.
        const repeatedLimit = toolLimit === Infinity ? DEFAULT_MAX_IDENTICAL_READS : toolLimit
        return {
          exceeded: readCount > maxReads || toolCount > toolLimit || repeated > repeatedLimit,
          remaining: Math.max(
            0,
            Math.min(maxReads - readCount, toolLimit - toolCount, repeatedLimit - repeated),
          ),
        }
      }
      if (category === "poll") {
        const pollTool = POLL_TOOLS.has(inputCategory) ? inputCategory : "poll"
        const sig = pollSignature(pollTool, args)
        const count = (pollSignatures.get(sig) ?? 0) + 1
        pollSignatures.set(sig, count)
        return { exceeded: count > maxPollRepeats, remaining: Math.max(0, maxPollRepeats - count) }
      }
      return { exceeded: false, remaining: Infinity }
    },
  }
}

export function sessionStore(): SessionBudgetStore {
  const budgets = new Map<string, Budget>()
  return {
    get: (sessionID) => budgets.get(sessionID),
    acquire: (sessionID, create) => {
      const existing = budgets.get(sessionID)
      if (existing) return existing
      const budget = create()
      budgets.set(sessionID, budget)
      return budget
    },
    settle: (sessionID) => {
      budgets.delete(sessionID)
    },
  }
}

export function limited(readLimits: ReadLimits) {
  return make(
    true,
    Object.values(readLimits).reduce((total, limit) => total + (limit ?? 0), 0),
    DEFAULT_MAX_POLL_REPEATS,
    readLimits,
  )
}

/** Reviewer tool use is unlimited unless a real agent or task budget was configured. */
export function forSession(input: { reviewer: boolean; enabled: boolean; limits?: ReadLimits }): Budget {
  if (input.limits) return limited(input.limits)
  return make(input.reviewer ? false : input.enabled)
}

// Produce a stable signature for a polling-tool call so identical repeated calls
// (same command / same job lookup) can be detected as an observation-unchanged loop.
function pollSignature(toolName: string, args: unknown): string {
  if (args === undefined || args === null) return toolName
  if (typeof args === "object") {
    // Shell commands have a stable command field; other tool inputs use the complete object.
    const cmd = (args as Record<string, unknown>).command
    if (typeof cmd === "string") return `${toolName}:${cmd}`
  }
  return `${toolName}:${JSON.stringify(args)}`
}

function isReadTool(toolName: string): toolName is ReadTool {
  return READ_TOOLS.has(toolName as ReadTool)
}

function normalizeCategory(inputCategory: BudgetCategory | string): BudgetCategory {
  if (inputCategory === "read" || isReadTool(inputCategory)) return "read"
  if (inputCategory === "poll" || POLL_TOOLS.has(inputCategory)) return "poll"
  return "other"
}
