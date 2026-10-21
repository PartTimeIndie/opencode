# Octto Item Planning: Pro/Contra sichtbar halten

## Problem

In der Planung von Octto Items dürfen **Pro** und **Contra** nicht unter **„Mehr Details“** versteckt werden. Der Details-Bereich soll ausschließlich für zusätzliche Erklärungen, Beispiele, Hintergrund oder technische Caveats reserviert sein. Nutzer sollen die wichtigsten Tradeoffs direkt auf der Option sehen, ohne erst ein Detail-Panel öffnen zu müssen.

## Quick Overview

- [Entscheidung](#empfehlung): Strikte UX-Regel mit zentralem Formatter plus Validator.
- [Betroffene Flächen](#findings): Skills/Prompts, Octto Controls, Branch-Erzeugung, Tests und Docs prüfen.
- [Content-Vertrag](#content-vertrag): Pro/Contra immer sichtbar; Details nur ergänzend.
- [Umsetzung](#implementierungs-reihenfolge--parallelisierung): Recherche zuerst, danach parallele Streams für UI/Content, Technik und Tests.
- [Qualität](#tests-und-qa): Unit-/Snapshot-/Integrationstests gegen versteckte Tradeoffs.

## Findings

### UX-Vertrag

Gewählt wurde eine **strikte Regel**: Pro und Contra müssen bei planungsrelevanten Optionen immer als eigene, sichtbare Bereiche erscheinen. „Mehr Details“ darf keine Pro-/Contra-Listen enthalten und nicht nötig sein, um die Haupttradeoffs zu verstehen.

### Implementierungsflächen

Die Recherche soll alle relevanten Entstehungsorte prüfen:

- `progressive-plan-builder`, `octto-progressive-planner` und weitere Skill-/Prompt-Instruktionen.
- Octto Control Schemas und UI-Darstellung für `show_options`, `pick_one`, `pick_many` und Detailbereiche.
- Branch-/Brainstorm-Erzeugung, insbesondere `initial_question`-Konfigurationen.
- Tests, Fixtures, Snapshots und Beispielpläne mit Pro/Contra oder „Mehr Details“.
- Dokumentation und Beispiele, damit die neue Regel auch für künftige Agenten klar bleibt.

### Architektur & Absicherung

Gewählt wurde **Formatter + Validator kombiniert**:

- Ein zentraler Builder/Formatter erzeugt korrekte Optionsinhalte: sichtbare `pros` und `cons`, Details nur für Zusatzinformationen.
- Ein Validator schützt gegen manuelle, ältere oder prompt-generierte Pfade, die Pro/Contra in Details verstecken würden.

### Rollout

Die vorgeschlagene Rollout-Struktur wurde approved: erst Recherche und Vertrag, dann technische Zentralisierung, Migration betroffener Planner-Ausgaben, Tests, Docs und Backward-Compatibility-Prüfung.

## Empfehlung

Implementiere einen verbindlichen Content-Vertrag für Octto-Planungsoptionen:

1. **Sichtbare Tradeoffs sind Pflicht.** Jede Option mit relevanten Tradeoffs nutzt sichtbare Pro-/Contra-Felder oder eine gleichwertige sichtbare Darstellung.
2. **„Mehr Details“ ist kein Tradeoff-Versteck.** Details enthalten nur weiterführende Erklärung, Beispiele, Kontext, Edge Cases oder technische Caveats.
3. **Zentrale Erzeugung bevorzugen.** Planner und Branch-Erzeuger sollen Optionen über einen gemeinsamen Formatter/Builder erzeugen, statt Pro/Contra-Layout überall individuell zu formulieren.
4. **Validator als Sicherheitsnetz.** Vor Anzeige oder Test-Snapshot soll geprüft werden, ob Details verdächtige Pro-/Contra-Abschnitte enthalten.
5. **Bestehende gespeicherte Items bleiben lesbar.** Alte Inhalte werden nicht blind migriert; neue oder neu gerenderte Planungsausgaben folgen dem neuen Vertrag.

## Content-Vertrag

Für alle Octto-Planungsoptionen gilt:

- `label`: kurze Auswahlbezeichnung.
- `description`: direkte, kurze Erklärung der Option.
- `pros`: sichtbar unter der Option, wenn Vorteile entscheidungsrelevant sind.
- `cons`: sichtbar unter der Option, wenn Nachteile entscheidungsrelevant sind.
- `details` / „Mehr Details“: nur zusätzlicher Kontext, Beispiele, Implementierungshinweise, Risiken im Detail oder Hintergrundwissen.

Nicht erlaubt:

- Pro-/Contra-Überschriften innerhalb von „Mehr Details“.
- Entscheidende Nachteile nur in Details.
- Optionen, deren Kerntradeoff erst nach dem Öffnen eines Detailbereichs verständlich wird.

## Implementierungs-Reihenfolge & Parallelisierung

### Sicherer sequentieller Pfad

1. **Recherche und Fundstellenliste**
   - Subagent: `explore` oder `general`.
   - Prüft Skills/Prompts, Octto Controls, Branch-Erzeugung, Tests und Docs.
   - Muss zuerst passieren, damit zentrale Stellen nicht übersehen werden.

2. **Content-Vertrag finalisieren**
   - Subagent: `general` mit Fokus UX/Produkttext.
   - Ergebnis: kurze Regeldefinition plus erlaubte/nicht erlaubte Beispiele.
   - Baut auf der Recherche auf.

3. **Zentralen Formatter/Builder einführen oder anpassen**
   - Subagent: Implementierungsagent.
   - Erzeugt sichtbare Pro-/Contra-Strukturen und trennt Detailtext sauber ab.
   - Muss vor Migration der Aufrufer passieren.

4. **Validator ergänzen**
   - Subagent: Implementierungs- oder Testagent.
   - Erkennt Pro/Contra in Details und macht Regressionen sichtbar.
   - Kann direkt nach oder teilweise parallel zum Formatter entstehen, muss aber vor finaler Testabnahme integriert sein.

5. **Aufrufer migrieren**
   - Subagent: Implementierungsagent.
   - Betroffene Planner, Branch-Erzeuger und Beispiel-Generatoren auf den Builder umstellen.

6. **Tests, Docs und QA abschließen**
   - Subagents: Testagent und Docs-Agent parallel.
   - Danach einmal gemeinsam typecheck/test/review ausführen.

### Parallel mögliche Workstreams

Nach Schritt 1 können diese Pakete parallel laufen:

- **Workstream A — UX/Content-Vertrag**: Regeln, Beispiele, Skill-Instruktionen und Dokumentation.
- **Workstream B — Technik**: Formatter/Builder, Validator, Integration in Planner-/Branch-Pfade.
- **Workstream C — Tests/QA**: Fixtures, Golden-Beispiele, Regressionstests, UI-/Snapshot-Abdeckung.

### Muss sequentiell bleiben

- Fundstellenliste vor finaler Architekturänderung.
- Formatter/Builder vor vollständiger Migration der Aufrufer.
- Migration vor finalen Snapshot-/Integrationstests.
- Alle Streams vor finalem Review und Typecheck.

### Verifikationsreihenfolge

1. Unit-Tests für Formatter/Validator.
2. Snapshot-/Fixture-Tests für Planungsoptionen.
3. Integrationstest für Branch-/Brainstorm-Fragen.
4. Manuelle Octto-Review: Pro/Contra sichtbar, Details nur ergänzend.
5. Package-spezifischer Typecheck/Testlauf gemäß Repo-Regeln.

## Tests und QA

Mindestabdeckung:

- Option mit Pro/Contra zeigt beide Bereiche sichtbar.
- Details mit `Pro:`, `Contra:`, `Pros`, `Cons`, `Vorteile`, `Nachteile` wird vom Validator erkannt.
- Details mit Beispielen oder technischer Erklärung bleibt erlaubt.
- Optionen ohne Tradeoffs bleiben unverändert kompakt.
- progressive-plan-builder erzeugt weiterhin Pläne mit `Implementierungs-Reihenfolge & Parallelisierung`.

## Annahmen

- Die Änderung betrifft primär neu erzeugte Planungsfragen und neu gerenderte Inhalte.
- Alte gespeicherte Items müssen lesbar bleiben, aber nicht automatisch umgeschrieben werden.
- Die konkrete Code-Implementierung startet erst nach Fundstellen-Recherche im Repo.
