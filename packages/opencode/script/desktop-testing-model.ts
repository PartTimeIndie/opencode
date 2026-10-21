export function parseDesktopTestingModel(value: string) {
  const separator = value.indexOf("/")
  const providerID = value.slice(0, separator)
  const modelID = value.slice(separator + 1)
  if (separator <= 0 || !modelID) throw new Error("--model must use provider/model")
  return { providerID, modelID }
}

export function parseDesktopTestingSessionModelFlag(value: string, variant?: string) {
  const model = parseDesktopTestingModel(value)
  return {
    providerID: model.providerID,
    id: model.modelID,
    ...(variant ? { variant } : {}),
  }
}
