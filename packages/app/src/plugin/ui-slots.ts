export const UI_SLOT_IDS = {
  composerActions: "composer.actions",
  headerActions: "header.actions",
  toolbarActions: "toolbar.actions",
  sessionTabMenu: "session.tab.menu",
} as const

export type UISlotID = (typeof UI_SLOT_IDS)[keyof typeof UI_SLOT_IDS]

const uiSlotIDs = Object.values(UI_SLOT_IDS) as UISlotID[]
const uiSlotIDSet = new Set<string>(uiSlotIDs)

export function listUISlotIDs() {
  return uiSlotIDs
}

export function isUISlotID(slot: string): slot is UISlotID {
  return uiSlotIDSet.has(slot)
}
