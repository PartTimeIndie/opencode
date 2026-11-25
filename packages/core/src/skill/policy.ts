export * as SkillPolicy from "./policy"

/**
 * Pure skill invocation/visibility policy resolution.
 *
 * Precedence, highest first: explicit agent entry → explicit global entry →
 * legacy default (frontmatter `disable-model-invocation` or the global legacy
 * `manual` list) → built-in default (visible, invocation allow).
 *
 * `hiddenByMetadata` receives the skill's `disableModelInvocation` flag as the
 * catalog currently stores it. Because the legacy global manual list is
 * overlaid onto that flag before resolution, both hidden sources collapse into
 * the same hidden+manual default; the recorded source only reports which layer
 * supplied it.
 */
export type InvocationMode = "allow" | "ask" | "manual" | "deny"

export type SkillPolicyEntry = {
  visible?: boolean | undefined
  invocation?: InvocationMode | undefined
}

export type PolicySource = "metadata" | "legacy-manual" | "global-entry" | "agent-entry"

export type Field<T> = { value: T; source: PolicySource }

export type Resolved = {
  visible: Field<boolean>
  invocation: Field<InvocationMode>
}

export const defaultInvocation: InvocationMode = "allow"

export function resolve(input: {
  hiddenByMetadata: boolean
  listedAsManual: boolean
  globalEntry?: SkillPolicyEntry | undefined
  agentEntry?: SkillPolicyEntry | undefined
}): Resolved {
  const hiddenByDefault = input.hiddenByMetadata || input.listedAsManual
  const hiddenSource: PolicySource = input.hiddenByMetadata ? "metadata" : "legacy-manual"
  const unhiddenSource: PolicySource = "metadata"
  const visible: Field<boolean> =
    input.agentEntry?.visible !== undefined
      ? { value: input.agentEntry.visible, source: "agent-entry" }
      : input.globalEntry?.visible !== undefined
        ? { value: input.globalEntry.visible, source: "global-entry" }
        : { value: !hiddenByDefault, source: hiddenByDefault ? hiddenSource : unhiddenSource }
  const invocation: Field<InvocationMode> =
    input.agentEntry?.invocation !== undefined
      ? { value: input.agentEntry.invocation, source: "agent-entry" }
      : input.globalEntry?.invocation !== undefined
        ? { value: input.globalEntry.invocation, source: "global-entry" }
        : hiddenByDefault
          ? { value: "manual", source: hiddenSource }
          : { value: defaultInvocation, source: "metadata" }
  return { visible, invocation }
}

export type GlobalInvocationPolicy = {
  manual?: readonly string[] | undefined
  entries?: Record<string, SkillPolicyEntry | undefined> | undefined
}

/** Resolve the effective policy for one skill against global and agent layers. */
export function resolveForSkill(input: {
  skill: { name: string; disableModelInvocation?: boolean | undefined }
  global?: GlobalInvocationPolicy | undefined
  agentSkills?: Record<string, SkillPolicyEntry | undefined> | undefined
}): Resolved {
  const name = input.skill.name
  const globalEntry = input.global?.entries?.[name]
  const agentEntry = input.agentSkills?.[name]
  const listedAsManual = input.global?.manual?.includes(name) === true
  return resolve({
    hiddenByMetadata: input.skill.disableModelInvocation === true,
    listedAsManual,
    globalEntry,
    agentEntry,
  })
}

/** Resolve policies for many skills at once. */
export function policiesFor(
  skills: ReadonlyArray<{ name: string; disableModelInvocation?: boolean | undefined }>,
  global?: GlobalInvocationPolicy | undefined,
  agentSkills?: Record<string, SkillPolicyEntry | undefined> | undefined,
): Map<string, Resolved> {
  return new Map(skills.map((skill) => [skill.name, resolveForSkill({ skill, global, agentSkills })]))
}

/**
 * Execution gate shared by the skill tool and the skill command entry point.
 * Returns the blocking reason or undefined when the load may proceed.
 * `explicitlySelected` is genuine user intent only (anchored slash, toolbar
 * submission, or command selection); it can satisfy `manual` and `ask`, never `deny`.
 */
export function admissionGate(
  policy: Resolved,
  input: { explicitlySelected: boolean },
): "deny" | "manual" | undefined {
  if (policy.invocation.value === "deny") return "deny"
  if (policy.invocation.value === "manual" && !input.explicitlySelected) return "manual"
  return undefined
}

/** The extra permission ask layer for ask-mode skills without explicit selection. */
export function askRules(policy: Resolved, name: string, input: { explicitlySelected: boolean }) {
  if (policy.invocation.value !== "ask" || input.explicitlySelected) return undefined
  return [{ action: "skill", resource: name, effect: "ask" as const }]
}
