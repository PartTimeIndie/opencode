## Quick Overview

- [Problem](#problem): Octto soll von einem parallelen Frage-Board zu einem ruhigen, progressiven Planungsflow werden.
- [Findings](#findings): Der gewählte Zielzustand ist Einzelfrage-Flow, alle First-Run-Settings, alle Kontextquellen und optionales Auto-Implementieren nach Plan-Approval.
- [Recommendation](#recommendation): Implementiere zuerst UI-Polish und Submitted-Summary, danach Settings, Progressive Planner, Context Discovery und Approval-Automation.
- [UI requirements](#ui-requirements): Keine JSON-Submitted-Anzeige, weniger Leeraum, kurze Optionserklärung plus Details-Dropdown, Bottom-Scroll und weiches Fly-in.
- [Toolbar integration](#phase-8--toolbar-icon-and-prompt-toggle): Ein Skill-/Plugin-Icon sitzt unten in der Composer-Leiste und kann den Planungsflow für jeden Prompt aktivieren.
- [Settings](#settings): User-Settings gelten global, Project-Settings überschreiben sie, Skill-Settings werden als eigener Scope geplant.
- [Validation](#validation): Am Ende sind Renderer-Regressionen und `/visual-qa-testing` Pflicht.

## Problem

Octto zeigt Antworten und Auswahlkontrollen aktuell zu technisch und teilweise zu großflächig an. Submitted-Antworten erscheinen als JSON, `pick_many` und ähnliche Controls nehmen zu viel Platz ein, und nach dem Submit springt der Scrollbalken sichtbar.

Der neue Zielzustand ist eine Kombination aus dem `/octto` Command/Agent und dem `progressive-plan-builder` Skill: Octto stellt Fragen nacheinander, erklärt Optionen verständlich, generiert kommende Fragen im Hintergrund vor und schreibt nach Plan-Freigabe den Plan. Je nach Setting darf Octto danach direkt mit Implementierung, Checks, Hooks und Visual QA weitermachen.

## Findings

### UI Flow

Ausgewählt wurde ein **geführter Einzelfrage-Flow**:

- Immer nur die aktuell relevante Frage ist aktiv sichtbar.
- Beantwortete Fragen bleiben als kompakte, lesbare Zusammenfassung sichtbar.
- Folgende Fragen dürfen im Hintergrund vorbereitet werden, werden aber erst angezeigt, wenn sie dran sind.
- Wenn der Nutzer „Mehr Infos“ wählt oder Freitext nachfragt, wird diese Nachfrage zuerst beantwortet und danach dieselbe Entscheidungsfrage neu gestellt.

Zusätzliches Nutzerfeedback nach dem Brainstorm:

- Jede Option braucht direkt darunter eine **kurze Erklärung in Fließtext**.
- Tiefere Details gehören in ein **Dropdown**, angepasst an das gewählte Expertise-Level.
- Pick-Controls dürfen nicht wie JSON/Formular-Rohdaten aussehen.
- Controls sollen kompakter werden und weniger leeren Raum erzeugen.
- Nach Submit soll Octto im Einzelfrage-Flow einfach nach unten scrollen.
- Neu generierte Octto-Elemente sollen weich reinfliegen/einblenden, damit nichts abrupt springt.

### Planning Settings

Alle vorgeschlagenen First-Run-Settings wurden ausgewählt:

- Programmier-Erfahrung / Expertise-Level.
- Projektsprachen und Frameworks.
- Planungstiefe.
- Info-Stil.
- User-/Project-/Skill-Override-Modell.
- Weitere Einstellungen wie Auto-Implementierung, Risiko-Level, Testpflicht und Review-Strenge.

### Context Discovery

Alle Kontextquellen sollen eingeplant werden:

- Codebase-Patterns.
- Projektdokumente wie `AGENTS.md`, README und vorhandene `docs/plans`.
- Context7 / Docs MCP.
- Konfigurierbare Webquellen.
- Packages, lokale Frameworks und SDKs.
- Linters, Tests, Hooks und Automation.

### Approval, Hooks and QA

Nach Plan-Freigabe soll Octto **optional auto-implementieren**, gesteuert über Settings. Der sichere Default sollte weiterhin „Plan schreiben, dann nachfragen“ sein; Projekt- oder Skill-Settings dürfen Auto-Implementierung für vertraute Workflows aktivieren.

## Recommendation

Der aktuelle lokale Implementierungsstand erweitert diese Octto-Plugins und den Planner-Skill:

- Renderer/App-Plugin: `C:\Users\crisc\.config\opencode\plugins\octto-app\index.js`
- Octto Server/Tool-Plugin: `C:\Users\crisc\.config\opencode\plugins\octto`
- Bestehende Config-Basis: `~/.config/opencode/octto.json`
- Unterstützte Projekt-Fragmente, falls ein Projekt sie anlegt: `.octto/fragments.json`

### Phase 1 — UI Requirements

1. **Submitted-Antworten menschenlesbar formatieren**
   - Ersetze `Submitted: ${JSON.stringify(state.answer)}` durch `formatAnswerSummary(type, config, answer)`.
   - Beispiele:
     - `pick_one`: `Ausgewählt: Geführte Einzelfrage`
     - `pick_many`: `Ausgewählt: Programmier-Erfahrung, Planungstiefe, Info-Stil`
     - `show_options`: `Entscheidung: Optional auto-implementieren`
     - Freitext: `Antwort: …`
   - Debug-/Rohdaten höchstens in einem versteckten Entwickler-Details-Block, nicht im normalen UI.

2. **Compact submitted state**
   - Nach Submit keine große alte Card-Höhe beibehalten.
   - `minHeight` nur während `pending` verwenden, nicht mehr nach `submitted`.
   - Submitted-Card: kleiner Statuschip, Frage in Kurzform, Antwort als Fließtext, optional „Ändern“ später als eigenes Feature.

3. **Optionen lesbarer machen**
   - Jede Option bekommt:
     - Titel / Label.
     - Direkt sichtbare Kurzbeschreibung in 1–2 Sätzen.
     - Kleines Details-Dropdown mit tiefer Erklärung, Pros/Cons, Risiken und Beispielen.
   - Details-Level hängt am Expertise-Setting:
     - `vibe`: keine Codebegriffe ohne Erklärung.
     - `beginner`: einfache technische Begriffe mit Erklärung.
     - `intermediate`: Architektur- und Codebegriffe normal erklären.
     - `expert`: präzise technische Details, Interfaces, Constraints.

4. **Pick-/Many-Layout polieren**
   - Weniger Padding und weniger vertikale Lücken.
   - Checkbox/Radio, Titel und Kurztext in einer kompakten Zeile/Card.
   - Details-Dropdown klein und unauffällig unter der Kurzbeschreibung.
   - Keine großen leeren Bereiche nach Submit.

5. **Scroll und Animation fixen**
   - Nach erfolgreichem Submit im Einzelfrage-Flow: `requestAnimationFrame(() => scrollToBottom(container))`.
   - Neue aktive Frage per CSS-Animation einblenden: leichte Y-Translation, Opacity-Fade, ca. 160–220ms.
   - `prefers-reduced-motion` respektieren.
   - `overflow-anchor: none` für Octto-Cards beibehalten, aber nicht versuchen, alte Scrollposition beim Übergang zur nächsten Frage künstlich zu halten.

### Phase 2 — Progressive Planner Flow

Baue eine `progressive` Planungsart auf Octto:

1. Bootstrapper darf weiterhin Branches und mögliche Fragen erzeugen.
2. Ein neuer Flow-Controller zeigt aber nur **eine aktive Frage**.
3. Vorbereitete Folgefragen liegen in einer internen Queue:
   - `planned`: Frage wurde vorgeneriert.
   - `active`: Frage ist im UI sichtbar.
   - `answered`: Antwort wurde submitted.
   - `invalidated`: Frage passt nach neuer Antwort nicht mehr.
4. Wenn „Mehr Infos“ oder Freitext-Nachfrage gewählt wird:
   - Octto beantwortet zuerst die Nachfrage.
   - Die ursprüngliche Frage wird mit mehr Kontext erneut angezeigt.
   - Die alte Frage darf verschwinden oder als kompakte „ersetzt“-Summary stehen bleiben.

### Phase 3 — Settings

Erweitere Octto um strukturierte Settings. Merge-Reihenfolge:

1. Built-in Defaults.
2. User Settings: `~/.config/opencode/octto.json` oder ein neues `~/.config/opencode/octto/settings.json`.
3. Project Settings: `.octto/settings.json` oder `.opencode/octto.json` im Projekt.
4. Skill Settings: pro Skill, sobald ein allgemeines Skill-Settings-Konzept existiert; bis dahin als `skills.<skillName>` im Octto-Settings-Schema planen.
5. Runtime-Antworten aus dem First-Run-Flow.

Project Settings überschreiben User Settings. Für Arrays muss das Schema explizit sagen, ob sie `replace` oder `append` verwenden.

Vorgeschlagene Settings:

```json
{
  "planning": {
    "setupVersion": 1,
    "questionMode": "single_step",
    "detailsMode": "short_plus_expandable",
    "infoStyle": "summary_expandable",
    "expertise": "vibe",
    "planningDepth": "architecture",
    "autoImplementAfterApproval": "ask",
    "alwaysOfferMoreInfo": true,
    "visualQa": "required_for_ui_changes"
  },
  "toolbar": {
    "enabled": true,
    "showInComposerBar": true,
    "iconAsset": "assets/octto-progressive-planner.svg"
  },
  "implementation": {
    "parallelByDefault": true,
    "askForOrder": false,
    "includeSubagentWorkstreams": true
  },
  "project": {
    "languages": [],
    "packagesToInspectFirst": [],
    "docsToConsider": [],
    "lintersAndAutomation": [],
    "skillsToUse": [],
    "hooksToRun": []
  },
  "research": {
    "context7": { "enabled": true },
    "webSources": { "mode": "ask", "allowlist": [] },
    "patternDiscovery": "codebase_then_docs_then_web"
  }
}
```

### Phase 4 — First-Run Setup Flow

Beim ersten Start fragt Octto eine Frage nach der anderen:

1. **Programmier-Erfahrung**
   - Vibe Coding / Anfänger / Fortgeschritten / Experte.
2. **Info-Stil**
   - Detailliert.
   - Übersicht plus ausklappbare Details.
   - Sehr grob.
3. **Planungstiefe**
   - Requirements: Minimum, immer aktiv; Nutzer beschreibt Ziel, Octto plant Umsetzung mit nur High-Level-Fragen.
   - Architektur: größere Architekturentscheidungen werden abgefragt.
   - Service-/Interface-Ebene: Services, APIs, Interfaces und Datenflüsse werden geplant.
   - Klassen-Ebene: alle wichtigen Klassen/Module werden geplant.
   - Test-/Release-Ebene: Tests, Rollback, Deploy, Visual QA und Hooks werden mitgeplant.
4. **Auto-Implementierung nach Approval**
   - Nie automatisch.
   - Immer fragen.
   - Automatisch bei niedrigerem Risiko / Projekt erlaubt.
5. **Projektsprachen**
   - Erst Codebase scannen: Dateiendungen, `package.json`, `tsconfig`, lockfiles, Buildfiles.
   - Wenn keine klare Sprache gefunden wird: Nutzer fragen.
   - Zusätzlich lokale History auswerten, wenn datenschutztechnisch ok; daraus Top-6-Sprachen als Multiple Choice anbieten plus Freitext.
6. **Dokumentationen und Quellen**
   - Context7 MCP verwenden/installieren.
   - Offizielle Docs und erlaubte Webquellen per Checkbox auswählen.
7. **Projektpakete und lokale Frameworks**
   - Packages, interne Frameworks und SDKs abfragen, die bei jedem Plan zuerst geprüft werden sollen.
8. **Automation**
   - Linter, Typecheck, Tests, E2E, Deploy-Skills, Visual QA, Reviewer-Hooks.

### Phase 5 — Pattern Discovery

Keine festen Pattern hart hinterlegen. Für jeden Plan:

1. Ähnliche Implementierungen im Projekt suchen.
2. Projektkonventionen und Styleguides lesen.
3. Sprache/Framework erkennen.
4. Passende Pattern-Vorschläge ableiten.
5. Wenn Webrecherche erlaubt ist, konfigurierte Quellen anbieten:
   - Offizielle Framework-Dokumentation.
   - Context7-Dokumentation.
   - Sprach-/Framework-spezifische Architektur-Guides.
   - Optional Quellen wie `patterns.dev`, Refactoring Guru oder Microsoft/MDN/React/Effect-Dokumentation, wenn passend.
6. Wenn keine passenden Quellen konfiguriert sind: Octto fragt per Checkbox, welche Websites genutzt werden dürfen, plus Freitext.

### Phase 6 — Plan Approval and Auto Implementation

Wenn ein `show_plan` approved wird:

1. Plan immer zuerst schreiben: `docs/plans/YYYY-MM-DD-{topic}-design.md`.
2. Danach Setting prüfen:
   - `off`: stoppen und Implementierung anbieten.
   - `ask`: kurze Confirm-Frage stellen.
   - `on_low_risk`: nur bei risikoarmen Änderungen direkt starten, sonst fragen.
   - `on`: direkt mit Guardrails starten.
3. Vor Auto-Implementierung immer abbrechen oder nachfragen bei:
   - Secrets/Keys/Authentifizierung.
   - destruktiven Dateioperationen.
   - Datenmigrationen.
   - Produktiv-Deploys.
   - unklaren Anforderungen.
4. Implementation startet mit Todo-Liste, danach Tests, Reviewer-Hooks und bei UI- oder Runtime-Änderungen explizit `/visual-qa-testing`.
5. Jeder finale Plan enthält **Implementierungs-Reihenfolge & Parallelisierung**:
   - welche Pakete parallel durch Subagents laufen können,
   - welche Schritte wegen Abhängigkeiten sequentiell bleiben müssen,
   - welche Subagents/Rollen zu welchem Paket passen,
   - welche Reihenfolge sicher ist,
   - welche Verifikation nach welchem Paket laufen soll.
6. Default-Setting: `implementation.parallelByDefault: true` und `implementation.askForOrder: false`; Octto fragt den Nutzer also nicht jedes Mal nach der Reihenfolge, sondern entscheidet nach Abhängigkeiten und dokumentiert die Entscheidung.

### Phase 7 — Skills and Hooks

Plane einen generischen Hook-Adapter, falls OpenCode noch keinen allgemeinen per-project Hook-Weg hat:

- Events:
  - `plan.approved`
  - `plan.written`
  - `implementation.started`
  - `implementation.completed`
  - `pre_commit`
  - `post_commit`
- Hook-Konfig pro Projekt.
- Skills, die automatisch in den Planungs-/Implementierungsflow eingebunden werden dürfen.

Eigener Auto-Reviewer:

- Als Skill oder Hook `auto-code-reviewer` planen.
- Nach Implementierung oder vor Commit diffen.
- Prüft Scope, Styleguide, Tests, offensichtliche Bugs, Security-Risiken und UI-Risiken.
- Ergebnis wird als Octto-Review-Section angezeigt.
- Bei High-Risk-Fund stoppt Auto-Implementierung und fragt den Nutzer.

### Phase 8 — Toolbar Icon and Prompt Toggle

Der progressive Planungsflow bekommt ein eigenes Icon in der unteren Composer-/Prompt-Leiste. Das muss als Zusammenspiel aus `progressive-plan-builder` Skill und Octto App-Plugin umgesetzt werden, nicht als lose lokale UI-Sonderlösung.

1. **Icon-Asset**
   - Zielpfad im Plugin: `plugins/octto-app/assets/octto-progressive-planner.svg`.
   - Das Icon soll dem OpenCode Plugin-Icon-Stil folgen: dunkle Grundform, cyanfarbene Linien, violetter Akzent, kein Text, bei 16–24px lesbar.
   - `/codex-image` kann ein PNG-Konzept generieren; für die finale Toolbar sollte daraus ein kompaktes SVG abgeleitet werden, damit es bei kleinen Größen scharf bleibt.

2. **Composer-Bar Integration**
   - Das App-Plugin registriert einen unteren Toolbar-/Composer-Button ähnlich dem Visual-QA-Toggle.
   - Klick auf das Icon toggelt den nächsten Prompt in den progressiven Octto-Planungsflow.
   - Aktiver Zustand ist klar sichtbar: farbiger Ring/Fill, Tooltip und kurzer Status wie „Progressive Planung aktiv“.

3. **Prompt-Toggle-State**
   - Der Progressive-Plan-Builder kann für jeden Prompt aktiviert werden, unabhängig von Session-Alter oder Nachrichtenposition.
   - Der Toolbar-Zustand bleibt nutzersteuerbar und wird gemäß User-/Projekt-Settings persistiert.
   - Projektdefaults dürfen den Planner automatisch aktivieren, aber nicht an die Nachrichtenposition koppeln.

4. **Skill-/Plugin-Grenze**
   - Der Skill definiert Verhalten, Prompt-Policy und Defaults.
   - Das Plugin liefert UI, Icon, Persistenz und Toolbar-State.
   - Settings werden gemeinsam gelesen, damit `/octto`, der Toolbar-Button und der Progressive-Plan-Builder dieselben Defaults verwenden.
   - Zusätzlich gibt es einen sichtbaren Alias-Skill `octto-progressive-planner`, damit der kombinierte Flow in der Skill-/Slash-Auswahl direkt auffindbar ist.

### Weitere sinnvolle Settings

- Maximalzahl Fragen pro Plan.
- Risiko-Level: schnell / normal / streng.
- Testtiefe: smoke / unit / integration / E2E / Visual QA.
- Datenschutzmodus für Web- und History-Recherche.
- Bevorzugte Plan-Datei-Orte und ADR-Erstellung.
- Ob Entscheidungen dauerhaft in Projektregeln übernommen werden sollen.
- Ob Deploy-Schritte immer eingeplant werden.
- Ob Performance, Accessibility, Security und Responsive QA automatisch gefragt werden.
- Ob der Nutzer immer eine „Entscheide du“-Option sehen will.

## Validation

Nach Implementierung:

1. Renderer-Regressionen erweitern:
   - Submitted Summary zeigt kein JSON.
   - Pick Many ist kompakt.
   - Kurzbeschreibung ist sichtbar.
   - Details-Dropdown klappt auf.
   - Nach Submit scrollt die Ansicht nach unten.
   - Neue Frage blendet/flyt sauber ein.
   - Reduced-Motion deaktiviert Animation.
   - Toolbar-Icon ist in der unteren Leiste sichtbar und kompakt.
   - Toolbar-Toggle aktiviert und deaktiviert den Planungsflow zuverlässig für den nächsten Prompt.
   - Projektdefaults koppeln den Planungsflow nicht an die Nachrichtenposition.
2. Octto endpoint/tool tests für Answer-State und Plan-Approval-Automation ergänzen.
3. `bun run typecheck` im Octto Plugin ausführen.
4. App-Plugin mit vorhandener Renderer-Visual-QA prüfen.
5. `/visual-qa-testing` ausführen und Screenshots/Videos inline anhängen.
6. Wenn die installierte Desktop-App getestet werden soll: vollständigen Prod-ASAR-Deploy-Flow ausführen, nicht nur Source ändern.
