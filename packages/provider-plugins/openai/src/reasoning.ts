const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_6_PLUS_EFFORTS = [...OPENAI_GPT5_2_PLUS_EFFORTS, "max"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]
const OPENAI_GPT6_LUNA_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh", "max"]
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

export function openaiReasoningEfforts(
  model: { id: string; reasoning?: boolean; release_date: string },
  packageName?: string,
) {
  if (!model.reasoning || packageName !== "@ai-sdk/openai") return []
  const id = model.id.toLowerCase()
  // Astra removed `none`; release-date inference applies only to older families.
  if (/(?:^|\/)gpt-6-astra(?:[.-]|$)/.test(id)) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh", "max"]
  if (/(?:^|\/)gpt-6-luna(?:[.-]|$)/.test(id)) return [...OPENAI_GPT6_LUNA_EFFORTS]
  // GPT-6 Sol-class models and later majors continue the gpt-5.6+ MAX tier, so
  // they keep the none/effort shape of the release-date default plus MAX.
  if (/(?:^|\/)gpt-[6-9](?:[.-]|$)/.test(id)) return ["none", ...WIDELY_SUPPORTED_EFFORTS, "xhigh", "max"]
  if (id.includes("deep-research")) return ["medium"]
  if (GPT5_FAMILY_RE.test(id) && id.includes("-chat")) return GPT5_VERSION_RE.test(id) ? ["medium"] : []
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  if (GPT5_VERSIONED_PRO_RE.test(id)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = Number(GPT5_VERSION_RE.exec(id)?.[1]) || undefined
  if (GPT5_FAMILY_RE.test(id) && id.includes("codex")) {
    if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
    if (id.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
    return WIDELY_SUPPORTED_EFFORTS
  }
  if (version !== undefined && version >= 6) return OPENAI_GPT5_6_PLUS_EFFORTS
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  if (version !== undefined) return OPENAI_GPT5_2_PLUS_EFFORTS
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (model.release_date >= "2025-11-13") efforts.unshift("none")
  if (model.release_date >= "2025-12-04") efforts.push("xhigh")
  return efforts
}

export function openaiReasoningVariants(model: {
  id: string
  reasoning?: boolean
  release_date: string
  variants: { id: string }[]
}) {
  return openaiReasoningEfforts(model, "@ai-sdk/openai")
    .filter((id) => !model.variants.some((variant) => variant.id === id))
    .map((id) => ({
      id,
      headers: {},
      body: {},
      generation: {},
      options: { reasoningEffort: id, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    }))
}
