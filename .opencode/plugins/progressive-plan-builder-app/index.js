const ICON = new URL("./assets/progressive-plan-builder.svg", import.meta.url).href

export default {
  id: "progressive-plan-builder-app",
  app(api) {
    api.toolbar.register({
      id: "progressivePlanBuilder",
      defaultVisible: true,
      title: "Progressive Plan Builder",
      tooltip: "Progressive Plan Builder fuer die naechste Nachricht aktivieren",
      placement: "composer",
      align: "right",
      icon: { src: ICON },
      order: 51,
      skill: {
        name: "progressive-plan-builder",
        aliases: ["progressive plan builder", "progressive planning", "plan builder"],
      },
      appendOnSubmit: true,
    })
  },
}
