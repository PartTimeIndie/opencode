export default {
  id: "session-priority-app",
  app(api) {
    api.host.sessions.attention.register("important-results")
    api.slots.register({
      id: "important-session-toggle",
      slot: "session.tab.menu",
      menu: {
        state(target) {
          const enabled = api.host.sessions.attention.get(target)?.enabled ?? false
          return { label: "Wichtige Session markieren", checked: enabled }
        },
        async run(target) {
          const current = api.host.sessions.attention.get(target)
          const ok = await api.host.sessions.attention.set(target, !current?.enabled)
          if (!ok) console.warn("[session-priority] Session could not be marked; check connection and storage")
        },
      },
    })
  },
}
