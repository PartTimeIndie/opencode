const ICON = new URL("./assets/visual-qa.svg", import.meta.url).href

export default {
  id: "visual-qa-app",
  app(api) {
    api.toolbar.register({
      id: "visualQa",
      defaultVisible: true,
      title: "Visual QA",
      tooltip: "Visual QA fuer die naechste Nachricht aktivieren",
      placement: "composer",
      align: "right",
      icon: { src: ICON },
      order: 10,
      skill: {
        name: "visual-qa-testing",
        aliases: ["visual qa", "visual qa testing", "ui testing", "oberflaeche testen"],
      },
      appendOnSubmit: true,
    })
  },
}
