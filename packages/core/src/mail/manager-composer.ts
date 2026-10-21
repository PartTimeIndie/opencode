import type { Control } from "../control"
import type { MailView } from "./manager"

export function managerComposer(view: MailView): Control.PartData {
  const operations = [
    { id: "move", label: "Verschieben" }, { id: "trash", label: "In den Papierkorb" },
    { id: "archive", label: "Archivieren" }, { id: "mark_read", label: "Als gelesen markieren" },
    { id: "mark_unread", label: "Als ungelesen markieren" }, { id: "star", label: "Markieren" },
    { id: "unstar", label: "Markierung entfernen" },
    ...(view.provider === "gmail" ? [{ id: "add_label", label: "Label hinzufügen" }, { id: "remove_label", label: "Label entfernen" }] : []),
  ]
  return {
    version: 1,
    controlID: `email-manager-${view.id}`,
    title: `E-Mails · ${view.address}`,
    controls: [{
      id: "email-manager", type: "form", label: `${view.mailbox} · ${view.rows.length} Treffer`,
      form: {
        version: 1, id: "email-manager.v1", title: `E-Mails · ${view.address}`,
        description: "Erwartet: Mail(s) wählen, Aktion und gegebenenfalls Ziel prüfen, dann ausdrücklich ausführen. Öffnen oder Schließen verändert keine Mail.",
        fields: [
          ...view.rows.map((row, index) => ({
            id: `mail-${index}`, type: "checkbox" as const,
            label: `${row.unread ? "● " : ""}${row.from} · ${row.subject}`,
            description: [row.date, row.snippet, row.starred ? "★" : ""].filter(Boolean).join(" · ").slice(0, 600),
            defaultValue: false,
          })),
          { id: "action", type: "select", label: "Aktion", defaultValue: "mark_read", options: operations },
          { id: "destination", type: "select", label: "Ziel (bei Verschieben/Labels)", defaultValue: "", options: [
            { id: "", label: "Ziel wählen" }, ...view.destinations.map((item) => ({ id: item.id, label: item.label })),
          ] },
          { id: "apply", type: "button", label: "Aktion ausführen" },
          { id: "close", type: "button", label: "Schließen" },
          { id: "wish", type: "button", label: "Wunsch äußern" },
          { id: "wish_open", type: "hidden", defaultValue: "false" },
          { id: "wish_text", type: "textarea", label: "Dein Wunsch", rows: 3, placeholder: "Was soll ich mit diesen Mails tun?" },
          { id: "wish_send", type: "button", label: "Wunsch senden" },
        ],
        layout: { type: "vstack", children: [
          ...view.rows.map((_, index) => ({ type: "field" as const, field: `mail-${index}` })),
          { type: "hstack", children: [
            { type: "field", field: "action", width: "fill" }, { type: "field", field: "destination", width: "fill" },
          ] },
          { type: "hstack", children: ["apply", "close", "wish"].map((field) => ({ type: "field" as const, field })) },
          { type: "field", field: "wish_text", when: { field: "wish_open", equals: "true" } },
          { type: "field", field: "wish_send", when: { field: "wish_open", equals: "true" } },
        ] },
        actions: [
          { id: "apply", trigger: { event: "click", source: "apply" }, steps: [{ type: "mail_manager", viewID: view.id, mode: "apply" }] },
          { id: "close", trigger: { event: "click", source: "close" }, steps: [{ type: "dismiss" }] },
          { id: "wish", trigger: { event: "click", source: "wish" }, steps: [{ type: "setValue", target: "values.wish_open", value: "true" }] },
          { id: "wish_send", trigger: { event: "click", source: "wish_send" }, steps: [{ type: "mail_manager", viewID: view.id, mode: "wish" }] },
        ],
      },
    }],
  }
}
