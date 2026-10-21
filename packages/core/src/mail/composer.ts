import type { Control } from "../control"
import type { Outgoing } from "./message"

// One composer contract for both providers. GMX selects a configured account
// by ID; Gmail continues to use its existing OAuth credentials.
export function composer(input: { provider: "gmail" | "gmx"; account?: string; sender?: string; message?: Partial<Outgoing> }): Control.PartData {
  if (input.provider === "gmx" && !input.account) throw new Error("GMX account ID required")
  const step = (mode: "send" | "draft"): Control.SurfaceActionStep =>
    input.provider === "gmail" ? { type: "gmail", mode } : { type: "gmx", account: input.account!, mode }
  const field = (id: string, label: string, required = false) => ({
    id, type: "recipient_list" as const, label, required, multiple: true,
    defaultValue: input.message?.[id as "to" | "cc" | "bcc"] ?? [],
    ...(input.provider === "gmail" ? { autocomplete: { provider: "gmail-recipients" as const, minLength: 2 } } : {}),
  })
  return {
    version: 1,
    controlID: "email-composer.v1",
    title: input.provider === "gmail" ? "Gmail-Mail" : "GMX-Mail",
    controls: [{
      id: "email-form", type: "form", label: "Mail prüfen und Aktion wählen",
      form: {
        version: 1, id: "email-composer.v1", title: "E-Mail schreiben",
        description: "Erwartet: Alle Angaben prüfen und unten die gewünschte Aktion ausdrücklich bestätigen. Senden verschickt die bearbeitete Nachricht sofort.",
        submitLabel: "Ausgewählte Aktion bestätigen",
        fields: [
          ...(input.sender ? [{ id: "sender", type: "display" as const, label: "Von", description: input.sender }] : []),
          field("to", "An", true), field("cc", "Cc"), field("bcc", "Bcc"),
          { id: "subject", type: "text", label: "Betreff", required: true, defaultValue: input.message?.subject ?? "" },
          { id: "body", type: input.provider === "gmail" ? "rich_text" : "textarea", label: "Nachricht", required: true, rows: 10, defaultValue: input.message?.text ?? "" },
          { id: "attachments", type: "file_picker", label: "Anhänge", multiple: true, defaultValue: input.message?.attachments ?? [] },
          { id: "action", type: "select", label: "Aktion", required: true, defaultValue: "send", options: [
            { id: "send", label: "Senden", description: "Nach Klick auf Bestätigen sofort versenden." },
            { id: "draft", label: "Entwurf speichern", description: "Nicht senden, nur im Postfach speichern." },
            { id: "cancel", label: "Abbrechen", description: "Nichts senden oder speichern." },
          ] },
        ],
        layout: { type: "vstack", children: [
          ...(input.sender ? [{ type: "field" as const, field: "sender" }] : []),
          { type: "hstack", children: ["to", "cc", "bcc"].map((id) => ({ type: "field", field: id, width: "fill" })) },
          ...["subject", "body", "attachments", "action"].map((id) => ({ type: "field" as const, field: id })),
        ] },
        actions: [
          { id: "send", trigger: { event: "submit", when: { field: "action", equals: "send" } }, steps: [step("send")] },
          { id: "draft", trigger: { event: "submit", when: { field: "action", equals: "draft" } }, steps: [step("draft")] },
          { id: "cancel", trigger: { event: "submit", when: { field: "action", equals: "cancel" } }, steps: [{ type: "dismiss" }] },
        ],
      },
    }],
  }
}
