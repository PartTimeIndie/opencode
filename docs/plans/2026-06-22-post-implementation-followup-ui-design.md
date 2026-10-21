## Quick Overview

- [Problem](#problem): Nach einer fertigen Implementierung wirken Octto-Follow-up-Fragen aktuell wie normale noch offene Arbeit.
- [Findings](#findings): Der sichere Default ist eine eigene Abschluss-Statuskarte vor optionalen Follow-up-Fragen.
- [Recommendation](#recommendation): Erweitere den Question-Contract um eine Follow-up-Phase und rendere diese Phase im bestehenden Question Dock.
- [Implementierungs-Reihenfolge & Parallelisierung](#implementierungs-reihenfolge--parallelisierung): Contract zuerst, danach UI/i18n/QA parallel.
- [Validation](#validation): Contract-, UI- und Typecheck-Prüfung; SDK-Regeneration bei API-Typänderung.

## Problem

Post-Implementation-Octto-Fragen sollen nicht so wirken, als sei die Implementierung noch blockiert oder unvollständig. Der Nutzer soll klar erkennen: Die Arbeit ist abgeschlossen; die folgenden Fragen sind optional und dienen nur Review, Korrekturwünschen oder nächsten Schritten.

## Findings

- UX-Default: Eine **Abschluss-Statuskarte mit Kurzsummary** ist klarer als nur ein kleiner Header.
- Technik-Default: Bestehende Octto-/Question-UI weiterverwenden und nur eine Phase/Präsentation ergänzen.
- Contract-Default: Ein explizites Phase-Feld ist robuster als Text-Heuristik.
- Qualität-Default: Unit-/Contract-Tests, UI-/Visual-Prüfung und SDK-Regeneration prüfen.

## Recommendation

Implementiere eine neue Question-Phase für optionale Post-Implementation-Follow-ups:

1. Der Question-Request kann `phase: "implementation_complete_followup"` tragen.
2. `SessionQuestionDock` erkennt diese Phase und rendert vor der eigentlichen Frage eine Statuskarte.
3. Die Karte sagt kurz und deutlich:
   - **Implementation complete** / **Implementierung abgeschlossen**
   - **These follow-up questions are optional** / **Diese Follow-up-Fragen sind optional**
4. Bestehende Antworten, Dismiss und Submit bleiben unverändert, damit die Frage-Mechanik stabil bleibt.
5. Tool-Parameter dürfen die Phase setzen, damit Agents nach fertiger Umsetzung bewusst optionale Follow-ups markieren können.

## Implementierungs-Reihenfolge & Parallelisierung

### Muss sequenziell bleiben

1. **Contract zuerst**
   - `QuestionV2.Request` und AskInput um `phase` erweitern.
   - Tool-Input so erweitern, dass Agents die Follow-up-Phase bewusst setzen können.
   - Diese Entscheidung muss vor UI und SDK stehen, weil alle anderen Workstreams davon abhängen.

2. **SDK-Regeneration nach Contract-Änderung**
   - Wenn die Schema-Änderung öffentliche SDK-Typen betrifft, `./packages/sdk/js/script/build.ts` ausführen.

3. **Verifikation nach Integration**
   - Typecheck und Tests erst nach Contract + UI + i18n ausführen.

### Kann parallel laufen

- **UI-Agent**: `SessionQuestionDock` rendert Statuskarte und kleine CSS-Slots.
- **Core/API-Agent**: Schema, Tool-Input und Tests für `phase`.
- **i18n-Agent**: englische/deutsche Texte und Fallback-Kompatibilität.
- **QA-Agent**: Testplan, E2E/Visual-Szenario und Typecheck-Kommandos vorbereiten.

### Sichere Reihenfolge

Contract → SDK falls nötig → UI Rendering → i18n → Contract/UI Tests → Typecheck → optional Desktop-Prod-Deploy, falls die installierte App getestet werden soll.

## Validation

- Core Question Tests oder Tool Tests erweitern, damit `phase` durch `ask` und Tool-Execution erhalten bleibt.
- UI-Test oder E2E-Regressionsszenario für die sichtbare Statuskarte.
- `bun typecheck` in betroffenen Package-Ordnern, niemals aus dem Repo-Root.
- Bei Desktop-Testfreigabe erst vollständiger prod Desktop Build und ASAR Deploy.
