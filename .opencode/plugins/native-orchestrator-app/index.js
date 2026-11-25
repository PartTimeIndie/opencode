const icon = new URL("./assets/native-orchestrator.svg", import.meta.url).href

export default {
  id: "native-orchestrator-app",
  app(api) {
    api.toolbar.register({
      id: "native-orchestrator",
      title: "Nativer Orchestrator",
      tooltip: "Erst gemeinsam planen, dann Konversations-Forks zur Umsetzung erstellen",
      placement: "composer",
      align: "right",
      order: 24,
      mobile: "visible",
      defaultVisible: true,
      icon: { src: icon },
      skill: { name: "native-orchestrator" },
      appendOnSubmit: true,
    })
  },
}
