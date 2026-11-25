# Git Workbench: Branch-filtered history

Der History-Tab des Git-Workbench-Plugins zeigt Commits pro Branch oder über
alle Branches als echten Commitgraphen. Der Filter ändert nur die Ansicht —
nie den Checkout, kein Fetch.

## Bedienung

- **Branch-Dropdown** über der Liste: „Alle Branches“, der aktuelle Branch,
  lokale Branches und Remote-Branches (mit kanonischen `refs/...`-Werten).
- **„Nur Hauptlinie“**: schaltet für den gewählten Branch auf
  First-Parent-History um; bei „Alle Branches“ deaktiviert.
- **„Mehr laden“** hängt die nächste Seite an (Seitengröße = Einstellung
  „History page size“, Maximalwert 1000). Wiederholtes Klicken lädt die
  gesamte History — es gibt keine Gesamtobergrenze.
- **„Aktualisieren“** verankert die History neu. Zwischen den Seiten bleibt der
  Stand beim Laden eingefroren: neue Commits oder verschobene Branches
  verändern laufende Seiten nicht.
- Auswahl und Scrollposition bleiben beim Nachladen erhalten; die Liste
  rendert nur sichtbare Zeilen (Fensterung) und bleibt auch bei sehr langen
  Histories bedienbar.
- Graph: Linien und Farben entstehen aus echten Elternbeziehungen (Forks,
  Merges, getrennte Wurzeln). Farben bezeichnen Linien, keinen
  Branchbesitz. HEAD wird über seine Commit-ID markiert.
- Commitdetails und Aktionen (Cherry-pick, Merge, Squash) wirken auf den
  gewählten Commit der geladenen History. Lange Committexte erscheinen
  gekürzt mit sichtbarem Hinweis; „Mehr Committext laden“ holt den
  vollständigen Text in 16-KiB-Stücken nach.

## Speicherung

Pro Repository (Worktree-Pfad) werden nur die Branch-Auswahl und die
Hauptlinien-Präferenz dauerhaft gemerkt (Plugin-kv). Cursor und Commitlisten
werden nicht gespeichert; nach Neuladen startet die gewählte Ansicht frisch
mit der ersten Seite. Existiert ein gespeicherter Branch nicht mehr, fällt die
Ansicht mit sichtbarem Hinweis auf den aktuellen Branch zurück.

## Grenzen und Fehler

- Flache Kopien (`shallow`): das Ende wird als „Ende der lokal verfügbaren
  History“ gekennzeichnet; Commits an der Grenze tragen den Marker
  „lokale Grenze“. Ändert sich die Shallow-Grenze während des Nachladens,
  verlangt die Ansicht ein Aktualisieren.
- Fehler tragen strukturierte Codes (`invalid_ref`, `invalid_cursor`,
  `shallow_changed`, `output_limit`, `process_failed`) mit
  Wiederherstellungshinweis. „Erneut versuchen“ wiederholt exakt dieselbe
  Seite; „Aktualisieren“ verankert neu. Vorhandene Commits bleiben bei
  Fehlern sichtbar; Fehler gelten nie als History-Ende.
- Ein älterer Host ohne die History-API zeigt weiterhin die bisherige
  flache Snapshot-Liste.

## Schnittstelle (Server)

- `POST /vcs/git/history` — eine Seite gefilterter History. Initial:
  `selector` (`all` | `head` | `branch`), `ref` (vollständige Ref),
  `firstParent`, `limit` (1–1000). Fortsetzung: ausschließlich das opaque,
  serverseitig signierte `cursor`-Token; widersprechende Parameter werden
  abgelehnt. Antwort: `commits` (inkl. `bodyTruncated`, `boundary`),
  `hasMore`, `nextCursor`, eingefrorene `headOid`/`refLabels`.
- `POST /vcs/git/commit-message` — nächste UTF-8-sichere Textchunk eines
  Commit-Message-Volltexts (`hash` initial, `cursor` für Fortsetzungen).
- `GET /vcs/git` (Legacy-Snapshot) bleibt unverändert; `GitBranch` hat
  zusätzlich das optionale Feld `ref` mit dem kanonischen Refnamen.
- Plugin-Host: `api.host.git.history(...)` und
  `api.host.git.commitMessage(...)` mit derselben `host:git`-Fähigkeits- und
  Workspace-Grenze wie `snapshot`; Fehler werden als typisierte Errors mit
  `code`/`recovery`/`status` durchgereicht.
