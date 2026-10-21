export function composerModelLoading(input: {
  directoryLoading: boolean
  directoryHasProviders: boolean
  globalLoading: boolean
  retrying: boolean
}) {
  if (input.retrying) return true
  if (input.directoryLoading) return true
  if (input.directoryHasProviders) return false
  return input.globalLoading
}
