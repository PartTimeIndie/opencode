import { describe, expect, test } from "bun:test"
import { controlPanelFormRequest } from "./session-control-panel-form"
import type { ControlPanelPaneInfo } from "./session-control-panel-pane"

function panel(data: unknown): ControlPanelPaneInfo {
  return {
    id: "control-panel:test",
    paneID: "control-panel:test",
    directory: "C:/repo",
    sessionID: "ses_surface_form",
    messageID: "msg_surface_form",
    partID: "prt_surface_form",
    controlID: "surface-form",
    requestID: "que_surface_form",
    requestRevision: 3,
    data,
    sourcePart: {
      id: "prt_surface_form",
      sessionID: "ses_surface_form",
      messageID: "msg_surface_form",
      type: "custom",
      kind: "opencode/control-panel",
      data,
    },
  }
}

describe("controlPanelFormRequest", () => {
  test("adapts a non-blocking Surface form to the shared form renderer", () => {
    const request = controlPanelFormRequest(
      panel({
        version: 1,
        controlID: "surface-form",
        controls: [
          {
            id: "editor",
            type: "form",
            label: "Edit values",
            form: { version: 1, id: "editor.v1", fields: [{ id: "name", type: "text", label: "Name" }] },
          },
        ],
      }),
    )

    expect(request).toEqual({
      id: "que_surface_form",
      sessionID: "ses_surface_form",
      revision: 3,
      actions: [],
      mode: "blocking",
      questions: [
        {
          type: "form",
          question: "Edit values",
          header: "Edit values",
          form: { version: 1, id: "editor.v1", fields: [{ id: "name", type: "text", label: "Name" }] },
        },
      ],
      detached: true,
    })
  })

  test("keeps ordinary Control Surfaces on the Control renderer", () => {
    expect(
      controlPanelFormRequest(
        panel({
          version: 1,
          controlID: "controls",
          controls: [{ id: "speed", type: "slider", label: "Speed" }],
        }),
      ),
    ).toBeUndefined()
  })

  test("restores persistent tool values into a reusable form", () => {
    const current = panel({
      version: 1,
      controlID: "persistent-form",
      values: { name: "Saved" },
      controls: [
        {
          id: "editor",
          type: "form",
          label: "Persistent editor",
          form: { version: 1, id: "persistent.v1", fields: [{ id: "name", type: "text", label: "Name" }] },
        },
      ],
    })
    delete current.requestID
    delete current.requestRevision
    current.toolID = "sft_saved"
    current.toolRevision = 5

    const request = controlPanelFormRequest(current)
    expect(request?.revision).toBe(5)
    expect(request?.questions[0]?.form?.fields[0]?.defaultValue).toBe("Saved")
  })
})
