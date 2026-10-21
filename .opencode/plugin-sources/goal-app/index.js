const ICON = new URL("./assets/goal.svg", import.meta.url).href
const LABEL = "Set the current draft as a session goal"
const GOAL_PREFIX = "/goal "
const COMPOSER_TOOLBAR_ORDER = 55

export default {
  id: "goal-app",
  app(api) {
    api.toolbar.register({
      id: "sessionGoal",
      title: "Session Goal",
      tooltip: LABEL,
      placement: "composer",
      align: "right",
      order: COMPOSER_TOOLBAR_ORDER,
      kind: "mount",
      mobile: "visible",
      defaultVisible: true,
      visible(context) {
        return !!context.directory && !!context.composerID
      },
      enabled(context) {
        return !!context.sessionID
      },
      mount(mountContext) {
        return mountGoal(api, mountContext)
      },
    })
  },
}

function mountGoal(api, mountContext) {
  const toolbarContext = mountContext.context ?? {}
  const button = document.createElement("button")
  const icon = document.createElement("span")
  let error = ""
  const enabled = !!toolbarContext.sessionID
  const mask = `url(${JSON.stringify(ICON).slice(1, -1)}) center / contain no-repeat`

  button.type = "button"
  button.disabled = !enabled
  button.dataset.action = "session-goal"
  button.style.cssText = [
    "width:28px",
    "height:28px",
    "padding:5px",
    "border:1px solid transparent",
    "border-radius:8px",
    "background:transparent",
    "color:var(--v2-icon-icon-base,currentColor)",
    "display:grid",
    "place-items:center",
    `cursor:${enabled ? "pointer" : "not-allowed"}`,
    `opacity:${enabled ? "1" : "0.5"}`,
  ].join(";")
  icon.setAttribute("aria-hidden", "true")
  icon.style.cssText = [
    "display:block",
    "width:18px",
    "height:18px",
    "background:currentColor",
    `-webkit-mask:${mask}`,
    `mask:${mask}`,
  ].join(";")
  button.append(icon)
  mountContext.element.replaceChildren(button)

  const update = () => {
    const label = enabled ? error || LABEL : "Session goals require an existing session"
    button.title = label
    button.setAttribute("aria-label", label)
    button.dataset.state = error ? "error" : enabled ? "idle" : "disabled"
  }
  const onClick = () => {
    error = ""
    if (!enabled) {
      error = "Session goals require an existing session"
      update()
      return
    }
    const composer = api.host.composer.read(toolbarContext)
    if (!composer) {
      error = "Goal composer is not available"
      update()
      return
    }
    if (composer.mode !== "normal") {
      error = "Session goals require normal prompt mode"
      update()
      return
    }

    const text = composer.text
    if (!/^\/goal(?:\s|$)/.test(text.trimStart())) {
      const result = api.host.composer.change({
        ...toolbarContext,
        text: text.trim() ? `${GOAL_PREFIX}${text}` : GOAL_PREFIX,
        expectedText: text,
      })
      if (!result.ok) error = result.error || "Goal composer changed"
    }
    update()
  }
  const cleanup = () => {
    button.removeEventListener("click", onClick)
    mountContext.element.replaceChildren()
  }

  update()
  button.addEventListener("click", onClick)
  mountContext.signal.addEventListener("abort", cleanup, { once: true })
  return cleanup
}
