export type CursorCacheModel = {
  id: string
  name: string
  context: number
  images: boolean
  variants: Array<{ id: string; name: string; parameters: Array<{ id: string; value: string }> }>
}


export function cursorLabel(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[()<>&"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function cursorModelsFromCache(raw: unknown): CursorCacheModel[] {
  if (!raw || typeof raw !== "object" || !("models" in raw) || !Array.isArray(raw.models)) return []
  const seen = new Set<string>()
  const models: CursorCacheModel[] = []
  for (const item of raw.models) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string" || record.id.trim() === "") continue
    const id = record.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    const name =
      typeof record.displayName === "string" && record.displayName.trim()
        ? cursorLabel(record.displayName)
        : id
    const context =
      typeof record.maxContext === "number" && Number.isFinite(record.maxContext) && record.maxContext > 0
        ? Math.floor(record.maxContext)
        : 128_000
    models.push({
      id,
      name,
      context,
      images: record.supportsImages === true,
      variants: cursorVariantsFromCache(record.variants, name),
    })
  }
  return models
}

function cursorVariantsFromCache(raw: unknown, modelName: string) {
  if (!Array.isArray(raw)) return []
  const used = new Set<string>()
  const variants: CursorCacheModel["variants"] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.parameterValues)) continue
    const parameters = record.parameterValues.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const parameter = item as Record<string, unknown>
      if (typeof parameter.id !== "string" || typeof parameter.value !== "string") return []
      return [{ id: parameter.id, value: parameter.value }]
    })
    if (parameters.length !== record.parameterValues.length) continue
    const label =
      typeof record.displayName === "string" && record.displayName.trim()
        ? cursorLabel(record.displayName)
        : typeof record.key === "string"
          ? cursorLabel(record.key)
          : ""
    if (!label) continue
    const id = uniqueVariantID(label === modelName ? `${label} default` : label, used)
    used.add(id)
    variants.push({ id, name: id, parameters })
  }
  return variants
}

function uniqueVariantID(label: string, used: Set<string>) {
  if (!used.has(label)) return label
  let index = 2
  while (used.has(`${label} ${index}`)) index++
  return `${label} ${index}`
}

