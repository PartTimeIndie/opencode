export * as SessionMirror from "./mirror"

import { createHash } from "crypto"
import type { FileMutation } from "../file-mutation"
import { OrchestratorCheckout } from "./orchestrator/checkout"

export type Entry = {
  /** Canonical Main target resolved by the host, not a child-supplied path. */
  readonly target: FileMutation.Target
  readonly basis: Uint8Array | undefined
  readonly child: Uint8Array | undefined
  readonly main: Uint8Array | undefined
}

export type Integration =
  | { readonly status: "ready"; readonly changes: readonly FileMutation.TransactionChange[] }
  | { readonly status: "conflicts"; readonly targets: readonly string[] }

/**
 * Compare B -> K against current M. Inherited dirty Main content is part of B,
 * not child authorship. This prepares guarded writes; it does not establish
 * journal ownership or grant permission to apply them. This is content-only:
 * the owning integration service must separately guard file modes (including
 * executable bits) before it may use this preparation in a live workspace.
 */
export function prepareIntegration(entries: readonly Entry[]): Integration {
  const targets = new Set<string>()
  const conflicts: string[] = []
  const changes: FileMutation.TransactionChange[] = []
  for (const entry of entries) {
    const key = OrchestratorCheckout.pathKey(entry.target.canonical)
    if (targets.has(key)) throw new Error("Duplicate mirror integration target")
    targets.add(key)
    const basis = digest(entry.basis)
    const child = digest(entry.child)
    const main = digest(entry.main)
    // No child delta, or Main already has the child's exact result.
    if (basis === child || main === child) continue
    if (main !== basis) {
      conflicts.push(entry.target.canonical)
      continue
    }
    // Copy all mutable caller-owned values before a later guarded commit.
    const target = { ...entry.target }
    if (entry.child === undefined) {
      if (main === undefined) continue
      changes.push({ type: "delete", target, expected: { exists: true, sha256: main } })
      continue
    }
    const content = new Uint8Array(entry.child)
    if (main === undefined) {
      changes.push({ type: "add", target, content })
      continue
    }
    changes.push({ type: "update", target, content, expected: { exists: true, sha256: main } })
  }
  // Never return a partial patch that a caller could apply while overlooking a
  // conflicting user edit. Technical resolution needs a new explicit staging result.
  if (conflicts.length > 0) return { status: "conflicts", targets: conflicts.sort() }
  return { status: "ready", changes: changes.sort((a, b) => a.target.canonical.localeCompare(b.target.canonical)) }
}

function digest(content: Uint8Array | undefined) {
  return content === undefined ? undefined : createHash("sha256").update(content).digest("hex")
}
