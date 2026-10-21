const ICON = new URL("./assets/runtime-services-icon.svg", import.meta.url).href

export default {
  id: "runtime-services-app",
  app(api) {
    const state = {
      services: [],
      error: "",
      notice: "",
      busy: false,
      panels: new Set(),
      actionBusy: new Set(),
      sessionBusy: new Set(),
      operations: new Map(),
      operationPolls: new Map(),
      details: new Map(),
      editor: undefined,
      confirmDelete: undefined,
      acknowledgeOperation: undefined,
      projectPicker: undefined,
    }
    api.commands.register({
      id: "runtimeServices.open",
      title: "Open Runtime Services",
      run() {
        api.dock.open.item("runtimeServices", { area: "left" })
      },
    })
    api.dock.register({
      id: "runtimeServices",
      title: "Runtime Services",
      icon: ICON,
      defaultArea: "left",
      minWidth: 300,
      minHeight: 240,
      preferredWidth: 520,
      preferredHeight: 620,
      mount(context) {
        const view = document.createElement("div")
        const render = () => renderPanel(api, state, view)
        state.panels.add(render)
        context.element.replaceChildren(view)
        const abort = () => {
          state.panels.delete(render)
          context.element.replaceChildren()
        }
        context.signal.addEventListener("abort", abort, { once: true })
        render()
        void refresh(api, state)
        return abort
      },
    })
  },
}

function renderAll(state) {
  for (const render of state.panels) render()
}

async function request(api, serviceID, input = {}) {
  if (!api.services?.call) throw new Error("Runtime Services requires a host with plugin service support.")
  const response = await api.services.call({ pluginID: "opencode-runtime-services", serviceID, version: 1, input })
  if (!response.ok) throw new Error(`Runtime Services backend unavailable: ${response.error}`)
  const body = response.data
  if (!body?.ok) {
    const error = new Error(body?.error || "Runtime Services returned an invalid result")
    error.status = body?.status
    error.body = body
    throw error
  }
  return body.data
}

async function refresh(api, state) {
  if (state.busy) return
  state.busy = true
  state.error = ""
  renderAll(state)
  try {
    const body = await request(api, "list", { fresh: true })
    state.services = Array.isArray(body?.services) ? body.services : []
    state.details.clear()
    state.error = body?.warning || ""
    const retained = await request(api, "operations")
    if (!Array.isArray(retained)) throw new Error("Runtime Services returned an invalid operation inventory.")
    hydrateOperations(api, state, retained)
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    state.busy = false
    renderAll(state)
  }
}

async function loadDetail(api, state, service) {
  const existing = state.details.get(service.name)
  if (existing) return existing
  const detail = await request(api, "detail", { name: service.name })
  state.details.set(service.name, detail)
  return detail
}

function renderPanel(api, state, view) {
  const root = element("section", "oc-runtime-services")
  root.append(styleNode())
  const header = element("header", "oc-runtime-services__header")
  const title = element("div")
  title.append(text("strong", "Runtime Services"), text("span", "Persistent NSSM/Windows services. Scheduled Jobs remain separate."))
  header.append(title, button(state.busy ? "Refreshing…" : "Refresh", "secondary", () => void refresh(api, state), state.busy))
  root.append(header)
  if (state.error) root.append(text("p", state.error, "oc-runtime-services__warning"))
  if (state.notice) root.append(text("p", state.notice, "oc-runtime-services__notice"))
  if (state.operations.size) root.append(renderOperations(api, state))
  if (!state.services.length && !state.busy) root.append(text("p", "No NSSM-managed services found.", "oc-runtime-services__empty"))
  const list = element("div", "oc-runtime-services__list")
  for (const service of state.services) list.append(renderService(api, state, service))
  root.append(list)
  if (state.confirmDelete) root.append(renderDeleteConfirmation(api, state))
  if (state.acknowledgeOperation) root.append(renderOperationAcknowledgement(api, state))
  if (state.projectPicker) root.append(renderProjectPicker(api, state))
  view.replaceChildren(root)
}

function renderService(api, state, service) {
  const row = element("article", "oc-runtime-services__service")
  row.dataset.serviceName = service.name
  const heading = element("div", "oc-runtime-services__service-heading")
  const identity = element("div")
  identity.append(text("strong", service.displayName || service.name), text("span", service.name))
  heading.append(identity, status(service))
  row.append(heading)
  row.append(text("p", service.description || service.name, "oc-runtime-services__description"))
  const actions = element("div", "oc-runtime-services__actions")
  const busy = state.actionBusy.has(service.name)
  actions.append(
    button(state.editor?.service.name === service.name ? "Close editor" : "Edit", "secondary", () => void toggleEditor(api, state, service), busy),
    button(service.state === "Running" ? "Stop" : "Start", "secondary", () => void runAction(api, state, service, service.state === "Running" ? "stop" : "start"), busy),
    button("Restart", "secondary", () => void runAction(api, state, service, "restart"), busy),
    button("Disable", "secondary", () => void runAction(api, state, service, "disable"), busy),
    button("Delete", "danger", () => {
      state.confirmDelete = service
      renderAll(state)
    }, busy),
    button(state.sessionBusy.has(service.name) ? "Opening session…" : "Revise with agent", "primary", () => void prepareSession(api, state, service), state.sessionBusy.has(service.name)),
  )
  row.append(actions)
  if (state.editor?.service.name === service.name) row.append(renderEditor(api, state))
  return row
}

function status(service) {
  const value = element("span", "oc-runtime-services__status")
  value.dataset.state = String(service.state || "unknown").toLowerCase()
  value.textContent = `${service.state || "Unknown"} · ${service.startMode || "Unknown"} · NSSM${service.processId ? ` · PID ${service.processId}` : ""}`
  return value
}

function operationFromError(error, context) {
  if (error?.status !== 202 || !error.body?.operationID) return
  return {
    id: error.body.operationID,
    status: error.body.code === "elevation_indeterminate" ? "indeterminate" : "pending",
    code: error.body.code,
    error: error.body.error || error.message,
    ...context,
  }
}

function hydrateOperations(api, state, retained) {
  const ids = new Set()
  for (const current of retained) {
    if (!current || typeof current.id !== "string" || typeof current.status !== "string") continue
    ids.add(current.id)
    const existing = state.operations.get(current.id) || {}
    const serviceName = current.serviceName || existing.serviceName
    const service = state.services.find((item) => item.name === serviceName)
    const operation = Object.assign(existing, current, {
      serviceName,
      serviceLabel: existing.serviceLabel || service?.displayName || serviceName || "Retained elevated operation",
      kind: current.kind || existing.kind,
      action: current.action || existing.action,
      pollError: "",
    })
    state.operations.set(current.id, operation)
    if (operation.status === "pending") void pollOperation(api, state, operation.id)
  }
  for (const id of state.operations.keys()) {
    if (!ids.has(id)) state.operations.delete(id)
  }
}

function trackOperation(api, state, operation) {
  state.operations.set(operation.id, operation)
  state.notice = operation.status === "pending"
    ? `${operation.serviceLabel}: elevated operation pending. No success has been recorded.`
    : ""
  renderAll(state)
  if (operation.status === "pending") void pollOperation(api, state, operation.id)
}

function pollOperation(api, state, id) {
  const existing = state.operationPolls.get(id)
  if (existing) return existing
  const polling = (async () => {
    let waitMs = 750
    while (state.operations.get(id)?.status === "pending") {
      await delay(waitMs)
      const operation = state.operations.get(id)
      if (!operation || operation.status !== "pending") return
      try {
        const current = await request(api, "operation", { operationID: id })
        Object.assign(operation, current, { pollError: "" })
        waitMs = Math.min(waitMs * 2, 5_000)
        renderAll(state)
        if (operation.status !== "pending") await finishOperation(api, state, operation)
      } catch (error) {
        operation.pollError = `Status check failed; the outcome is not confirmed. ${message(error)}`
        waitMs = 5_000
        renderAll(state)
      }
    }
  })().finally(() => state.operationPolls.delete(id))
  state.operationPolls.set(id, polling)
  return polling
}

async function finishOperation(api, state, operation) {
  if (operation.status !== "succeeded") {
    state.notice = ""
    renderAll(state)
    return
  }
  state.details.delete(operation.serviceName)
  if (operation.kind === "patch" && state.editor?.service.name === operation.serviceName) state.editor = undefined
  state.notice = operation.kind === "patch"
    ? `${operation.serviceLabel} was updated.`
    : operation.action === "delete"
      ? `${operation.serviceLabel} was deleted.`
      : `${operation.serviceLabel}: ${operation.action} completed.`
  await refresh(api, state)
}

function renderOperations(api, state) {
  const section = element("section", "oc-runtime-services__operations")
  section.append(
    text("h3", "Elevated operations"),
    text("p", "Pending and uncertain operations stay visible until their final status is confirmed or their evidence is explicitly removed."),
  )
  for (const operation of state.operations.values()) {
    const card = element("article", "oc-runtime-services__operation")
    card.dataset.operationId = operation.id
    card.dataset.status = operation.status
    const heading = element("div", "oc-runtime-services__operation-heading")
    heading.append(
      text("strong", operation.serviceLabel),
      text("span", operationStatusLabel(operation.status), "oc-runtime-services__operation-status"),
    )
    card.append(heading)
    card.append(text("code", operation.id))
    if (operation.error) card.append(text("p", operation.error, "oc-runtime-services__operation-message"))
    if (operation.pollError) card.append(text("p", operation.pollError, "oc-runtime-services__warning"))
    if (operation.status === "indeterminate") {
      card.append(text(
        "p",
        "The service may still have changed. Verify it independently. Acknowledging this uncertainty deletes the retained operation evidence; it does not stop or roll back the service.",
        "oc-runtime-services__warning",
      ))
    }
    const actions = element("div", "oc-runtime-services__actions")
    if (operation.status === "pending") {
      actions.append(button("Check status", "secondary", () => void pollOperation(api, state, operation.id), Boolean(state.operationPolls.get(operation.id))))
    }
    if (operation.status === "indeterminate") {
      actions.append(button("Acknowledge uncertainty…", "danger", () => {
        state.acknowledgeOperation = { operation, confirmed: false }
        renderAll(state)
      }, operation.cleanupBusy))
    }
    if (operation.status === "succeeded" || operation.status === "failed" || operation.status === "timed_out") {
      actions.append(button(operation.cleanupBusy ? "Removing…" : "Remove evidence", "secondary", () => void cleanupTrackedOperation(api, state, operation, false), operation.cleanupBusy))
    }
    card.append(actions)
    section.append(card)
  }
  return section
}

function operationStatusLabel(status) {
  if (status === "pending") return "Pending — waiting for elevated helper"
  if (status === "succeeded") return "Succeeded"
  if (status === "failed") return "Failed"
  if (status === "timed_out") return "Timed out"
  return "Indeterminate — outcome not confirmed"
}

function renderOperationAcknowledgement(api, state) {
  const acknowledgement = state.acknowledgeOperation
  const overlay = element("div", "oc-runtime-services__overlay")
  const dialog = element("section", "oc-runtime-services__dialog")
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-modal", "true")
  dialog.setAttribute("aria-label", "Acknowledge an indeterminate outcome?")
  dialog.append(
    text("h3", "Acknowledge an indeterminate outcome?"),
    text("p", "OpenCode cannot confirm whether the elevated operation changed the service. Verify the service independently before continuing."),
    text("p", "Continuing permanently deletes the retained operation evidence and writes an acknowledgement to the Runtime Services audit trail. It does not stop or roll back the service."),
  )
  const confirmation = element("label", "oc-runtime-services__acknowledgement")
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.checked = acknowledgement.confirmed
  checkbox.addEventListener("change", () => {
    acknowledgement.confirmed = checkbox.checked
    renderAll(state)
  })
  confirmation.append(checkbox, document.createTextNode(" I understand that the outcome is unknown and the retained evidence will be deleted."))
  dialog.append(confirmation)
  const actions = element("div", "oc-runtime-services__actions")
  actions.append(
    button("Acknowledge and delete evidence", "danger", () => void cleanupTrackedOperation(api, state, acknowledgement.operation, true), !acknowledgement.confirmed || acknowledgement.operation.cleanupBusy),
    button("Keep evidence", "secondary", () => {
      state.acknowledgeOperation = undefined
      renderAll(state)
    }, acknowledgement.operation.cleanupBusy),
  )
  dialog.append(actions)
  overlay.append(dialog)
  return overlay
}

async function cleanupTrackedOperation(api, state, operation, acknowledgeIndeterminate) {
  if (operation.status === "pending" || operation.cleanupBusy) return
  operation.cleanupBusy = true
  state.error = ""
  renderAll(state)
  try {
    await request(api, "cleanup", {
      operationID: operation.id,
      acknowledgeIndeterminate,
    })
    state.operations.delete(operation.id)
    if (state.acknowledgeOperation?.operation.id === operation.id) state.acknowledgeOperation = undefined
  } catch (error) {
    state.error = message(error)
    operation.cleanupBusy = false
  }
  renderAll(state)
}

async function toggleEditor(api, state, service) {
  if (state.editor?.service.name === service.name) {
    state.editor = undefined
    renderAll(state)
    return
  }
  state.actionBusy.add(service.name)
  state.error = ""
  renderAll(state)
  try {
    const detail = await loadDetail(api, state, service)
    state.editor = {
      service,
      detail,
      draft: {
        application: detail.application || "",
        appDirectory: detail.appDirectory || "",
        appParameters: detail.appParameters || "",
        startMode: detail.configuredStartMode || "manual",
        description: detail.description || "",
        stdout: detail.stdout || "",
        stderr: detail.stderr || "",
      },
      environment: Object.fromEntries((detail.environmentKeys || []).map((key) => [key, { value: "", remove: false }])),
      newEnvironmentKey: "",
      newEnvironmentValue: "",
      saving: false,
    }
  } catch (error) {
    state.error = message(error)
  } finally {
    state.actionBusy.delete(service.name)
    renderAll(state)
  }
}

function renderEditor(api, state) {
  const editor = state.editor
  const form = element("form", "oc-runtime-services__editor")
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    void saveEditor(api, state)
  })
  form.append(text("h3", `Edit ${editor.service.displayName || editor.service.name}`))
  for (const [key, label] of [
    ["application", "Application"],
    ["appDirectory", "Working directory"],
    ["appParameters", "Arguments"],
    ["description", "Description"],
    ["stdout", "Stdout log"],
    ["stderr", "Stderr log"],
  ]) form.append(field(label, editor.draft[key], (value) => (editor.draft[key] = value), key === "appParameters" ? "textarea" : "input"))
  const start = element("label", "oc-runtime-services__field")
  start.append(text("span", "Start mode"))
  const select = document.createElement("select")
  for (const [value, label] of [["automatic", "Automatic"], ["delayed", "Automatic (delayed)"], ["manual", "Manual"], ["disabled", "Disabled"]]) {
    const option = document.createElement("option")
    option.value = value
    option.textContent = label
    option.selected = editor.draft.startMode === value
    select.append(option)
  }
  select.addEventListener("change", () => (editor.draft.startMode = select.value))
  start.append(select)
  form.append(start, renderEnvironment(state))
  const controls = element("div", "oc-runtime-services__editor-controls")
  controls.append(
    button(editor.saving ? "Saving…" : "Save changes", "primary", undefined, editor.saving, "submit"),
    button("Cancel", "secondary", () => {
      state.editor = undefined
      renderAll(state)
    }, editor.saving),
  )
  form.append(controls)
  return form
}

function renderEnvironment(state) {
  const editor = state.editor
  const section = element("section", "oc-runtime-services__environment")
  section.append(text("h4", "Environment"), text("p", "Existing values remain hidden. Queue any number of additions or replacements, then save all changes together."))
  for (const [key, change] of Object.entries(editor.environment)) {
    const row = element("div", "oc-runtime-services__environment-row")
    row.append(text("code", key))
    const input = document.createElement("input")
    input.type = "password"
    input.placeholder = "•••••• (unchanged)"
    input.autocomplete = "new-password"
    input.value = change.value
    input.disabled = change.remove
    input.addEventListener("input", () => (change.value = input.value))
    const remove = document.createElement("label")
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = change.remove
    checkbox.addEventListener("change", () => {
      change.remove = checkbox.checked
      input.disabled = change.remove
    })
    remove.append(checkbox, document.createTextNode(" Remove"))
    row.append(input, remove)
    section.append(row)
  }
  const add = element("div", "oc-runtime-services__environment-row")
  const key = document.createElement("input")
  key.placeholder = "NEW_KEY"
  key.value = editor.newEnvironmentKey
  key.addEventListener("input", () => (editor.newEnvironmentKey = key.value))
  const value = document.createElement("input")
  value.type = "password"
  value.placeholder = "New value"
  value.autocomplete = "new-password"
  value.value = editor.newEnvironmentValue
  value.addEventListener("input", () => (editor.newEnvironmentValue = value.value))
  add.append(key, value, button("Add or replace", "secondary", () => {
    const name = editor.newEnvironmentKey.trim()
    if (!name || !editor.newEnvironmentValue) {
      state.error = "Enter both an environment key and value before adding the change."
      renderAll(state)
      return
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      state.error = `Invalid environment key: ${name}`
      renderAll(state)
      return
    }
    editor.environment[name] = { value: editor.newEnvironmentValue, remove: false }
    editor.newEnvironmentKey = ""
    editor.newEnvironmentValue = ""
    state.error = ""
    renderAll(state)
  }))
  section.append(add)
  return section
}

async function saveEditor(api, state) {
  const editor = state.editor
  if (!editor || editor.saving) return
  editor.saving = true
  state.error = ""
  renderAll(state)
  try {
    const changes = Object.fromEntries(
      Object.entries(editor.draft).filter(([key, value]) =>
        value !== (key === "startMode" ? editor.detail.configuredStartMode : editor.detail[key]),
      ),
    )
    const set = Object.fromEntries(Object.entries(editor.environment).flatMap(([key, change]) => change.value && !change.remove ? [[key, change.value]] : []))
    if (editor.newEnvironmentKey && editor.newEnvironmentValue) set[editor.newEnvironmentKey] = editor.newEnvironmentValue
    const remove = Object.entries(editor.environment).flatMap(([key, change]) => change.remove ? [key] : [])
    const detail = await request(api, "patch", {
      name: editor.service.name,
      payload: { changes, environment: { set, remove } },
    })
    state.details.set(editor.service.name, detail)
    state.editor = undefined
    state.notice = `${editor.service.displayName || editor.service.name} was updated.`
    await refresh(api, state)
  } catch (error) {
    const operation = operationFromError(error, {
      kind: "patch",
      serviceName: editor.service.name,
      serviceLabel: editor.service.displayName || editor.service.name,
    })
    if (operation) {
      editor.saving = false
      trackOperation(api, state, operation)
      return
    }
    state.error = message(error)
    editor.saving = false
    renderAll(state)
  }
}

async function runAction(api, state, service, action) {
  if (state.actionBusy.has(service.name)) return
  state.actionBusy.add(service.name)
  state.error = ""
  state.notice = ""
  renderAll(state)
  try {
    const body = await request(api, "action", {
      name: service.name,
      payload: { action },
    })
    state.services = Array.isArray(body?.services) ? body.services : []
    state.details.delete(service.name)
    state.notice = `${service.displayName || service.name}: ${action} completed.`
  } catch (error) {
    const operation = operationFromError(error, {
      kind: "action",
      action,
      serviceName: service.name,
      serviceLabel: service.displayName || service.name,
    })
    if (operation) {
      trackOperation(api, state, operation)
      return
    }
    state.error = message(error)
  } finally {
    state.actionBusy.delete(service.name)
    renderAll(state)
  }
}

function renderDeleteConfirmation(api, state) {
  const service = state.confirmDelete
  const overlay = element("div", "oc-runtime-services__overlay")
  const dialog = element("section", "oc-runtime-services__dialog")
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-modal", "true")
  dialog.append(text("h3", `Delete ${service.displayName || service.name}?`), text("p", "Do you really want to delete this service? This cannot be undone."))
  const actions = element("div", "oc-runtime-services__actions")
  actions.append(
    button("Delete service", "danger", async () => {
      state.confirmDelete = undefined
      if (state.actionBusy.has(service.name)) return
      state.actionBusy.add(service.name)
      renderAll(state)
      try {
        const body = await request(api, "action", {
          name: service.name,
          payload: { action: "delete", confirmation: service.name },
        })
        state.services = Array.isArray(body?.services) ? body.services : []
        state.details.delete(service.name)
        state.notice = `${service.displayName || service.name} was deleted.`
      } catch (error) {
        const operation = operationFromError(error, {
          kind: "action",
          action: "delete",
          serviceName: service.name,
          serviceLabel: service.displayName || service.name,
        })
        if (operation) {
          trackOperation(api, state, operation)
          return
        }
        state.error = message(error)
      } finally {
        state.actionBusy.delete(service.name)
        renderAll(state)
      }
    }),
    button("Cancel", "secondary", () => {
      state.confirmDelete = undefined
      renderAll(state)
    }),
  )
  dialog.append(actions)
  overlay.append(dialog)
  return overlay
}

async function prepareSession(api, state, service) {
  if (state.sessionBusy.has(service.name)) return
  state.sessionBusy.add(service.name)
  state.error = ""
  renderAll(state)
  try {
    const detail = await loadDetail(api, state, service)
    if (detail.sessionDirectory) {
      await openServiceSession(api, state, service, detail.sessionDirectory, projectName(api, detail.sessionDirectory))
      return
    }
    const projects = api.host.projects.list()
    const current = api.host.navigation.current().directory
    state.projectPicker = {
      service,
      projects,
      selected: projects.find((project) => project.worktree === current)?.worktree || projects[0]?.worktree || current || "",
    }
  } catch (error) {
    state.error = message(error)
    state.sessionBusy.delete(service.name)
  } finally {
    renderAll(state)
  }
}

function renderProjectPicker(api, state) {
  const picker = state.projectPicker
  const overlay = element("div", "oc-runtime-services__overlay")
  const dialog = element("section", "oc-runtime-services__dialog")
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-modal", "true")
  dialog.append(text("h3", "Choose project for service session"), text("p", "No valid NSSM project directory was found. The current project is preselected and can be changed."))
  const select = document.createElement("select")
  select.setAttribute("aria-label", "Service session project")
  for (const project of picker.projects) {
    const option = document.createElement("option")
    option.value = project.worktree
    option.textContent = project.name || project.worktree
    option.selected = project.worktree === picker.selected
    select.append(option)
  }
  select.addEventListener("change", () => (picker.selected = select.value))
  dialog.append(select)
  const actions = element("div", "oc-runtime-services__actions")
  actions.append(
    button("Create session", "primary", async () => {
      const selected = picker.projects.find((project) => project.worktree === picker.selected)
      state.projectPicker = undefined
      try {
        await openServiceSession(api, state, picker.service, picker.selected, selected?.name || folderName(picker.selected))
      } catch (error) {
        state.error = message(error)
        state.sessionBusy.delete(picker.service.name)
      }
      renderAll(state)
    }, !picker.selected),
    button("Cancel", "secondary", () => {
      state.projectPicker = undefined
      state.sessionBusy.delete(picker.service.name)
      renderAll(state)
    }),
  )
  dialog.append(actions)
  overlay.append(dialog)
  return overlay
}

async function openServiceSession(api, state, service, directory, project) {
  let sessionID
  try {
    const created = await api.client.v2.session.create({ location: { directory } })
    sessionID = created?.data?.data?.id || created?.data?.id || created?.id
    if (!sessionID) throw new Error("The new service session did not return an ID.")
    const name = service.displayName || service.name
    const prompt = `Ich will den NSSM-Runtime-Service „${name}“ im Projekt „${project}“ überarbeiten. Ich schicke dir jetzt erstmal Informationen dazu, was ich machen will. Antworte zunächst ausschließlich mit: „Sag mir, was du beim Service ‚${name}‘ im Projekt ‚${project}‘ vorhast.“ Verwende bis zu meiner nächsten Nachricht keine Tools und nimm keine Änderungen vor.`
    await api.client.v2.session.prompt({ sessionID, prompt: { text: prompt } })
    api.host.navigation.openSession({ directory, sessionID })
    state.notice = `Opened a new service session for ${name}.`
  } catch (error) {
    if (sessionID) {
      api.host.navigation.openSession({ directory, sessionID })
      throw new Error(`Session ${sessionID} was created, but the first message could not be sent. Opened it so you can retry manually. ${message(error)}`)
    }
    throw error
  } finally {
    state.sessionBusy.delete(service.name)
  }
}

function projectName(api, directory) {
  return api.host.projects.list().find((project) => project.worktree === directory)?.name || folderName(directory)
}

function folderName(path) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path
}

function field(label, value, onInput, kind) {
  const root = element("label", "oc-runtime-services__field")
  root.append(text("span", label))
  const input = kind === "textarea" ? document.createElement("textarea") : document.createElement("input")
  input.value = value
  input.addEventListener("input", () => onInput(input.value))
  root.append(input)
  return root
}

function button(label, variant, onClick, disabled = false, type = "button") {
  const result = document.createElement("button")
  result.type = type
  result.textContent = label
  result.className = `oc-runtime-services__button oc-runtime-services__button--${variant}`
  result.disabled = disabled
  if (onClick) result.addEventListener("click", onClick)
  return result
}

function text(tag, value, className) {
  const result = document.createElement(tag)
  result.textContent = value
  if (className) result.className = className
  return result
}

function element(tag, className) {
  const result = document.createElement(tag)
  if (className) result.className = className
  return result
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function styleNode() {
  const style = document.createElement("style")
  style.textContent = `.oc-runtime-services{color:var(--foreground);font:13px/1.4 system-ui;padding:12px;overflow:auto;min-height:100%;box-sizing:border-box;position:relative}.oc-runtime-services__header{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}.oc-runtime-services__header>div{display:grid;gap:3px}.oc-runtime-services__header span,.oc-runtime-services__service span{color:var(--text-muted)}.oc-runtime-services__operations{display:grid;gap:8px;margin:12px 0;padding:10px;border:1px solid var(--border);border-radius:8px}.oc-runtime-services__operations>h3,.oc-runtime-services__operations>p,.oc-runtime-services__operation p{margin:0}.oc-runtime-services__operations>p{color:var(--text-muted)}.oc-runtime-services__operation{display:grid;gap:7px;padding:9px;border:1px dashed var(--border);border-radius:7px}.oc-runtime-services__operation-heading{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.oc-runtime-services__operation-heading span{color:var(--text-muted)}.oc-runtime-services__operation[data-status=succeeded] .oc-runtime-services__operation-status{color:var(--success)}.oc-runtime-services__operation[data-status=indeterminate] .oc-runtime-services__operation-status,.oc-runtime-services__operation[data-status=failed] .oc-runtime-services__operation-status,.oc-runtime-services__operation[data-status=timed_out] .oc-runtime-services__operation-status{color:var(--danger)}.oc-runtime-services__operation code{overflow-wrap:anywhere}.oc-runtime-services__operation-message{color:var(--text-muted)}.oc-runtime-services__list{display:grid;gap:10px;margin-top:12px}.oc-runtime-services__service{border:1px solid var(--border);border-radius:8px;padding:10px;display:grid;gap:8px}.oc-runtime-services__service-heading{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}.oc-runtime-services__service-heading>div{display:grid;gap:2px}.oc-runtime-services__status[data-state=running]{color:var(--success)}.oc-runtime-services__description{margin:0;color:var(--text-muted)}.oc-runtime-services__actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.oc-runtime-services__button{background:var(--background-element);border:1px solid var(--border);border-radius:6px;color:inherit;padding:6px 9px;min-height:30px}.oc-runtime-services__button:disabled{opacity:.55}.oc-runtime-services__button--primary{background:var(--primary);color:var(--primary-foreground)}.oc-runtime-services__button--danger{border-color:var(--danger);color:var(--danger)}.oc-runtime-services__editor{border-top:1px solid var(--border);padding-top:10px;display:grid;gap:10px}.oc-runtime-services__editor h3,.oc-runtime-services__editor h4{margin:0}.oc-runtime-services__field{display:grid;gap:4px}.oc-runtime-services input,.oc-runtime-services textarea,.oc-runtime-services select{box-sizing:border-box;width:100%;background:var(--background);border:1px solid var(--border);border-radius:6px;color:inherit;padding:7px}.oc-runtime-services textarea{min-height:64px;resize:vertical}.oc-runtime-services__environment{display:grid;gap:7px}.oc-runtime-services__environment>p{margin:0;color:var(--text-muted)}.oc-runtime-services__environment-row{display:grid;grid-template-columns:minmax(90px,.7fr) minmax(130px,1fr) auto;gap:6px;align-items:center}.oc-runtime-services__editor-controls{display:flex;gap:6px}.oc-runtime-services__warning{color:var(--danger);margin:12px 0}.oc-runtime-services__notice{color:var(--success);margin:12px 0}.oc-runtime-services__empty{color:var(--text-muted);margin:18px 0}.oc-runtime-services__overlay{position:absolute;inset:0;background:color-mix(in srgb,var(--background-base,#121212) 78%,transparent);display:grid;place-items:center;padding:18px;z-index:10}.oc-runtime-services__dialog{width:min(440px,100%);background:var(--surface-raised-stronger-non-alpha,var(--background-base,#121212));border:1px solid var(--border);border-radius:10px;padding:16px;display:grid;gap:12px;box-shadow:0 12px 32px rgba(0,0,0,.35)}.oc-runtime-services__dialog h3,.oc-runtime-services__dialog p{margin:0}.oc-runtime-services__acknowledgement{display:flex;gap:8px;align-items:flex-start}.oc-runtime-services__acknowledgement input{width:auto;margin-top:2px}@media(max-width:520px){.oc-runtime-services{padding:9px}.oc-runtime-services__environment-row{grid-template-columns:1fr}.oc-runtime-services__button{flex:1 1 auto}.oc-runtime-services__header{align-items:stretch}.oc-runtime-services__header>.oc-runtime-services__button{flex:0 0 auto}}`
  return style
}
