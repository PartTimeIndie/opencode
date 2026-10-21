import { registerReviewerSettings } from "./settings.js"
const ICON = new URL("./assets/multi-agent-review.svg", import.meta.url).href
const SKILL_REFERENCE = "/multi-agent-review"
const LABEL = "Multi-Agent Review fuer die naechste Nachricht aktivieren"
const COMPOSER_TOOLBAR_ORDER = 30

export default {
  id: "multi-agent-review-app",
  app(api) {
    registerReviewerSettings(api, "review", "Multi-Agent Review", SKILL_REFERENCE)
    const activeByMount = new WeakMap()
    api.toolbar.register({
      id: "multiAgentReview",
      defaultVisible: true,
      title: "Multi-Agent Review",
      tooltip: LABEL,
      placement: "composer",
      align: "right",
      kind: "mount",
      order: COMPOSER_TOOLBAR_ORDER,
      skill: {
        name: "multi-agent-review",
        aliases: ["multi agent review", "code review", "review mit mehreren modellen"],
      },
      mount(context) {
        return mountToggle(api, context, activeByMount)
      },
    })
  },
}

function mountToggle(api, mountContext, activeByMount) {
  const toolbarContext = mountContext.context ?? {}
  const previous = activeByMount.get(mountContext.element)
  const state = {
    active:
      previous?.directory === toolbarContext.directory &&
      previous?.sessionID === toolbarContext.sessionID &&
      previous?.composerID === toolbarContext.composerID &&
      previous.active === true,
  }
  const button = document.createElement("button")
  const icon = document.createElement("span")

  button.type = "button"
  button.title = LABEL
  button.setAttribute("aria-label", LABEL)
  button.className = "oc-multi-agent-review-toggle"
  button.style.cssText = [
    "width:28px",
    "height:28px",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "border-radius:8px",
    "border:1px solid transparent",
    "background:transparent",
    "color:var(--v2-icon-icon-base,currentColor)",
    "cursor:pointer",
    "padding:0",
    "transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease",
  ].join(";")

  icon.setAttribute("aria-hidden", "true")
  icon.style.cssText = [
    "width:18px",
    "height:18px",
    "display:block",
    "background:currentColor",
    `-webkit-mask:url(${JSON.stringify(ICON).slice(1, -1)}) center / contain no-repeat`,
    `mask:url(${JSON.stringify(ICON).slice(1, -1)}) center / contain no-repeat`,
  ].join(";")
  button.append(icon)
  mountContext.element.replaceChildren(button)

  const update = () => {
    activeByMount.set(mountContext.element, {
      active: state.active,
      directory: toolbarContext.directory,
      sessionID: toolbarContext.sessionID,
      composerID: toolbarContext.composerID,
    })
    button.setAttribute("aria-pressed", String(state.active))
    button.style.background = state.active ? "var(--v2-background-bg-subtle,rgba(255,255,255,0.08))" : "transparent"
    button.style.borderColor = state.active ? "var(--v2-border-border-muted,transparent)" : "transparent"
    button.style.color = "var(--v2-icon-icon-base,currentColor)"
    button.style.boxShadow = "none"
  }
  const onClick = () => {
    state.active = !state.active
    update()
  }
  const onBeforeSubmit = (detail) => {
    if (!state.active) return
    if (detail.mode !== "normal") return


    if (!hasSkillReference(typeof detail.getText === "function" ? detail.getText() : "")) {
      detail.appendText(SKILL_REFERENCE)
    }
    state.active = false
    update()
  }

  update()
  button.addEventListener("click", onClick)
  const unsubscribe = api.host.composer.beforeSubmit(toolbarContext, onBeforeSubmit)
  return () => {
    button.removeEventListener("click", onClick)
    unsubscribe()
  }
}

function hasSkillReference(text) {
  return /(?:^|\s)\/multi-agent-review(?:\s|$)/.test(text)
}
