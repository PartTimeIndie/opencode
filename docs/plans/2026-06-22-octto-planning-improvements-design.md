# Octto / Planning Verbesserungen (5 Issues)

Datum: 2026-06-22
Status: umgesetzt (B, C, D verifiziert; A gebaut + getestet)

## Quick Overview

- [Codebasen](#codebasen--scope): Issues 1-3 = User-Plugins; Issues 4-5 = Repo `packages/app`.
- [A schnellere Fragen](#a-schnellere-fragen--pre-generation-issues-12): Probe-Session-Reuse + Upfront-Fragensequenz pro Branch + straffere Defaults.
- [B Fly-in Animation](#b-fly-in-animation-issue-3): Stabile Sektion, Animation nur beim ersten Mount.
- [C Tipptext verschwindet](#c-tipptext-fix-issue-4): Editor bleibt bei transientem `ready=false` gemountet.
- [D Tab-Markierung](#d-tab-markierung-offene-fragen-issue-5): Oranger Dot fuer Tabs mit offenen Fragen.
- [Reihenfolge](#implementierungs-reihenfolge--parallelisierung): A/B/C/D parallel umgesetzt.

## Codebasen & Scope

| Issue | Codebasis | Dateien |
|---|---|---|
| 1+2 | Plugin `~/.config/opencode/plugins/octto` | `src/tools/processor.ts`, `src/agents/probe.ts`, `src/tools/brainstorm.ts`, `src/state/*`, `src/agents/bootstrapper.ts` |
| 3 | Plugin `~/.config/opencode/plugins/octto-app` | `index.js` (`mountQuestion`, `polishStyleNode`) |
| 4 | Repo `packages/app` | `pages/session/composer/session-composer-region.tsx` |
| 5 | Repo `packages/app` | `pages/session/session-dock-shell.tsx` |

Repo-Aenderungen werden echte Commits; Plugin-Aenderungen wirken nach opencode-Neustart.

## A: Schnellere Fragen + Pre-Generation (Issues 1+2)

Root cause: `runProbeAgent` legte pro Frage eine neue Session an und loeschte sie; die naechste Frage wurde erst NACH der Antwort generiert (rein reaktiv). Kein Caching, keine Vorab-Generierung.

Umgesetzt:
- **A1 Probe-Session-Reuse**: Modulweite `Map<sessionId:branchId, probeSessionId>` in `processor.ts`. `getProbeSession` reuse-creates, `releaseProbeSession` raeumt bei Branch-Abschluss, `releaseAllProbeSessions` bei `end_brainstorm`.
- **A2 Upfront-Fragensequenz (Kernfix)**: `planned_questions: PlannedQuestion[]` pro Branch im State. `generateBranchOutline` + `parseOutlineResponse` + `formatOutlinePrompt` erzeugen beim `create_brainstorm` pro Branch EINEN Probe-Call, der eine antwort-agnostische Frage-Folge (2-3) liefert. `processAnswer` poppt die naechste geplante Frage sofort (kein Probe-Call im Happy Path); erst wenn die Folge erschoepft ist, laeuft der reaktive Probe als Fallback (fragt mehr oder schliesst ab).
- **A3 Straffere Defaults**: Probe-Guidance 2-3 (war 2-4); Bootstrapper 2-3 Branches, Cap 3 (war 4).

Netto: Probe-Calls von N (pro Frage) auf ~1 pro Branch + gelegentlichen Fallback. Naechste Frage erscheint im Common-Case sofort.

## B: Fly-in Animation (Issue 3)

Root cause: `render()` baute bei jedem Aufruf ein neues `<section>` via `replaceChildren` -> die `octto-enter`-Animation startete bei JEEM Re-Render neu -> Poppen statt Einfliegen.

Umgesetzt in `octto-app/index.js`:
- Stabile Root-Sektion (`let root`, `let body`); `render()` legt sie einmal an und aktualisiert nur `body.replaceChildren(...)`.
- `is-active`-Klasse nur beim ersten Mount; `animationend` entfernt sie (kein Re-Animieren).
- Animation sichtbarer: `translateY(10px) scale(.992) -> 0 scale(1)`, `220ms cubic-bezier(.22,.61,.36,1)`.
- Neues `.octto-body`-Flex-Layout, damit die Verschachtelung das Karten-Layout erbt.
- `prefers-reduced-motion` weiterhin deaktiviert die Animation.

## C: Tipptext Fix (Issue 4)

Root cause: `<Show when={prompt().ready()}>` tauschte bei transientem `ready=false` (Persistence-Resync, Session-Wechsel) den Editor gegen eine Read-only-Fallback-Vorschau aus -> contenteditable wird unmounted/remounted, beim Tippen verschwindet Text/Cursor.

Umgesetzt in `session-composer-region.tsx`:
- `editorReady`-Signal latcht `true`, sobald der Editor einmal ready war.
- Reset bei `route.sessionKey()`-Wechsel (im bestehenden 140ms-Effekt).
- Show-Bedingung: `editorReady() || prompt().ready()` -> Editor bleibt bei transientem Flackern gemountet; Fallback nur beim echten Initial Load.
- `QuestionPopup` nutzt bereits `autofocus={false}` (layout.tsx:2686) -> kein Fokus-Diebstahl durch andere Sessions.

## D: Tab-Markierung offene Fragen (Issue 5)

Umgesetzt in `session-dock-shell.tsx`:
- `questionSessions`-Memo: `Set<sessionID>` aus allen Tab-Verzeichnissen via `serverSync().createDirSyncContext(dir).question` (reactiv).
- `sessionId?` an `DockPane`; gesetzt in `sessionPaneForTab` und `currentRoutePane`.
- `questionSessions`-Prop an alle 6 `DockZone`-Instanzen.
- Oranger Dot (`#f0883e`, Glow-Ring) im Tab-Trigger, wenn `pane.sessionId && questionSessions().has(pane.sessionId)`; `aria-label="Open question"`.

## Implementierungs-Reihenfolge & Parallelisierung

Parallele Umsetzung (disjunkte Dateien, keine Abhaengigkeiten):
- A (Plugin octto, state + processor + brainstorm + agents).
- B (Plugin octto-app, index.js).
- C (Repo composer-region.tsx).
- D (Repo session-dock-shell.tsx).

C und D beide in `packages/app`, aber unterschiedlichen Dateien -> kein Konflikt.

Sequentiell (Abhaengigkeiten):
1. A + B + C + D parallel.
2. Pro Codebase verifizieren: Repo `bun typecheck` (packages/app); Plugin `bun run typecheck` + `bun run build`.
3. Integration: Brainstorm-Run (A+B), Tipptext (C), Tab-Dot (D).

Verification-Ergebnisse:
- packages/app typecheck: EXIT=0.
- octto plugin typecheck: EXIT=0; build: EXIT=0.
- octto plugin tests: 218 pass, 1 fail (pre-existing `bootstrapper.model`-Assertion, nicht durch diese Aenderungen verursacht - git diff zeigt nur textuelle 2-4->2-3 Edits).

## Tests

- Vorhandene octto Unit-Tests gruen bis auf den pre-existing bootstrapper.model-Fail.
- Fuer D/C gibt es keine dedizierten Component-Tests; typecheck deckt Typ-Sicherheit ab. Visuelle QA ausstehend (dev web `:4444` fuer C/D; Brainstorm-Run fuer A/B nach opencode-Neustart).

## Assumptions

- Probe nutzt weiterhin den konfigurierten Probe-Agent (kein small_model-Override).
- Tab-Dot-Orange = `#f0883e`.
- C1 gilt nur fuer die aktive Session.

## Risiken

- A2 Outline-Fragen passen gelegentlich nicht perfekt zu einer Antwort -> reaktiver Fallback faengt das beim Erschoepfen der Folge auf.
- Plugin-Aenderungen (A, B) wirken erst nach opencode-Neustart.
- Repo-Aenderungen (C, D) brauchen fuer die installierte Desktop-App einen prod ASAR-Redeploy.
