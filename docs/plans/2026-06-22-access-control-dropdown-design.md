## Problem

OpenCode soll im Chat-Composer einen Codex-ähnlichen Access-Control-Schalter bekommen, damit der aktive Permission-Modus ohne Umweg über Config-Dateien gewechselt werden kann.

Gewünschte Modi:

- **Ask for Approval**: Aktionen fragen wie bisher nach, sobald die aktive Permission-Policy `ask` ergibt.
- **Approve for Me**: OpenCode beantwortet erlaubte Approval-Requests automatisch nach einer klaren Policy.
- **Full Access**: möglichst uneingeschränkter Session-Modus für bewusst vertrauenswürdige Arbeit.
- **Custom**: bestehende `opencode.json`/`opencode.jsonc`-Permissions bleiben sichtbar und werden nicht überschrieben.

Wichtig: OpenCode-Permissions sind UX-/Awareness-Controls, keine Sandbox. Das Feature darf deshalb keine harte Sicherheitsisolation versprechen und muss bestehende Deny-/Managed-Policies respektieren.

## Findings

### Octto-Entscheidungen

- **Composer-UI**: kompaktes Dropdown-Badge im Composer, ähnlich dem Codex-Screenshot.
- **Approve for Me**: policy-basiert, nicht blindes Session-Vertrauen.
- **Persistenz**: aktive Session plus Defaults. Im Dropdown sollen Checkboxen/Actions möglich sein, um beim Auswählen zusätzlich **Update Project default** und/oder **Update User default** zu setzen.
- **Priorität laut Nutzerwunsch**: `Session setting > User default > Project default > Built-in fallback` für den Access-Control-Modus. Diese Priorität gilt nur für das neue Access-Control-Profil; die allgemeine Config-Merge-Logik muss nicht global umgedreht werden.
- **QA-Pflicht**: Legacy-Permissions, Session-Resume/Multi-Window, Security-Regression, Composer-E2E/Visual-QA, API-/SDK-Verträge und Migration-/Release-Notes.

### Relevante Codebereiche

- Composer-Integration:
  - `packages/app/src/components/prompt-input.tsx`
  - `packages/app/src/pages/session/composer/session-composer-region.tsx`
  - `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Bestehendes Frontend-Auto-Approval:
  - `packages/app/src/context/permission.tsx`
  - `packages/app/src/context/permission-auto-respond.ts`
- V1-Permission-Flow:
  - `packages/opencode/src/permission/index.ts`
  - `packages/core/src/v1/config/permission.ts`
  - `packages/opencode/src/session/tools.ts`
- V2-Permission-Flow:
  - `packages/core/src/permission.ts`
  - `packages/core/src/permission/schema.ts`
  - `packages/core/src/permission/saved.ts`
  - `packages/server/src/groups/permission.ts`
- Config-Laden und Migration:
  - `packages/opencode/src/config/config.ts`
  - `packages/core/src/config.ts`
  - `packages/core/src/v1/config/migrate.ts`
- SDK/API:
  - `packages/sdk/js/src/v2/gen/*`
  - `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`

### Aktueller Risiko-Befund

- Es gibt parallel V1- und V2-Permission-Modelle. Das Feature muss beide Pfade abdecken oder über eine gemeinsame Übersetzungsschicht laufen.
- Das heutige App-`autoAccept` ist clientseitig persistiert und antwortet Approval-Requests automatisch; es ist noch keine serverseitige Policy-Quelle.
- V1-`always`-Approvals sind pro Prozess/in-memory, V2 kann Saved Permissions persistieren. Ein neues Access-Control-Profil darf diese Unterschiede nicht versehentlich als gleichwertig behandeln.
- Config-Denies und Managed/Enterprise-Policies müssen Vorrang vor UI-Komfort haben. Wenn Full Access dadurch begrenzt wird, soll die UI das als `Full Access (limited by policy)` oder durch eine Menü-Warnung anzeigen.

## Recommendation

Implementiere ein zentrales Access-Control-Profil und hänge das Composer-Dropdown daran, statt nur das bestehende lokale `autoAccept` umzubenennen.

### 1. UX-Design

Im Composer links neben oder direkt nach Model/Variant ein neues `ComposerAccessControl`-Badge einfügen.

Vorgeschlagene Badge-Zustände:

- `Ask` / shield icon / neutral
- `Approve` / shield-check icon / leicht hervorgehoben
- `Full access` / warning-oranges Badge
- `Custom` / gear icon

Dropdown-Inhalt:

1. Header: `How should OpenCode actions be approved?`
2. Radio-Optionen:
   - `Ask for approval` — fragt bei jeder Policy-Entscheidung `ask`.
   - `Approve for me` — genehmigt automatisch nur Aktionen, die zur aktiven Auto-Approve-Policy passen.
   - `Full access` — erlaubt alles, was nicht hart durch Managed Policy, Auth oder harte Tool-Grenzen blockiert ist.
   - `Custom (opencode.json)` — nutzt bestehende Config-Regeln; erscheint automatisch, wenn die effektive Regelmenge keinem Preset entspricht.
3. Separator.
4. Checkboxen oder Split-Actions:
   - `Update Project default` schreibt nach `.opencode/opencode.jsonc` oder legt die Datei an.
   - `Update User default` schreibt nach globaler User-Config, z. B. `~/.config/opencode/opencode.jsonc`.
5. Optionaler Footer: `Permissions are not a sandbox` + Link/Action zu Security-Doku oder Config öffnen.

Jede Auswahl wirkt sofort auf die aktive Session. Wenn passende Pending Requests existieren, werden sie nach dem neuen Modus neu bewertet und nur bei erlaubter Auto-Approval-Policy automatisch beantwortet.

### 2. Semantik der Modi

Neue konzeptionelle Form:

```ts
type AccessControlMode = "ask" | "approve_for_me" | "full_access" | "custom"

type AccessControlProfile = {
  mode: AccessControlMode
  policy?: "builtin_safe" | "custom"
}
```

Empfohlene Presets:

- `ask`: kein Auto-Respond; bestehende `ask`-Entscheidungen erzeugen Permission-Docks.
- `approve_for_me`: policy-basiert. MVP konservativ:
  - erlaubbar: Read/List/Glob/Grep/ungefährliche Context- oder Todo-Aktionen.
  - weiter fragen: Edit/Write/ApplyPatch, Shell/Bash, External Directory, Web/Network, Task/Subagent, Skill/MCP oder destruktive Operationen.
  - die genaue Liste muss als Code-Policy testbar sein, nicht nur UI-Text.
- `full_access`: generiert effektive Allow-Regeln für die Session, aber nicht für harte Denies/Managed Policies/Auth-Grenzen.
- `custom`: keine Preset-Übersetzung; UI zeigt an, dass aktive `permission`/`permissions`-Config übernommen wurde.

V2-Denies sollten explizit vor saved/session approvals geprüft bleiben. Für V1 muss verhindert werden, dass UI-erzeugte Allow-Regeln konfigurierte Denies versehentlich überstimmen, wenn diese als harte Denies gelten sollen.

### 3. Persistenz und Priorität

Access-Control-Default-Auflösung:

1. explizite Session-Einstellung
2. User default
3. Project default
4. Built-in fallback: `ask` oder `custom`, wenn vorhandene Permission-Config nicht zu einem Preset passt

Schreibverhalten im Dropdown:

- Beim Klick auf einen Modus wird immer die aktive Session aktualisiert.
- Wenn `Update Project default` aktiv ist, wird derselbe Modus zusätzlich in der Projekt-Config gespeichert.
- Wenn `Update User default` aktiv ist, wird derselbe Modus zusätzlich in der User-Config gespeichert.
- Wenn beide Checkboxen aktiv sind, werden beide Dateien geschrieben; bei späterer Default-Auflösung gewinnt User default wie oben beschrieben.

Config-Feldvorschlag:

```jsonc
{
  "access_control": {
    "mode": "approve_for_me",
    "policy": "builtin_safe"
  }
}
```

Bestehende `permission`/`permissions`-Felder bleiben gültig. Wenn sie nicht exakt einem Preset entsprechen, zeigt die UI `Custom`.

### 4. Backend/API-Plan

Nicht nur im Frontend lösen. Benötigt wird ein kleiner serverseitiger Contract:

- `GET` effektives Access-Control-Profil für Session + Directory.
- `PUT` Session-Profil ändern.
- Optional `PUT` Project/User default ändern.
- Event/SSE bei Änderung, damit Multi-Window und Session-Resume den Badge korrekt aktualisieren.
- SDK nach API-Änderungen regenerieren.

Der Permission-Evaluator soll das effektive Profil vor einer Approval-Frage kennen:

- V1: beim `ctx.ask(...)`/Permission-Service die Session-Access-Control-Policy in die Entscheidungslogik einbeziehen.
- V2: `PermissionV2.assert(...)` über denselben Profilresolver laufen lassen.
- App-`autoAccept` nur als Übergangsschicht verwenden oder auf den neuen Session-State migrieren.

### 5. Migration und Kompatibilität

- Alte `permission`/`permissions`-Config nicht verändern.
- Alte appseitige `permission.v3`-AutoAccept-Werte nicht blind in Full Access migrieren. Besser: als Fallback lesen, bis der Nutzer einen neuen Modus setzt, und dann neue Session-State-Quelle verwenden.
- Release Notes erklären:
  - welche Presets es gibt,
  - dass User default in diesem Feature Project default überschreibt,
  - dass `Custom` bestehende Config bedeutet,
  - dass Full Access keine Sandbox deaktiviert, sondern Approval-UX öffnet.

### 6. Implementierungsreihenfolge

1. Core-Semantik definieren: Access-Control-Typen, Preset-Policy und Resolver mit Tests.
2. Session/API-State ergänzen: effektives Profil lesen, Session ändern, Defaults schreiben, Events senden.
3. V1/V2 Permission-Evaluator an den Resolver anbinden.
4. App-Kontext bauen: `useAccessControl()` analog zu `usePermission()`, inklusive SSE-Reaktion.
5. `ComposerAccessControl` in `prompt-input.tsx` einbauen, sowohl im neuen Composer-Layout als auch im Legacy-Branch, falls dieser noch aktiv ist.
6. Pending-Request-Reevaluation nach Moduswechsel implementieren.
7. SDK/OpenAPI regenerieren.
8. Migration-/Release-Notes ergänzen.

### 7. Test- und QA-Matrix

Pflichttests:

- Core/Permission:
  - `approve_for_me` erlaubt nur explizit policy-erlaubte Requests.
  - Shell/Edit/External Directory bleiben im konservativen MVP approval-pflichtig.
  - Full Access bypassed keine Managed/Hard-Denies.
  - V1- und V2-Rule-Übersetzung verhalten sich gleich.
- App:
  - Badge zeigt richtigen effektiven Modus.
  - Dropdown-Selection aktualisiert Session sofort.
  - Project/User-Default-Checkboxen schreiben den richtigen Scope.
  - User default gewinnt über Project default; Session gewinnt über beide.
  - Multi-Window/SSE aktualisiert den Badge.
- E2E/Visual:
  - Composer in Desktop-Breite und schmaler Breite.
  - Dropdown keyboard-navigierbar.
  - Pending Permission Dock reagiert auf Moduswechsel.
- API/SDK:
  - OpenAPI/SDK nach neuen Routes regeneriert.
  - Backward compatibility für alte permission endpoints bleibt bestehen.

Empfohlene Befehle nach Implementierung:

```powershell
# packages/app
bun typecheck
bun test --preload ./happydom.ts ./src/components/prompt-input ./src/pages/session/composer/session-composer-state.test.ts
bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts

# packages/core
bun typecheck
bun test test/permission.test.ts test/tool-read.test.ts test/tool-bash.test.ts test/tool-write.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts

# packages/opencode
bun typecheck
bun test --timeout 30000 test/permission/next.test.ts test/tool/external-directory.test.ts test/tool/shell.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts

# API/SDK, falls Routes/Schemas geändert wurden
bun ./packages/sdk/js/script/build.ts
```

Wenn die installierte Desktop-App testbereit sein soll, danach den bekannten Prod-Deploy-Flow ausführen:

```powershell
# packages/desktop
$env:OPENCODE_CHANNEL="prod"; bun run build

# packages/opencode
$env:OPENCODE_CHANNEL="prod"; bun run deploy-asar.ts
```
