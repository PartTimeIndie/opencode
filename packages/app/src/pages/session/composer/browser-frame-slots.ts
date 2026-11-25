type FrameSlot = { element: HTMLElement; visible: () => boolean }

// Registrations belong to mounts, not just IDs. A stale mobile/desktop cleanup
// must never remove the replacement slot with the same owner ID.
export function createBrowserFrameSlots() {
  const slots = new Map<string, FrameSlot>()
  return {
    get(owner: string) {
      const slot = slots.get(owner)
      return slot?.visible() && slot.element.isConnected ? slot.element : undefined
    },
    register(owner: string, element: HTMLElement, visible: () => boolean) {
      const slot = { element, visible }
      slots.set(owner, slot)
      return () => {
        if (slots.get(owner) === slot) slots.delete(owner)
      }
    },
  }
}
