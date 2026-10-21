export * as LayoutRegions from "./layout-regions"

export const regions = ["timeline", "composer", "docks", "popup-layer"] as const
export type Region = (typeof regions)[number]

const interactive: ReadonlySet<Region> = new Set(["timeline", "composer", "docks"])

/**
 * Declarative region placement (U3). Free overlays over interactive regions
 * are not expressible; popups occupy `popup-layer` and never cover composer.
 */
export function canOverlay(over: Region, under: Region): boolean {
  if (over === under) return false
  if (over !== "popup-layer") return false
  return under !== "composer"
}

export function assertPlacement(placement: { readonly region: Region; readonly overlay?: Region }): void {
  if (placement.overlay !== undefined && !canOverlay(placement.overlay, placement.region)) {
    throw new Error(`overlay ${placement.overlay} cannot cover ${placement.region}`)
  }
}

export function popupFirst(explicitDock: boolean): Region {
  return explicitDock ? "docks" : "popup-layer"
}
