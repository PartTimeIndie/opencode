import { registerReviewerSettings } from "./settings.js"

const ICON = new URL("./assets/multi-agent-review.svg", import.meta.url).href
const SKILL_REFERENCE = "/multi-agent-review"

export default {
  id: "multi-agent-review-app",
  app(api) {
    registerReviewerSettings(api, "review", "Multi-Agent Review", SKILL_REFERENCE)
    api.toolbar.register({
      id: "multiAgentReview",
      defaultVisible: true,
      title: "Multi-Agent Review",
      tooltip: "Multi-Agent Review fuer die naechste Nachricht aktivieren",
      placement: "composer",
      align: "right",
      icon: { src: ICON },
      order: 30,
      skill: {
        name: "multi-agent-review",
        aliases: ["multi agent review", "code review", "review mit mehreren modellen"],
      },
      appendOnSubmit: true,
    })
  },
}
