# Plugin-Source- und Lifecycle-Audit

**Stand:** 2026-07-16  
**Ergebnis:** PASS – kein aktives Plugin ging verloren. Alle 15 eindeutigen Plugin-Pakete besitzen jetzt eine dauerhafte Source. Installation und Deinstallation wurden isoliert geprüft.

## Verlustschutz

- Vor dem Audit wurde der vollständige aktive Bestand gesichert:
  `C:\Users\crisc\.config\opencode\runtime-backups\plugin-audit-20260716-152201`
- Die Sicherung enthält Projekt-/Global-Sources, Runtime-Kopien, App-/TUI-Konfigurationen und SHA-256-Manifest.
- Nach dem Audit waren bei allen konfigurierten Plugins `configured=true`, `runtime=true` und `source=true`.
- Aktive Plugins wurden **nicht** deinstalliert. Die echten Install-/Deinstalltests liefen ausschließlich in temporären Projekten bzw. temporären npm-Projekten.
- Maschinenlesbarer Nachweis: [active-installation-results.json](active-installation-results.json)

## Inventar und Source-Nachweis

| Plugin | Ziel | Dauerhafte Source | Aktive Runtime/Installation | Ergebnis |
|---|---|---|---|---|
| Session Navigator | App | `.opencode/plugin-sources/session-navigator-app/` | `.opencode/plugins/session-navigator-app/` | PASS |
| Git Workbench | App | `.opencode/plugin-sources/git-workbench-app/` | `.opencode/plugins/git-workbench-app/` | PASS |
| Scheduled Jobs | App | `.opencode/plugin-sources/scheduled-jobs-app/` | `.opencode/plugins/scheduled-jobs-app/` | PASS |
| Runtime Services | App | `.opencode/plugin-sources/runtime-services-app/` | `.opencode/plugins/runtime-services-app/` | PASS |
| Visual QA | App | `.opencode/plugin-sources/visual-qa-app/` | `.opencode/plugins/visual-qa-app/` | PASS |
| Progressive Plan Builder | App | `.opencode/plugin-sources/progressive-plan-builder-app/` | `.opencode/plugins/progressive-plan-builder-app/` | PASS |
| Prompt Improve | App | `.opencode/plugin-sources/prompt-improve-app/` | `.opencode/plugins/prompt-improve-app/` | PASS |
| Multi-Agent Review | App | `.opencode/plugin-sources/multi-agent-review-app/` | `.opencode/plugins/multi-agent-review-app/` | PASS |
| Multi-Agent Problem Solver | App | `.opencode/plugin-sources/multi-agent-problem-solver-app/` | `.opencode/plugins/multi-agent-problem-solver-app/` | PASS |
| Local Desktop Deploy | App | `.opencode/plugin-sources/local-desktop-deploy-app/` | `.opencode/plugins/local-desktop-deploy-app/` | PASS |
| Codex Image Composer | App (global) | `C:\Users\crisc\.config\opencode\plugin-sources\codex-image-composer-app\` | `C:\Users\crisc\.config\opencode\plugins\codex-image-composer-app\` | PASS |
| TUI Smoke | TUI | `.opencode/plugin-sources/tui-smoke/` | aktive Einzeldatei blieb erhalten; zusätzliche Runtime-Kopie unter `.opencode/plugins/tui-smoke/` | PASS |
| OpenCode Scheduler | Server/npm | `C:\GitRepros\opencode-scheduler\` | globale Installation/Junction | PASS |
| OpenCode Goal Plugin | Server/npm | `C:\GitRepros\opencode-goal-plugin\` | globale npm-Installation | PASS |
| Cursor Provider | Server/npm | `C:\GitRepros\opencode-cursor\` | globale Installation/Junction | PASS |

### Behobene Lücken

1. Für `tui-smoke` fehlte eine dauerhafte Source. Sie liegt jetzt unter `.opencode/plugin-sources/tui-smoke/`; die bisher aktive Einzeldatei wurde als Verlustschutz nicht entfernt.
2. Für `opencode-goal-plugin@0.3.0` fehlte ein lokaler Source-Checkout. Der Checkout liegt jetzt auf dem exakten npm-`gitHead` `2ecbf9c45ae9afc5d4a56e9daf80d9e4a9626d00` unter `C:\GitRepros\opencode-goal-plugin`.
3. Mehrere bereits vorhandene `package.json`-Dateien in Plugin-Sources waren durch `.opencode/.gitignore` nicht trackbar. Die Ignore-Regel erlaubt jetzt Manifeste in allen Plugin-Source- und Runtime-Unterordnern.
4. Die globalen App-Plugin-Einträge wurden um `multi-agent-problem-solver-app` und `codex-image-composer-app` ergänzt. Source und Runtime beider Plugins sind vorhanden.

## Deinstallationsschutz

Lokale Plugins dürfen nur deinstalliert oder aus der Konfiguration entfernt werden, wenn alle folgenden Bedingungen erfüllt sind:

1. `.opencode/plugin-sources/<plugin>/` existiert.
2. Der Source-Ordner liegt im Projekt-Git-Repository und enthält bereits committete Dateien.
3. Im Source-Ordner gibt es weder untracked, unstaged noch staged Änderungen.
4. Die aktive Runtime unter `.opencode/plugins/<plugin>/` entspricht exakt der committeten Source.

Andernfalls wird die Deinstallation vor jeder Änderung an Konfiguration oder Runtime blockiert. OpenCode erstellt dabei bewusst **keinen automatischen Commit**.

## Installations-/Deinstallationstest

### App- und TUI-Plugins

Alle elf App-Plugins plus `tui-smoke` wurden einzeln über die echte Implementierung `installLocalPlugin` / `uninstallLocalPlugin` in jeweils einem frischen temporären Projekt geprüft.

Geprüft wurde je Plugin:

- Zielerkennung aus dem Manifest (`app` oder `tui`),
- Kopie in `.opencode/plugins/<plugin>`,
- Eintrag in der passenden App-/TUI-Konfiguration,
- vollständiges Entfernen der temporären Runtime bei Deinstallation,
- unveränderte Source vor und nach dem Test.

Ergebnis: **12/12 PASS**.  
Maschinenlesbarer Nachweis: [lifecycle-results.json](lifecycle-results.json)

### Server-/npm-Plugins

`opencode-scheduler`, `opencode-goal-plugin` und `@stablekernel/opencode-cursor` wurden jeweils aus ihrem lokalen Source-Checkout gepackt, in einem frischen temporären npm-Projekt installiert, erfolgreich importiert und wieder deinstalliert.

Ergebnis: **3/3 PASS**.  
Maschinenlesbarer Nachweis: [server-lifecycle-results.json](server-lifecycle-results.json)

## Visuelle Prüfung

Für alle elf App-Plugins existieren je vier Roh-Screenshots:

1. installiert – Menü beziehungsweise Composer-Toolbar,
2. installiert – eigene Settings oder Plugin Manager,
3. deinstalliert – Menü beziehungsweise Composer-Toolbar,
4. deinstalliert – eigene Settings oder Plugin Manager.

Dock-Plugins wurden im Pane-Menü wie im Referenzbild geprüft. Reine Composer-Toolbar-Plugins tauchen dort absichtlich nicht auf; bei ihnen wurde die vorgesehene Toolbar-Oberfläche geprüft. Plugins ohne eigene Settings-Registrierung wurden im Plugin Manager unter **Settings → Plugins** geprüft.

Die UI-Zustände liefen in einer isolierten Playwright-App mit den echten Plugin-Modulen. Die Dateisystem-Lifecycle-Prüfung lief separat über die echte Install-/Deinstallimplementierung, damit kein aktives Plugin gefährdet wird.

| Plugin | Kontaktbogen |
|---|---|
| Git Workbench | [Bild](contact-sheets/git-workbench-app.jpg) |
| Local Desktop Deploy | [Bild](contact-sheets/local-desktop-deploy-app.jpg) |
| Multi-Agent Problem Solver | [Bild](contact-sheets/multi-agent-problem-solver-app.jpg) |
| Multi-Agent Review | [Bild](contact-sheets/multi-agent-review-app.jpg) |
| Progressive Plan Builder | [Bild](contact-sheets/progressive-plan-builder-app.jpg) |
| Prompt Improve | [Bild](contact-sheets/prompt-improve-app.jpg) |
| Runtime Services | [Bild](contact-sheets/runtime-services-app.jpg) |
| Scheduled Jobs | [Bild](contact-sheets/scheduled-jobs-app.jpg) |
| Session Navigator | [Bild](contact-sheets/session-navigator-app.jpg) |
| Visual QA | [Bild](contact-sheets/visual-qa-app.jpg) |
| Codex Image Composer | [Bild](contact-sheets/codex-image-composer-app.jpg) |

Die 44 unskalierten Originale liegen unter:

`C:\GitRepros\opencode\docs\plugin-audit\screenshots\`

### Visuelle Nebenbefunde

- Alle elf App-Plugins bestanden die installierte und deinstallierte UI-Prüfung; kein App-Plugin fehlt.
- Lange IDs/Pfade werden im Plugin Manager teilweise gekürzt, besonders `multi-agent-problem-solver-app`. Die Zeile bleibt eindeutig, die Funktion ist nicht beeinträchtigt.
- In den Settings-Screenshots von Git Workbench und Prompt Improve ist der untere Inhalt wegen der Panelhöhe angeschnitten; die Plugin-Settings selbst sind eindeutig sichtbar.
- Die Session-Navigator-Suche zeigt gleichzeitig `Search` und `Search sessions`; das ist ein kleiner Beschriftungsbefund, kein Lifecycle-Fehler.

## Zielgrenzen der UI-Prüfung

- `tui-smoke` ist ein TUI-Plugin und besitzt deshalb keinen Desktop-Pane-/Settings-Eintrag.
- `opencode-scheduler` und `opencode-goal-plugin` sind Server-Plugins und besitzen keinen App-Pane-Eintrag.
- `@stablekernel/opencode-cursor` ist ein Server-/Provider-Plugin; seine App-Integration erscheint als Cursor-Authentifizierung in **Settings → Plugins**, nicht als Pane.
- Diese Plugins wurden daher über Source-/Runtime-/Config-Nachweis und den echten isolierten Paket-Lifecycle geprüft, nicht durch einen künstlichen Pane-Eintrag.
