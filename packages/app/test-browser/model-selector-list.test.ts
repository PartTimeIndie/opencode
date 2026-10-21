import { expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { createModelSelectorSearch, modelSelectorListOptions } from "../src/components/model-selector"

test("keyboard reads reuse owned search actions instead of creating ownerless JSX", () => {
  const owners: ReturnType<typeof getOwner>[] = []
  const root = createRoot((dispose) => {
    const [state, setState] = createStore({ placeholder: "Search", action: "Chains" })
    const search = createModelSelectorSearch(() => state.placeholder, () => {
      owners.push(getOwner())
      return state.action
    })
    return { search, setState, dispose }
  })
  try {
    const initial = root.search()
    // Event handlers access this memo without a root, like List.handleKey.
    expect(getOwner()).toBeNull()
    expect(root.search()).toBe(initial)
    expect(root.search().action).toBe("Chains")
    expect(owners).toHaveLength(1)
    root.setState("action", "Manage chains")
    expect(root.search().action).toBe("Manage chains")
    expect(owners).toHaveLength(2)
    expect(owners.every((owner) => owner !== null)).toBe(true)
  } finally {
    root.dispose()
  }
})

test("current model and search results stay inactive until explicit keyboard navigation", async () => {
  const list = createRoot((dispose) => ({
    ...useFilteredList({
      ...modelSelectorListOptions,
      items: ["Alpha", "Current", "Zulu"],
      current: "Current",
      key: (item) => item,
    }),
    dispose,
  }))
  try {
    await Bun.sleep(0)
    expect(list.flat()).toEqual(["Alpha", "Current", "Zulu"])
    expect(list.active()).toBe("")
    list.onKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    expect(list.active()).toBe("Alpha")
    list.onInput("Zulu")
    await Bun.sleep(0)
    expect(list.flat()).toEqual(["Zulu"])
    expect(list.active()).toBe("")
    list.onKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    expect(list.active()).toBe("Zulu")
  } finally {
    list.dispose()
  }
})
