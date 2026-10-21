import type { LoggingProfile } from "@/context/settings"

export type ServerLoggingFeatureKey = "trace" | "performance" | "interrupts" | "optimization" | "ui"

export type ServerLogging = {
  profile: LoggingProfile
  features: Record<ServerLoggingFeatureKey, boolean>
}

export function serverLoggingConfig(input: ServerLogging): ServerLogging {
  if (input.profile !== "off") return input
  return {
    profile: input.profile,
    features: Object.fromEntries(Object.keys(input.features).map((key) => [key, false])) as ServerLogging["features"],
  }
}
