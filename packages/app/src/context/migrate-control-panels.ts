// Extrahierte Migrationslogik für persistierte ControlPanels-Maps.
// Wird aus layout.tsx importiert, um eine isolierte Test- und Reparatur-Seam zu
// ermöglichen. Der Bug: die frühe `return controlPanels`-Entscheidung prüfte nur
// `Object.keys` der Keys; bei bereits kanonischem Key blieb die berechnete
// Korrektur des inneren `panel.directory` unberücksichtigt.

import { normalizeControlPanelClosedKey } from "./control-panel-key"
import { directoryKey } from "@/utils/path-key"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

export function migrateControlPanels(controlPanels: unknown) {
  if (!isRecord(controlPanels)) return controlPanels
  const closed = isRecord(controlPanels.closed) ? controlPanels.closed : undefined
  const pinned = isRecord(controlPanels.pinned) ? controlPanels.pinned : undefined
  const closedGroups = new Map<string, { sourceID: string; value: unknown }[]>()
  for (const [sourceID, value] of Object.entries(closed ?? {})) {
    const id = normalizeControlPanelClosedKey(sourceID)
    closedGroups.set(id, [...(closedGroups.get(id) ?? []), { sourceID, value }])
  }
  const nextClosed = closed
    ? Object.fromEntries(
        [...closedGroups.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([id, candidates]) => {
            const winner = candidates.toSorted(
              (left, right) =>
                Number(right.value === true) - Number(left.value === true) ||
                Number(right.sourceID === id) - Number(left.sourceID === id) ||
                (left.sourceID < right.sourceID ? -1 : left.sourceID > right.sourceID ? 1 : 0),
            )[0]
            return [id, winner.value]
          }),
      )
    : undefined
  const pinnedGroups = new Map<string, { sourceID: string; panel: unknown }[]>()
  for (const [sourceID, sourcePanel] of Object.entries(pinned ?? {})) {
    const id = normalizeControlPanelClosedKey(sourceID)
    const panel = (() => {
      if (!isRecord(sourcePanel) || typeof sourcePanel.directory !== "string") return sourcePanel
      const directory = directoryKey(sourcePanel.directory)
      // Ein kanonischer Key kann trotzdem eine veraltete innere ID oder ein
      // rohes Directory enthalten und muss dann ebenfalls korrigiert werden.
      if (id === sourceID && directory === sourcePanel.directory && sourcePanel.id === id) return sourcePanel
      return { ...sourcePanel, id, directory }
    })()
    pinnedGroups.set(id, [...(pinnedGroups.get(id) ?? []), { sourceID, panel }])
  }
  const dedupedPinned = pinned
    ? Object.fromEntries(
        [...pinnedGroups.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([id, candidates]) => {
            const winner = candidates.toSorted(
              (left, right) =>
                Number(isRecord(right.panel) && typeof right.panel.directory === "string") -
                  Number(isRecord(left.panel) && typeof left.panel.directory === "string") ||
                Number(right.sourceID === id) - Number(left.sourceID === id) ||
                (left.sourceID < right.sourceID ? -1 : left.sourceID > right.sourceID ? 1 : 0),
            )[0]
            return [id, winner.panel]
          }),
      )
    : undefined
  // Geänderte Inhaltsfelder müssen erkannt werden; serialisiertes Stringifying
  // ist dafür nicht nötig und macht beschädigte Werte fälschlich instabil.
  const closedChanged = nextClosed && !same(Object.keys(nextClosed).sort(), Object.keys(closed ?? {}).sort())
  const pinnedChanged =
    dedupedPinned &&
    (!same(Object.keys(dedupedPinned).sort(), Object.keys(pinned ?? {}).sort()) ||
      Object.entries(dedupedPinned).some(([id, panel]) => {
        const previous = pinned?.[id]
        if (panel === previous) return false
        if (!isRecord(panel) || !isRecord(previous)) return true
        return panel.id !== previous.id || panel.directory !== previous.directory
      }))
  if (!closedChanged && !pinnedChanged) return controlPanels
  return {
    ...controlPanels,
    ...(nextClosed ? { closed: nextClosed } : {}),
    ...(dedupedPinned ? { pinned: dedupedPinned } : {}),
  }
}
