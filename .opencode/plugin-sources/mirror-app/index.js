const icon = new URL("./assets/mirror.svg", import.meta.url).href

export default {
  id: "mirror-app",
  app(api) {
    api.toolbar.register({
      id: "mirror",
      title: "Mirror",
      tooltip: "Mirror für die nächste Nachricht aktivieren – auch vor dem Sessionstart",
      placement: "composer",
      align: "right",
      order: 25,
      mobile: "visible",
      defaultVisible: true,
      icon: { src: icon },
      skill: { name: "mirror" },
      appendOnSubmit: true,
    })
  },
}
