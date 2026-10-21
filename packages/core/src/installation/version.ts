declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
// Treat the install as local whenever the channel is "local" or the version is the
// unresolved "local" placeholder. Both happen for unbundled dev runs where
// OPENCODE_CHANNEL may be defined (e.g. "dev" via vite define) but OPENCODE_VERSION
// is not, which would otherwise leak the literal "local" into npm dependency pins.
export const InstallationLocal = InstallationChannel === "local" || InstallationVersion === "local"
