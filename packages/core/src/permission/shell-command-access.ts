export * as ShellCommandAccess from "./shell-command-access"

export type Classification = "read" | "observation" | "other"

const FILE_OBSERVATION_COMMANDS = new Set([
  "awk",
  "cat",
  "dir",
  "fd",
  "find",
  "file",
  "get-childitem",
  "get-content",
  "gci",
  "gc",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "rg",
  "sed",
  "select-string",
  "sls",
  "stat",
  "strings",
  "tail",
  "type",
  "wc",
])

const SAFE_OBSERVATION_COMMANDS = new Set(["ffprobe", "get-command", "where", "where.exe"])
const FILE_GIT_COMMANDS = new Set(["blame", "cat-file", "diff", "grep", "log", "show"])
const SAFE_GIT_COMMANDS = new Set(["rev-parse", "status"])
const MUTATING_GIT_COMMANDS = new Set(["add", "commit", "push"])
const MUTATING_COMMANDS = new Set([
  "chown",
  "chmod",
  "curl",
  "del",
  "erase",
  "invoke-webrequest",
  "reg",
  "reg.exe",
  "remove-item",
  "rm",
  "rmdir",
  "sc",
  "sc.exe",
  "set-service",
  "start-process",
  "stop-process",
])
const SHELL_WRAPPERS = new Set(["bash", "cmd", "powershell", "pwsh", "sh", "wsl", "zsh"])
const GIT_COMMAND_PREFIXES = new Set(["command", "env", "exec", "nice", "nohup", "sudo", "time"])
const GIT_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
])

export function classify(command: string): Classification {
  const segments = splitSegments(command)
  if (segments.some(isFileObservationSegment)) return "read"
  if (segments.some(isMutatingSegment)) return "other"
  if (segments.some(isSafeObservationSegment)) return "observation"
  return "other"
}

export function isLowRisk(command: string) {
  const segments = splitSegments(command)
  return !segments.some(isMutatingSegment) && classify(command) !== "other"
}

function splitSegments(command: string) {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | "`" | undefined
  let escaped = false
  for (const character of command) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote !== undefined) {
      current += character
      if (character === "\\" && quote !== "`") escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      current += character
      continue
    }
    if ([";", "|", "&", "\r", "\n"].includes(character)) {
      if (current.trim()) segments.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function isFileObservationSegment(segment: string) {
  return (
    commandNames(segment).some((name) => FILE_OBSERVATION_COMMANDS.has(name)) ||
    nestedPowerShellCommands(segment).some((name) => FILE_OBSERVATION_COMMANDS.has(name)) ||
    gitSubcommands(segment).some((name) => FILE_GIT_COMMANDS.has(name))
  )
}

function nestedPowerShellCommands(segment: string) {
  const tokens = tokenize(maskQuotedText(segment))
  return tokens.filter((token, index) => {
    if (!FILE_OBSERVATION_COMMANDS.has(normalizeToken(token))) return false
    const previous = tokens[index - 1]
    return previous === "{" || previous === "(" || previous === ";" || previous === "|" || previous === "&"
  })
}

function maskQuotedText(value: string) {
  let quote: "'" | '"' | "`" | undefined
  let escaped = false
  return [...value]
    .map((character) => {
      if (escaped) {
        escaped = false
        return quote === undefined ? character : " "
      }
      if (quote !== undefined) {
        if (character === "\\" && quote !== "`") escaped = true
        else if (character === quote) quote = undefined
        return " "
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character
        return " "
      }
      return character
    })
    .join("")
}

function isSafeObservationSegment(segment: string) {
  const tokens = tokenize(segment)
  const names = commandNames(segment)
  if (names.some((name) => SAFE_OBSERVATION_COMMANDS.has(name))) return true
  if (gitSubcommands(segment).some((name) => SAFE_GIT_COMMANDS.has(name))) return true
  return tokens.some((token) => /(?:test.*\.ps1|invoke-.*tests.*\.ps1)/i.test(token))
}

function isMutatingSegment(segment: string) {
  const tokens = tokenize(segment)
  const names = commandNames(segment)
  if (names.some((name) => MUTATING_COMMANDS.has(name))) return true
  return gitSubcommands(segment).some((name) => MUTATING_GIT_COMMANDS.has(name))
}

function gitSubcommands(segment: string): string[] {
  const tokens = leadingCommandTokens(tokenize(segment))
  if (!tokens.length) return []

  const first = normalizeToken(tokens[0])
  if (SHELL_WRAPPERS.has(first)) {
    const commandIndex = wrapperCommandIndex(tokens)
    if (commandIndex === -1) return []
    return splitSegments(tokens.slice(commandIndex + 1).join(" ")).flatMap(gitSubcommands)
  }

  const gitIndex = findGitIndex(tokens)
  if (gitIndex === -1) return []
  const subcommand = gitSubcommand(tokens, gitIndex)
  return subcommand ? [subcommand] : []
}

function findGitIndex(tokens: ReadonlyArray<string>) {
  const first = normalizeToken(tokens[0] ?? "")
  if (first === "git") return 0
  if (!GIT_COMMAND_PREFIXES.has(first)) return -1
  const gitIndex = tokens.findIndex((token, index) => index > 0 && normalizeToken(token) === "git")
  if (gitIndex === -1) return -1
  if (tokens.slice(1, gitIndex).some((token) => !token.startsWith("-") && !token.includes("="))) return -1
  return gitIndex
}

function gitSubcommand(tokens: ReadonlyArray<string>, gitIndex: number) {
  const argumentsAfterGit = tokens.slice(gitIndex + 1)
  for (let index = 0; index < argumentsAfterGit.length; index++) {
    const token = argumentsAfterGit[index]
    const normalized = normalizeToken(token)
    const option = normalized.split("=", 1)[0]
    if (GIT_OPTIONS_WITH_VALUES.has(option)) {
      if (!normalized.includes("=")) index++
      continue
    }
    if (normalized === "--") return normalizeToken(argumentsAfterGit[index + 1] ?? "")
    if (normalized.startsWith("-c") && normalized.length > 2) continue
    if (normalized.startsWith("-")) continue
    return normalized
  }
  return undefined
}

function commandNames(segment: string): string[] {
  const tokens = leadingCommandTokens(tokenize(segment))
  if (!tokens.length) return []
  const first = normalizeToken(tokens[0])
  if (!SHELL_WRAPPERS.has(first)) return [first]
  const commandIndex = wrapperCommandIndex(tokens)
  if (commandIndex === -1) return [first]
  return splitSegments(tokens.slice(commandIndex + 1).join(" ")).flatMap(commandNames)
}

function wrapperCommandIndex(tokens: ReadonlyArray<string>) {
  return tokens.findIndex(
    (token, index) => index > 0 && ["-c", "/c", "-command"].includes(token.toLowerCase()),
  )
}

function leadingCommandTokens(tokens: ReadonlyArray<string>) {
  const firstIndex = tokens.findIndex((token, index) => {
    const normalized = normalizeToken(token)
    if (normalized === "&" || normalized === "call") return false
    if (token.startsWith("$")) return token.includes("=") || tokens[index + 1] === "="
    return !token.includes("=")
  })
  if (firstIndex === -1) return []

  const first = tokens[firstIndex]
  if (first.startsWith("$") && first.includes("=")) {
    const value = first.slice(first.indexOf("=") + 1)
    return value ? [value, ...tokens.slice(firstIndex + 1)] : tokens.slice(firstIndex + 1)
  }
  if (first.startsWith("$") && tokens[firstIndex + 1] === "=") return tokens.slice(firstIndex + 2)
  return tokens.slice(firstIndex)
}

function tokenize(segment: string) {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | "`" | undefined
  let escaped = false
  for (const character of segment) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote !== undefined) {
      if (character === "\\" && quote !== "`") {
        escaped = true
        continue
      }
      if (character === quote) {
        quote = undefined
        continue
      }
      current += character
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (/\s/.test(character) || "{}();|&".includes(character)) {
      if (current) tokens.push(current)
      current = ""
      if (!/\s/.test(character)) tokens.push(character)
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  return tokens
}

function normalizeToken(token: string) {
  return (token.replaceAll("\\", "/").split("/").at(-1) ?? "")
    .toLowerCase()
    .replace(/\.(?:bat|cmd|exe|ps1)$/i, "")
}
