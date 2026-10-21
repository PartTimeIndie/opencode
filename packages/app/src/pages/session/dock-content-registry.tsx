import {
  createContext,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"

export type DockContentParts = {
  header: JSX.Element
  review: JSX.Element
  changes: JSX.Element
  files: JSX.Element
  bottom: () => JSX.Element
  mobileChanges: JSX.Element
  mobileChangesOpen: () => boolean
  onResponseSubmit?: () => void
}

export type DockContentRegistry = {
  parts: Accessor<DockContentParts | undefined>
  register(parts: DockContentParts): void
}

// Dock panes render content owned by the routed session page; the shell itself is
// server-scoped and outlives every routed subtree. Registration lives under the
// registering component's owner, so disposing that subtree (directory switch)
// clears all panes atomically and the shell falls back to placeholders.
export function createDockContentRegistry(): DockContentRegistry {
  const [parts, setParts] = createSignal<DockContentParts>()
  return {
    parts,
    register(next) {
      const owner = getOwner()
      const registered = owner
        ? { ...next, bottom: () => runWithOwner(owner, next.bottom) }
        : next
      setParts(registered)
      onCleanup(() => {
        setParts((current) => (current === registered ? undefined : current))
      })
    },
  }
}

const DockContentContext = createContext<DockContentRegistry>()

export function DockContentProvider(props: ParentProps) {
  const registry = createDockContentRegistry()
  return <DockContentContext.Provider value={registry}>{props.children}</DockContentContext.Provider>
}

export function useDockContent(): DockContentRegistry {
  const registry = useContext(DockContentContext)
  if (!registry) throw new Error("useDockContent must be used inside <DockContentProvider>")
  return registry
}
