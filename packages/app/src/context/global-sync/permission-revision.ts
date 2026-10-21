const revisions = new WeakMap<object, { current: number; permissions: Map<string, number> }>()

function tracker(store: object) {
  const existing = revisions.get(store)
  if (existing) return existing
  const next = { current: 0, permissions: new Map<string, number>() }
  revisions.set(store, next)
  return next
}

export function permissionRevision(store: object) {
  return tracker(store).current
}

export function markPermissionChanged(store: object, permissionID: string) {
  const state = tracker(store)
  state.current += 1
  state.permissions.set(permissionID, state.current)
}

export function permissionChangedAfter(store: object, permissionID: string, revision: number) {
  return (tracker(store).permissions.get(permissionID) ?? 0) > revision
}
