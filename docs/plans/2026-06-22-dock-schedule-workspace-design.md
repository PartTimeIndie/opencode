## Problem

OpenCode soll stärker wie ein wiederherstellbarer Arbeitsbereich funktionieren: Dock-Bereiche, Tabs und neue Session-Entwürfe sollen nach Tabwechsel oder App-Neustart so zurückkommen, wie der Nutzer sie zuletzt verlassen hat.

Zusätzlich soll die Scheduled-Jobs-UI weniger Cron-zentriert werden: tägliche Tasks sollen über einen Date-/Time-Picker bedienbar sein, das Cron-Feld soll erhalten bleiben, und ein Button mit Icon soll aus einer Texteingabe einen Cron-Ausdruck generieren.

Konkret gewünscht:

- Docking Areas merken sich Tab-Anordnung, aktive Tabs und sichtbare Bereiche beim letzten Schließen.
- Neue Session-Tabs speichern ihren Composer-Text automatisch beim Tabwechsel und App-Schließen.
- Das Plus-Menü in Dock-Tabs soll keine einzelnen Sessions mehr listen.
- Doppelklick im Session Navigator öffnet die Session im mittleren Dock.
- Die bisherige Homepage bleibt über das Hamburger-Menü erreichbar, ist aber nicht mehr die Standard-Experience.
- Scheduled Jobs bekommen einen einfachen Daily-/Date-Picker, Cron bleibt sichtbar, und „Generate from prompt“ erzeugt Cron aus Text.

## Findings

### Branch: State Persistence

Octto-Entscheidung: **Dock-Layout + Draft-Texte**.

Relevanter Bestand:

- `packages/app/src/context/layout.tsx` persistiert bereits server-globalen Layout-State über `Persist.serverGlobal(..., "layout", ["layout.v6"])`.
- `packages/app/src/context/layout-dock.ts` modelliert Dock-Zonen mit `visible`, `size`, `tabs`, `active` und `items`.
- `packages/app/src/context/tabs.tsx` persistiert offene Session-/Draft-Tabs global und entfernt Draft-Persistenz erst beim Tab-Schließen oder beim Promoten zur echten Session.
- `packages/app/src/context/prompt.tsx` persistiert Draft-Prompts über `Persist.draft(draftID, "prompt")`.

Risiko: Plugin-Auto-Open-Aufrufe wie `session-navigator-app` und `scheduled-jobs-app` können beim Start ein zuvor geschlossenes oder verschobenes Dock-Item wieder öffnen und damit die gespeicherte Nutzeranordnung überschreiben.

### Branch: Tab Navigation

Octto-Entscheidung: **Kompaktes Aktionsmenü**.

Relevanter Bestand:

- Das untere Session-Tab-Plus in `packages/app/src/components/titlebar.tsx` erstellt bereits direkt einen neuen Draft.
- Das Dock-Zonen-Plus in `packages/app/src/pages/session/session-dock-shell.tsx` baut `dockCatalog()` aktuell aus `newSessionItem` plus allen registrierten Pane-Einträgen. Dadurch landen auch dynamische Session-Panes (`tab:...`, `new-session:...`) im Add-Menü.
- Der Session Navigator ist ein App-Plugin unter `.opencode/plugins/session-navigator-app/index.js` bzw. Quelle unter `.opencode/plugin-sources/session-navigator-app/index.js`.

Folgerung: Das Plus-Menü soll nur allgemeine Aktionen und echte Dock-Panes anzeigen: `New Session`, Built-ins, Plugin-Panes. Einzelne bestehende Sessions gehören in den Session Navigator, nicht in das Add-Menü.

### Branch: Schedule Cron UX

Octto-Entscheidung: **Date-Picker + Cron-Feld gleichwertig**.

Relevanter Bestand:

- Die installierte Scheduled-Jobs-App liegt unter `.opencode/plugins/scheduled-jobs-app/index.js`, die Quelle unter `.opencode/plugin-sources/scheduled-jobs-app/index.js`.
- Der Editor rendert aktuell ein freies `Cron schedule`-Textfeld und Cron-Beispiele.
- Die HTTP-Brücke für Scheduler-Aktionen liegt in `packages/opencode/src/server/routes/instance/httpapi/server.ts` unter `/scheduler/jobs`.

Folgerung: Cron bleibt die technische Quelle für den Scheduler, aber der Editor bekommt darüber eine einfache tägliche Eingabe. Die UI muss klar machen, ob ein Date-Picker wirklich einen einmaligen Termin, einen jährlichen Termin oder nur die tägliche Uhrzeit steuert, weil Standard-5-Feld-Cron kein Jahr und keinen „Start ab Datum“-Wert kennt.

### Branch: Default Experience

Octto-Entscheidung: **Letzten Workspace wiederherstellen**.

Relevanter Bestand:

- `/` rendert aktuell `HomeRoute` in `packages/app/src/app.tsx`.
- `TabsProvider` merkt sich einen letzten Tab (`tabs.recent`) intern und `tabs.toggleHome(...)` kann zwischen Home und letztem Tab wechseln.
- Das Hamburger-/Desktop-Menü wird über `packages/app/src/components/windows-app-menu.tsx` und `packages/app/src/desktop-menu.ts` gespeist.

Folgerung: `/` sollte bei aktiviertem neuen Layout nicht mehr primär die Home-Seite zeigen, sondern auf den zuletzt aktiven Tab/Draft/Session oder einen sinnvollen neuen Draft weiterleiten. Die Home-Seite bekommt eine eigene Route und einen Menüeintrag im Hamburger-Menü.

## Recommendation

Implementiere das als einen zusammenhängenden Workspace-Restore-Block plus eine getrennte Scheduled-Jobs-UX-Erweiterung. Die bestehende Persistenz kann wiederverwendet werden; der größte Teil der Arbeit liegt in den Restore-Regeln, UI-Filtern und Tests.

### 1. Dock- und Tab-Restore stabilisieren

Ziel: Nach Neustart werden sichtbare Dock-Bereiche, Größen, Tab-Reihenfolge und aktives Dock-Tab wiederhergestellt.

Umsetzung:

1. `layout-dock.ts` nicht neu erfinden; vorhandenen `DockState` weiterverwenden.
2. In `layout.tsx` sicherstellen, dass `dock.tabs`, `dock.active`, `dock.items[id].area` und `visible` für dynamische Tab-Panes nicht beim Start überschrieben werden.
3. In `app-runtime.tsx` Plugin-Registrierung so behandeln:
   - Wenn ein Dock-Item bereits im Persistenz-State existiert, Area/Visible/Active nicht durch Plugin-Defaults überschreiben.
   - Wenn es neu ist, Default-Area und Default-Visible verwenden.
4. Plugin-Auto-Open prüfen:
   - `session-navigator-app`: Auto-Open nur beim ersten Install/fehlendem Dock-State oder expliziter Einstellung.
   - `scheduled-jobs-app`: `autoOpen` darf Restore nicht überstimmen. Entweder Default auf „nur beim ersten Mal“ ändern oder `api.dock.open.item(...)` nur ausführen, wenn kein gespeicherter Dock-Item-State existiert.
5. Dock-Schema nur bumpen, wenn sich die gespeicherte Form ändert. Für reine Restore-Regeln reicht voraussichtlich kein Schema-Bump.

### 2. Draft-Text-Autosave verifizieren und härten

Der Code hat bereits die richtige Grundstruktur: Draft-Tabs persistieren global, Draft-Prompts persistieren pro `draftID`.

Umsetzung:

1. E2E-Test hinzufügen: neuen Draft öffnen, Text eingeben, Tab wechseln, zurückwechseln, Text muss erhalten bleiben.
2. E2E-Test hinzufügen: neuen Draft öffnen, Text eingeben, App/Page reloaden, Draft-Tab und Text müssen wiederhergestellt sein.
3. Falls Desktop-Async-Storage den letzten Tastendruck verlieren kann, `PromptProvider`/`createDraftPromptState` um einen expliziten Flush bei `pagehide`/`visibilitychange:hidden` ergänzen oder den letzten Snapshot synchron in der bestehenden Persist-Cache-Schicht halten.
4. Draft-Persistenz weiterhin nur löschen, wenn der Draft geschlossen oder zu einer echten Session promoted wurde.

### 3. Dock-Plus-Menü auf echte Pane-Aktionen beschränken

Datei: `packages/app/src/pages/session/session-dock-shell.tsx`.

Umsetzung:

1. In `dockCatalog()` dynamische Session-Panes herausfiltern:
   - IDs mit `tab:` ausschließen.
   - IDs mit `new-session:` ausschließen.
   - Optional zusätzlich `category === "Session"` nur für den expliziten `newSessionItem` erlauben.
2. `newSessionItem` bleibt oben im Menü.
3. Built-ins (`review`, `fileTree`, `gitChanges`, `terminal`, `pluginManager`) und Plugin-Panes bleiben auswählbar.
4. Test erweitern: Dock-Add-Menü öffnen und sicherstellen, dass keine bestehenden Session-Titel/`data-dock-add-item="tab:..."` erscheinen.

### 4. Session Navigator: Doppelklick öffnet im mittleren Dock

Dateien:

- `.opencode/plugin-sources/session-navigator-app/index.js`
- `.opencode/plugins/session-navigator-app/index.js` nach Build/Sync der Plugin-Quelle
- `packages/app/src/plugin/app-runtime.tsx`

Umsetzung:

1. Plugin-Host-API erweitern: `api.host.navigation.openSession({ directory, sessionID, area?: DockArea })`.
2. Runtime-Implementierung:
   - Projekt öffnen.
   - Session-Tab sicherstellen.
   - Dock-Pane-ID für diesen Tab berechnen.
   - Bei `area: "middle"` Pane in den mittleren Dock verschieben, sichtbar setzen und aktivieren.
   - Danach den Tab selektieren/navigieren, damit der mittlere Pane nicht nur Placeholder rendert.
3. Im Session Navigator:
   - Einfachklick kann bestehendes Verhalten behalten.
   - Doppelklick ruft `openSession({ directory, sessionID: session.id, area: "middle" })` auf.
   - Delete/Archive-Buttons dürfen keinen Doppelklick-Open auslösen.
4. Regressionstest in `e2e/regression/session-navigator-app.spec.ts`: Doppelklick auf Session Row -> Session-Tab/Pain im `[data-dock-area="middle"]` sichtbar.

### 5. Homepage aus dem Default-Start entfernen, aber über Hamburger behalten

Dateien:

- `packages/app/src/app.tsx`
- `packages/app/src/context/tabs.tsx`
- `packages/app/src/components/titlebar.tsx`
- `packages/app/src/desktop-menu.ts`

Umsetzung:

1. Neue explizite Home-Route, z. B. `/home`, die weiterhin `HomeRoute` rendert.
2. Root-Route `/` wird bei `newLayoutDesigns()` zu einer `WorkspaceRestoreRoute`:
   - Wenn ein letzter Tab existiert: dorthin navigieren.
   - Wenn offene Tabs existieren: ersten/aktiven wiederherstellen.
   - Wenn kein Zustand existiert, aber ein Projekt bekannt ist: neuen Draft im mittleren Dock öffnen.
   - Wenn gar kein Projekt/Server bereit ist: Fallback auf `/home`.
3. `TabsProvider` um eine kleine API ergänzen, damit die Restore-Route den letzten Tab lesen/öffnen kann, statt `tabs.recent` intern duplizieren zu müssen.
4. Hamburger-Menü: Eintrag `Home` oder `Legacy Home` hinzufügen, z. B. im `Go`- oder `View`-Menü, der `/home` öffnet.
5. Titlebar-Home-Button prüfen: Entweder zu `/home` führen oder zugunsten des Hamburger-Menüs weniger prominent machen.

### 6. Scheduled Jobs: Daily-/Date-Picker plus Cron-Feld

Dateien:

- `.opencode/plugin-sources/scheduled-jobs-app/index.js`
- `.opencode/plugins/scheduled-jobs-app/index.js` nach Sync
- optional `packages/opencode/src/server/routes/instance/httpapi/server.ts`

UX-Vorschlag:

1. Schedule-Block im Editor:
   - Modus `Daily` als Standard.
   - `Time` via `<input type="time">`.
   - Optional `Date` via `<input type="date">` nur mit klarer Beschriftung, z. B. „Preview/first run date“ oder, falls Cron daraus erzeugt wird, „Yearly date“.
   - `Cron schedule` bleibt sichtbar und editierbar.
2. Daily-Time schreibt direkt `M H * * *` in `draft.schedule`.
3. Cron-Feld schreibt zurück in die Picker, wenn es ein einfacher Daily-Cron ist.
4. Vorschau: `daily at HH:MM` und der konkrete Cron-Wert.
5. Validierung vor Save: leeres/ungültiges Cron verhindert Save und zeigt eine klare Fehlermeldung.

### 7. „Generate from prompt“-Button mit Icon

UX:

- Direkt am Cron-Feld ein Button `Generate from prompt` mit Bild/Icon.
- Icon als neues SVG, z. B. `.opencode/plugin-sources/scheduled-jobs-app/assets/generate-cron-icon.svg`, oder bewusst Wiederverwendung des Scheduled-Jobs-Icons.
- Klick öffnet eine kleine Inline-Zeile oder einen Dialog:
  - Texteingabe: „jeden Tag um 7:30“, „montags 8 Uhr“, „alle 6 Stunden“.
  - Button `Generate`.
  - Ergebnis schreibt `draft.schedule` und zeigt Erklärung.

Technischer MVP:

1. Erst einen lokalen Parser für einfache Fälle implementieren:
   - täglich um HH:MM -> `M H * * *`
   - alle N Stunden -> `0 */N * * *`
   - Wochentag um HH:MM -> `M H * * D`
2. Danach optional echte AI-Generierung über neuen Endpoint `POST /scheduler/cron/generate` ergänzen.
3. Wenn AI-Endpoint kommt: Er muss strikt validiertes JSON zurückgeben, z. B. `{ "schedule": "0 9 * * *", "explanation": "daily at 09:00" }`.
4. Jede generierte Cron-Expression muss lokal validiert werden, bevor sie in den Draft übernommen wird.

Warum Parser zuerst: Die häufigen Daily-Tasks sind sofort robust, Tests sind deterministisch, und das UI kann später ohne Umbau auf ein echtes Modell-Backend wechseln.

### 8. Implementierungsreihenfolge

1. Tests für bestehenden Restore/Draft-Zustand schreiben, damit klar ist, was schon funktioniert.
2. Dock-Plus-Menü filtern und Regressionstest ergänzen.
3. `openSession(..., area)` in der Plugin-Host-API ergänzen und Session-Navigator-Doppelklick umsetzen.
4. Dock-Plugin-Auto-Open so ändern, dass gespeicherte Nutzeranordnung Vorrang hat.
5. `/home` + Workspace-Restore-Route für `/` einführen; Hamburger-Menüeintrag hinzufügen.
6. Draft-Autosave bei Bedarf mit Flush härten.
7. Scheduled-Jobs-Editor auf Daily-/Cron-Dual-UI umbauen.
8. Generate-from-prompt-MVP mit Icon und lokalem Parser einbauen.
9. Optionalen AI-Endpoint für Cron-Generierung erst danach planen/implementieren, wenn der Parser-MVP akzeptiert ist.

### 9. Test- und QA-Matrix

Pflichttests:

- Dock-Restore:
  - Pane in andere Dock-Area ziehen, reload, gleiche Area/Reihenfolge/Active-State.
  - Plugin-Pane schließen, reload, bleibt geschlossen.
  - Session-Draft-Pane im mittleren Dock, reload, bleibt sichtbar.
- Draft-Autosave:
  - Text bleibt nach Tabwechsel erhalten.
  - Text bleibt nach Reload/App-Neustart erhalten.
  - Text wird nach Session-Erstellung nicht als alter Draft weitergeführt.
- Dock-Plus:
  - Add-Menü zeigt keine bestehenden Sessions.
  - Add-Menü zeigt `New Session`, Built-ins und Plugins.
- Session Navigator:
  - Doppelklick öffnet Session im mittleren Dock.
  - Archive/Delete lösen kein Öffnen aus.
- Homepage:
  - Start auf `/` stellt letzten Workspace wieder her.
  - Home ist über Hamburger-Menü erreichbar.
- Scheduled Jobs:
  - Daily-Time `09:00` erzeugt `0 9 * * *`.
  - Cron-Feld bleibt editierbar.
  - Generate-from-prompt erzeugt für einfache Texte erwartete Cron-Werte.
  - Ungültige Eingabe zeigt Fehler und speichert nicht.

Empfohlene Befehle nach Implementierung:

```powershell
# packages/app
bun typecheck
bun run test:e2e:controlled -- e2e/regression/dock-layout-qa.spec.ts
bun run test:e2e:controlled -- e2e/regression/session-navigator-app.spec.ts

# packages/opencode, falls Scheduler-HTTP-Endpoint geändert wird
bun typecheck

# Falls API/SDK-Schema erweitert wird
bun ./packages/sdk/js/script/build.ts
```
