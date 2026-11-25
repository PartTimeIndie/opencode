export function registerReviewerSettings(api, key, title, command) {
  let rows = []
  let pending = Promise.resolve()
  const listeners = new Set()
  const notify = () => listeners.forEach((listener) => listener())
  const read = async () => {
    const response = await api.client.global.config.get({ throwOnError: true, signal: api.signal })
    return response.data ?? {}
  }
  const defaults = [{ model: "zhipuai-coding-plan/glm-5.3" }, { model: "openai/gpt-6.1-sol", variant: "high" }]
  const settings = {
    id: "reviewers", title,
    searchTerms: [title, command, "reviewer", "thinking", "multi-agent"],
    searchEntries: () => rows.map((row, index) => ({ title: "Reviewer " + (index + 1) + ": " + row.selection.model,
      description: row.selection.variant, keywords: [row.selection.model, row.selection.variant ?? ""] })),
    storage: {
      read: (_key, fallback) => rows.length ? rows : fallback,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      write(_key, value) {
        const next = structuredClone(value)
        return settings.storage.update(_key, () => next)
      },
      update(_key, updater) {
        const write = async () => {
          if (api.signal.aborted) throw new Error("Plugin has been unloaded")
          const next = structuredClone(updater(structuredClone(rows)))
          if (!Array.isArray(next) || next.length === 0 || next.some((row) => typeof row.selection?.model !== "string" || !row.selection.model.includes("/")))
            throw new Error("Choose a provider model for every reviewer")
          const config = await read()
          await api.client.global.config.update({ configUpdate: { multi_agent: {
            [key]: { ...config.multi_agent?.[key], reviewers: next.map((row) => ({
              model: row.selection.model, ...(row.selection.variant ? { variant: row.selection.variant } : {}),
            })) },
          } } }, { throwOnError: true, signal: api.signal })
          if (api.signal.aborted) return
          rows = next
          notify()
        }
        const result = pending.then(write)
        pending = result.catch(() => {})
        return result
      },
    },
    sections: [{ title: "Reviewer models", actions: [{ id: "reset", label: "Reset defaults",
      run: () => settings.storage.write("reviewers", defaults.map((selection) => ({ selection: { ...selection } }))),
    }], fields: [{
      key: "reviewers", type: "list", label: "Reviewers", description: "Each configured model receives the same read-only task.",
      default: [], addLabel: "Add reviewer", minItems: 1,
      createItem(items) {
        const first = items[0]?.selection
        if (first?.model) return { selection: structuredClone(first) }
        const model = api.ui.models.resolve("default")
        if (!model) throw new Error("Choose a default model before adding a reviewer")
        return { selection: { model: model.providerID + "/" + model.id, ...(model.variant ? { variant: model.variant } : {}) } }
      },
      fields: [{ key: "selection", type: "model-selection", label: "Reviewer model", default: { model: "" } }],
    }] }],
  }
  const registration = api.settings.register(settings)
  api.signal.addEventListener("abort", () => { registration(); listeners.clear() }, { once: true })
  const ready = read().then((config) => {
    if (api.signal.aborted) return
    rows = (config.multi_agent?.[key]?.reviewers ?? defaults).map((selection) => ({ selection }))
    notify()
  }).catch((error) => {
    if (api.signal.aborted) return
    registration()
    api.settings.register({ id: "reviewers", title, sections: [{ title: error instanceof Error ? error.message : "Could not load reviewers", fields: [] }] })
  })
  pending = ready
  return { ready }
}
