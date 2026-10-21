export * as McpNaming from "./naming"

import { createHash } from "node:crypto"

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export function prompt(clientName: string, name: string) {
  return `${sanitize(clientName)}:${sanitize(name)}`
}

export function tool(clientName: string, name: string) {
  const source = `${clientName}\0${name}`
  const client = sanitize(clientName)
  const tool = sanitize(name)
  let result = `${client}_${tool}`
  const prefixed = !/^[A-Za-z]/.test(result)
  if (prefixed) result = `mcp_${result}`
  const ambiguous = client !== clientName || tool !== name || prefixed
  if (!ambiguous && result.length <= 64) return result
  const suffix = createHash("sha256").update(source).digest("hex").slice(0, 10)
  return `${result.slice(0, 53)}_${suffix}`
}
