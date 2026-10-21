## Quick Overview

- [Problem](#problem): Model-/Provider-Auswahl soll weniger rauschen und Skill-Commands dürfen gezielt ein temporäres Modell setzen.
- [Findings](#findings): Die relevanten Stellen sind App-Model-Selector, Provider-Dialog, lokale Model-State-Persistenz, Skill-Loader und Slash-Command-Insert.
- [Recommendation](#recommendation): Implementiere eine saubere, zentrale Auswahl-Schicht mit Recent-Ordering, ausblendbaren verbundenen Providern und temporären Skill-Overrides.
- [Interfaces](#interfaces): Skills bekommen Frontmatter-Felder für `provider`, `model`, optional `agent` und `variant`; die Command-Liste trägt diese Metadaten bis in die App.
- [State & Persistence](#state--persistence): Manuelle Model-Wahlen aktualisieren die letzten 3 sichtbaren Recents; Skill-Overrides bleiben temporär und schreiben keine Recent-History.
- [Implementierungs-Reihenfolge & Parallelisierung](#implementierungs-reihenfolge--parallelisierung): Backend-Schema, App-State und UI können teilweise parallel laufen; Integration und QA bleiben sequentiell.
- [Tests](#tests): Unit-, API-/SDK-, App- und kontrollierte E2E-Tests sichern Recents, Skill-Override, ESC-Rollback und Provider-Filter ab.

## Problem

Die aktuelle Auswahl zeigt an mehreren Stellen zu viele Provider/Models und nutzt die bestehende Recent-History nicht sichtbar genug. Zusätzlich können Skills noch nicht deklarieren, welches Provider-/Model-Setup für ihren Request sinnvoll ist.

Der gewünschte Zielzustand:

- Bereits verbundene Provider sollen in Add-/Connect-Listen ausblendbar sein, damit sie nicht erneut als Verbindungsoption auftauchen.
- Beim Auswählen eines neuen Models stehen die letzten 3 normal genutzten Models und Provider oben.
- Skills können ein Provider/Model für den Request vorgeben.
- Wird ein Skill per `/command` eingefügt, wechselt die Chat-Auswahl sofort sichtbar.
- Ein kurzer Hinweis sagt, dass ESC die Auswahl zurücksetzt.
- Skill-bedingte Auswahlwechsel werden nicht als „zuletzt benutzt“ gespeichert; die vorherige normale Auswahl bleibt die Recent-Basis.

## Findings

### Nutzerentscheidungen aus Octto

- Richtung: **sauber integriert** statt nur Minimalpatch.
- Skill-Provider/Model: **temporär für diesen Request**.
- ESC-Verhalten: **approved** — Skill-Auswahl sichtbar anwenden, Popup anzeigen, ESC stellt die vorherige Auswahl wieder her.
- Recent-History: **Skill-Overrides strikt ausschließen**.

### Relevante Codepfade

- `packages/app/src/components/dialog-select-model.tsx`
  - Rendert die Model-Auswahl.
  - Nutzt aktuell `model.list()`, `model.visible(...)`, Provider-Gruppierung und `model.set(..., { recent: true })`.
  - Sortiert Provider-Gruppen nach `popularProviders`, aber nicht nach Recent-Provider.
- `packages/app/src/context/models.tsx`
  - Persistiert globale Model-Daten in `Persist.global("model", ["model.v1"])`.
  - Enthält `recent: ModelKey[]`; Limit ist aktuell `5`.
  - Es gibt noch keine eigene Provider-Recent-Liste.
- `packages/app/src/context/local.tsx`
  - Verwaltet die aktuelle Agent-/Model-/Variant-Auswahl pro Session/Draft.
  - `model.set(item, { recent: true })` schreibt in die globale Recent-History.
  - Es gibt bereits `snapshot()`, aber keine öffentliche temporäre Override-/Restore-API.
- `packages/app/src/components/dialog-select-provider.tsx`
  - Zeigt aktuell Custom + alle Provider; verbundene Provider werden nicht herausgefiltert.
- `packages/app/src/components/prompt-input.tsx`
  - Baut Slash Commands aus Built-ins und `sync().data.command`.
  - Custom-/Skill-Commands werden beim Auswählen als Text `/${cmd.trigger} ` eingefügt.
  - Metadaten wie `agent`/`model` werden aktuell nicht in `SlashCommand` übernommen.
  - ESC schließt zuerst Popover/Shell, bricht dann Working ab bzw. blur-t den Composer.
- `packages/app/src/components/prompt-input/slash-popover.tsx`
  - `SlashCommand` kennt aktuell `source`, aber keine Model-/Agent-/Variant-Metadaten.
- `packages/app/src/utils/toast.tsx`
  - Einheitlicher Toast-Wrapper für Legacy/V2; geeignet für den kurzen ESC-Hinweis.
- `packages/opencode/src/skill/index.ts`
  - Skill-Frontmatter erlaubt aktuell nur `name` und optional `description`.
- `packages/opencode/src/command/index.ts`
  - `Command.Info` kennt bereits `agent` und `model`, aber Skill-Commands füllen diese Felder noch nicht.
- `packages/opencode/src/session/prompt.ts`
  - `SessionPrompt.command` bevorzugt bereits `cmd.model` vor dem UI-/Input-Model.
  - `variant` existiert im Command-Input, wird aber nicht aus `Command.Info` übernommen.
- `packages/core/src/skill.ts` und Core-/Server-Command-Schemas
  - Müssen mitgezogen werden, wenn Skill-Metadaten in SDK/API sichtbar werden.

## Recommendation

Baue die Änderung als zusammenhängendes Feature, aber mit klaren Schichten:

1. **Backend-/Schema-Schicht**: Skill-Frontmatter um Provider-/Model-/Agent-/Variant-Metadaten erweitern und als Command-Metadaten ausliefern.
2. **App-State-Schicht**: Eine temporäre Auswahl-API ergänzen, die Model/Agent/Variant sichtbar setzt, aber keine Recent-History schreibt und sauber zurückrollen kann.
3. **Selector-Schicht**: Model-Selector bekommt eine Recent-Top-Sektion und Recent-Provider-Sortierung; Provider-Connect-Listen filtern verbundene Provider aus.
4. **Composer-Schicht**: Slash-Insert erkennt Skill-Metadaten, wendet den temporären Override an, zeigt einen kurzen Toast und lässt ESC zurückrollen.
5. **QA-Schicht**: Tests prüfen Persistenzregeln, UI-Reihenfolge, Backend-Ausführung und Desktop-/App-Regressionen.

Wichtig: Verbundene Provider werden nur dort ausgeblendet, wo man neue Provider hinzufügen/verbinden will. In Settings-Bereichen, die verbundene Provider verwalten oder trennen, bleiben sie sichtbar.

## Interfaces

### Skill-Frontmatter

Skills dürfen künftig optional deklarieren:

```yaml
---
name: progressive-plan-builder
description: Guided planning flow
provider: anthropic
model: claude-sonnet-4-20250514
agent: build
variant: medium
---
```

Regeln:

- `provider` ist optional, wenn `model` bereits als `provider/model` geschrieben ist.
- `model` darf entweder `model-id` plus `provider`, oder direkt `provider-id/model-id` sein.
- Wenn `provider` gesetzt ist und `model` auch einen Provider enthält, müssen beide übereinstimmen.
- Intern wird das Command-Model weiter als `provider/model` transportiert, weil `SessionPrompt.command` dieses Format bereits via `Provider.parseModel(...)` versteht.
- `agent` bleibt optional und nutzt den bestehenden Agent-Namen.
- `variant` wird optional mittransportiert; dafür muss `Command.Info` erweitert werden, weil die Config-Schemas Variant bereits kennen.

### Command-/App-Daten

`Command.Info` soll enthalten:

- `agent?: string`
- `model?: string` als `provider/model`
- `variant?: string`
- `source?: "command" | "mcp" | "skill"`

`SlashCommand` in der App übernimmt dieselben Felder. Die temporäre UI-Anwendung ist nur aktiv, wenn ein ausgewählter Slash-Command ein `model`, `agent` oder `variant` trägt. Der Hauptfall ist `source: "skill"`; vorhandene Command-Metadaten können denselben sicheren Pfad nutzen, ohne Recent-History zu schreiben.

## State & Persistence

### Recent-History

- Die bestehende globale Model-History bleibt die Quelle: `models.recent.list()`.
- Für die UI werden nur die ersten 3 gültigen Einträge angezeigt.
- Provider-Recents werden aus den ersten 3 eindeutigen Provider-IDs der Model-History abgeleitet. Dadurch ist keine neue Provider-Persistenz nötig.
- Manuelle Model-Auswahl im Model-Selector bleibt `model.set(..., { recent: true })`.
- Temporäre Slash-/Skill-Auswahl nutzt explizit **kein** `{ recent: true }`.
- Ungültige oder nicht mehr verbundene Recent-Einträge werden beim Anzeigen übersprungen.

### Temporärer Skill-Override

In `local.tsx` wird eine kleine, öffentliche API ergänzt:

- `local.selection.snapshot()` oder äquivalenter Zugriff auf Agent/Model/Variant.
- `local.selection.applyTemporary(next)` setzt Agent/Model/Variant sichtbar, schreibt aber keine Recent-History.
- `local.selection.restore(snapshot)` stellt die vorherige Auswahl wieder her.

Alternativ kann diese API direkt unter `local.model`/`local.agent` liegen, aber sie muss gemeinsam Agent, Model und Variant erfassen, damit ESC keinen halben Zustand zurücklässt.

### Rollback-Regeln

- Beim Slash-Insert wird ein Snapshot vor dem Override gespeichert.
- Ein aktiver Snapshot gilt nur für den aktuellen Composer-Zustand.
- ESC stellt den Snapshot wieder her, wenn kein Popover offen ist und kein Shell-Modus aktiv ist.
- Wird ein neuer Skill-Command mit Override eingefügt, ersetzt er den vorherigen temporären Snapshot nicht blind: sicherer Default ist, zuerst den alten Snapshot zu restaurieren und danach den neuen Override anzuwenden.
- Beim erfolgreichen Submit wird der temporäre Snapshot verworfen; die UI-Auswahl darf sichtbar auf dem Skill-Model bleiben oder zum vorherigen Zustand zurückspringen. Für diese Anfrage ist sicherer: **nach Submit auf vorherige normale Auswahl zurückstellen**, damit der Skill-Override wirklich nur für den Request gilt.
- Wenn der Nutzer nach dem Skill-Insert manuell ein anderes Model auswählt, gilt das als bewusste Entscheidung: temporärer Snapshot wird verworfen und die manuelle Auswahl darf wieder Recent-History schreiben.

## Selector-Verhalten

### Model-Selector

Ziel-Reihenfolge:

1. Gruppe „Recent“ mit bis zu 3 zuletzt manuell genutzten, gültigen Models.
2. Danach Provider-Gruppen, zuerst die bis zu 3 Recent-Provider.
3. Danach bestehende `popularProviders`.
4. Danach übrige Provider alphabetisch.

Duplikate vermeiden:

- Ein Model, das in der Recent-Gruppe erscheint, soll nicht noch einmal in seiner normalen Provider-Gruppe auftauchen.
- Provider-Gruppen bleiben sichtbar, wenn sie andere sichtbare Models enthalten.

Suchverhalten:

- Die Suche darf weiterhin über Provider-Name, Model-Name und Model-ID filtern.
- Recent-Modelle werden bei Suchtext normal mitgefiltert; sie sind kein permanenter Pin außerhalb der Suche.

### Provider-Connect-Liste

- `DialogSelectProvider` filtert verbundene Provider aus `providers.all().values()` heraus.
- `_custom` bleibt immer sichtbar.
- Wenn alle Provider verbunden sind, zeigt die Liste nur `_custom` oder eine leere/verständliche Meldung.
- `dialog-select-model-unpaid.tsx` bekommt denselben Filter für „Add more providers“.
- Settings-Seiten, die verbundene Provider verwalten, behalten ihre Connected-Sektion.

## UI Flow

Beim Einfügen eines Skills per `/command`:

1. Der Slash-Text wird wie bisher eingefügt.
2. Falls der Skill ein Provider/Model deklariert, wird das passende Model sofort in der Chat-Auswahl sichtbar gesetzt.
3. Falls der Skill zusätzlich Agent oder Variant deklariert, werden diese ebenfalls sichtbar gesetzt.
4. Ein kurzer Toast erscheint:

   `Skill setzt Modell für diesen Request. ESC macht das rückgängig.`

5. ESC stellt die vorherige normale Auswahl wieder her und schließt den Toast.
6. Skill-Override schreibt keine Recent-History.

Fehlerfälle:

- Skill-Model ist nicht verfügbar oder Provider nicht verbunden: Override nicht anwenden; Toast mit kurzer Warnung zeigen.
- Skill-Agent existiert nicht: Model darf trotzdem angewendet werden; Warnung nennt den fehlenden Agent.
- Variant existiert für das Model nicht: Variant ignorieren und im Toast optional erwähnen.

## Key Changes

- `packages/opencode/src/skill/index.ts`
  - Frontmatter-Parsing um `provider`, `model`, `agent`, `variant` erweitern.
  - Model-Normalisierung zu `provider/model` zentral halten.
- `packages/core/src/skill.ts`
  - V2-Skill-Info analog erweitern.
- `packages/opencode/src/command/index.ts`
  - Skill-backed Commands mit `agent`, `model`, `variant` befüllen.
  - `Command.Info` um `variant` erweitern.
- `packages/opencode/src/session/prompt.ts`
  - `cmd.variant ?? input.variant` als Ausführungsvariant verwenden.
- App-/SDK-Schemas
  - Command-/Skill-Typen regenerieren, falls API-Ausgabe erweitert wird.
  - JS SDK danach mit `./packages/sdk/js/script/build.ts` regenerieren.
- `packages/app/src/context/models.tsx`
  - `recent.top(limit)` oder kleinen Helper für Top-3 gültige Recents ergänzen.
  - Provider-Recent-Ableitung aus Model-History bereitstellen oder lokal im Selector kapseln.
- `packages/app/src/context/local.tsx`
  - Snapshot/temporary-restore API ergänzen.
- `packages/app/src/components/dialog-select-model.tsx`
  - Recent-Gruppe und Recent-Provider-Sortierung einbauen.
- `packages/app/src/components/dialog-select-provider.tsx`
  - Verbundene Provider aus Add-/Connect-Liste filtern.
- `packages/app/src/components/dialog-select-model-unpaid.tsx`
  - Gleicher Provider-Filter für Add-more-Liste.
- `packages/app/src/components/prompt-input/slash-popover.tsx`
  - `SlashCommand` um `agent`, `model`, `variant` erweitern.
- `packages/app/src/components/prompt-input.tsx`
  - Command-Metadaten übernehmen.
  - Skill-/Command-Override beim Slash-Insert anwenden.
  - ESC-Rollback und Toast integrieren.

## Implementierungs-Reihenfolge & Parallelisierung

### Sichere Reihenfolge

1. **Backend-/Schema-Basis zuerst**
   - Skill-Frontmatter, `Skill.Info`, `Command.Info`, `variant` und SDK/API-Typen erweitern.
   - Muss zuerst stabil sein, weil die App nur anzeigen kann, was der Server liefert.
2. **App-State danach**
   - Temporäre Snapshot-/Restore-API in `local.tsx` ergänzen.
   - Muss vor Composer-UI fertig sein, damit ESC keine ad-hoc Einzelzustände restauriert.
3. **Selector-UI parallel zur App-State-Arbeit möglich**
   - Recent-Top-3 und Provider-Filter können parallel entstehen, solange sie nur bestehende `models.recent`/`providers.connected()` lesen.
4. **Composer-Integration danach**
   - Slash-Command-Metadaten übernehmen, Override anwenden, Toast und ESC-Rollback verdrahten.
   - Braucht Backend-Metadaten und App-State-API.
5. **Integrationstests und SDK-Regeneration**
   - Nach Schemaänderungen SDK regenerieren.
   - Danach App-/Backend-Tests laufen lassen.
6. **E2E/Visual QA zuletzt**
   - Erst sinnvoll, wenn Backend, State und UI zusammen funktionieren.

### Parallelisierbare Workstreams

- **Subagent A — Backend/Schemas**
  - Geeignet: `general` oder `explore` mit Effect-/Schema-Fokus.
  - Dateien: `packages/opencode/src/skill/index.ts`, `packages/core/src/skill.ts`, `packages/opencode/src/command/index.ts`, `packages/opencode/src/session/prompt.ts`, API/SDK-Schemas.
  - Verifikation: Skill-Loader- und command prompt tests.
- **Subagent B — Selector/Recent UI**
  - Geeignet: `general` oder UI-focused implementer.
  - Dateien: `dialog-select-model.tsx`, `dialog-select-provider.tsx`, `dialog-select-model-unpaid.tsx`, eventuell kleine Helpertests.
  - Verifikation: Unit/helper tests plus App typecheck.
- **Subagent C — Composer Temporary Override**
  - Geeignet: UI/composer-focused implementer.
  - Dateien: `local.tsx`, `prompt-input.tsx`, `slash-popover.tsx`, `utils/toast.tsx` usage.
  - Abhängigkeit: braucht finalen `SlashCommand`-Metadata-Contract von Subagent A.
  - Verifikation: prompt-input tests und slash E2E.
- **Subagent D — QA/Regression**
  - Geeignet: test/QA subagent.
  - Startet nach A+B+C Integration.
  - Verifikation: Unit, typecheck, controlled E2E, optional Desktop deploy only if user in installed app testen will.

### Muss sequentiell bleiben

- Skill-Frontmatter-Contract vor SDK-Regeneration.
- App-Command-Mapping vor Composer-Override.
- Temporary Restore API vor ESC-Integration.
- Integrationstests vor Desktop-ASAR-Deploy.
- Prod Desktop deploy nur nach erfolgreichem App/Desktop-Build, nicht als Teil der reinen Planung.

## Tests

### Backend/Core

- `packages/core/test/skill.test.ts`
  - Frontmatter mit `provider` + `model` wird gelesen.
  - Full model ref `provider/model` wird akzeptiert.
  - Mismatch zwischen `provider` und `model` wird abgelehnt.
- `packages/opencode/test/skill/skill.test.ts`
  - Legacy Skill-Loader gibt `agent`, `model`, `variant` aus.
- `packages/opencode/test/session/prompt.test.ts`
  - Skill-backed command model gewinnt gegen aktuelles UI-Model.
  - Skill-backed command agent gewinnt gegen aktuelles UI-Agent, wenn gesetzt.
  - `cmd.variant` gewinnt gegen Input-Variant, falls gesetzt.

### App Unit/Component

- `packages/app/src/context/models` oder neuer Helper-Test
  - Top-3 Recent-Models filtert ungültige Einträge.
  - Provider-Recents werden eindeutig und in richtiger Reihenfolge abgeleitet.
- `packages/app/src/components/prompt-input/submit.test.ts`
  - Temporärer Override wird nicht als Recent gespeichert.
  - Submit nutzt sichtbare temporäre Auswahl für genau diesen Request.
  - Nach Submit wird auf vorherige Auswahl zurückgestellt.
- Optional neuer Test für `local.tsx`
  - Snapshot/restore hält Agent, Model und Variant zusammen konsistent.

### E2E / Visual QA

Aus `packages/app`:

- `bun typecheck`
- `bun run test:unit`
- `bun run test:e2e:controlled -- e2e/regression/slash-anywhere.spec.ts e2e/regression/prompt-thinking-level.spec.ts`

E2E-Szenarien:

- Verbundener Provider taucht nicht in Add-/Connect-Provider-Liste auf.
- Drei Recent-Models stehen oben im Model-Selector.
- Recent-Provider-Gruppen stehen vor Popular-/Alphabetical-Gruppen.
- Skill `/command` setzt UI-Model sofort.
- Toast erscheint und ESC stellt die vorherige Auswahl wieder her.
- Skill-Override landet nicht in Recent-History nach Reload.

## Assumptions

- „Letzte 3 benutzte Provider“ meint Provider, die durch normale/manuelle Model-Auswahl zuletzt genutzt wurden; daraus wird keine separate neue Provider-History persistiert.
- Verbundene Provider sollen nur aus Add-/Connect-Listen verschwinden, nicht aus Management-/Connected-Settings.
- Skill-Overrides gelten für genau den eingefügten Skill-Request und sollen danach sicher auf den vorherigen normalen Zustand zurückfallen.
- Wenn ein Skill ein nicht verfügbares Model verlangt, wird die Auswahl nicht kaputtgeschrieben; der Nutzer bekommt stattdessen einen kurzen Hinweis.
