# Plugin-Trennung und Voice-Ausgabe – Abnahme 2026-09-09

## Lieferumfang

Die Implementierung ersetzt fachliche Host-Sonderwege durch öffentliche Plugin-Verträge. App, Server, Provider, Native und TUI bleiben getrennte Einstiegspunkte. Die gemeinsame SDK-Quelle liegt in `packages/plugin`; `packages/llm` ist ein öffentliches Paket.

| Plan | Implementierte Grenze |
| --- | --- |
| P0 | Modellabhängige Stimmen/Formate, fehlende Modelle innerhalb der gewählten Kette überspringen, Fallback vor ersten Audiobytes, sichtbare Wiedergabefehler, Abbruch und persistenter Replay-Schutz |
| P1 | Versionierte Services mit Schemas, hostseitiger Identität/Capabilities, Projektkontext und Lifecycle; veröffentlichte App-Funktionen und unabhängiger SDK-Verbraucher |
| P2 | Generische Session-Verknüpfungen und Dispatch, geprüfte Herkunft statt frei gesetzter Rechte, idempotente Migration und Ergebniszustellung ohne automatisches Wiederholen von Providerarbeit |
| P3 | Scheduler und Runtime Services als Serverpakete, generische Service-Aufrufe und Navigation, keine globale Arbeitsverzeichnisänderung |
| P4 | Composer-Registry einschließlich Serverwechsel/Unload, generische Settings, Mikrofonpriorität und neutrale Desktop-Aktivitäten |
| P5 | 39 Provider-Pakete und 12 TUI-Pakete; öffentliche Auth-, Transport-, Katalog-, Transform- und Native-Verträge |

Serverquellen liegen dauerhaft unter `C:/GitRepros/opencode-{scheduler,runtime-services,voice-conversation,review,problem-solver,openrouter-media}`. Appquellen liegen unter `.opencode/plugin-sources`. Runtimekopien werden erst mit der gemeinsamen Host-Auslieferung aktiviert. Goal, Ponytail und die bestehende globale Image-Composer-Erweiterung bleiben an ihren regulären öffentlichen Hooks.

## Nachweise

- AST-Prüfung der tatsächlichen Pluginquellen: private Host-Imports, relative Paketüberschreitungen und fehlende deklarierte Abhängigkeiten blockieren die Paketierung. Bericht: `.agent-tmp/plugin-boundaries/architecture-audit.json`.
- Externer SDK-Verbraucher aus echten Tarballs, ohne Repoquellen oder Repo-node_modules: 40 öffentliche Exporte vorhanden und importierbar. Bericht: `.agent-tmp/plugin-boundaries/public-sdk-consumer-report.json`. `skipLibCheck: false` zeigt gesonderte Drittanbieter-Deklarationsfehler in Effect/OpenTUI.
- Fokussierte Core-/Plugin-/Provider-/Lifecycle-Tests einschließlich Migration, Schema-Reparatur und konkurrierender Zustellung. Release-Transaktion: 18 Tests, 91 Assertions erfolgreich.
- Electron-Utility-Process-Smoke lädt einen neutralen externen Service und ruft ihn über die öffentliche HTTP-Grenze auf; tatsächliche Node-Laufzeit ohne globales Bun.
- Browserprüfungen: Voice mit mehr als 160 User-Turns, Load Older, Assistant-Seitengrenze, Hash-Wiederherstellung und Reload; Desktop/Mobile, Diktat im angehefteten Entwurf, Composer-Werkzeuge, Dock, Scheduler, Runtime Services und Reviewer-Einstellungen. Screenshots/Videos unter `.agent-tmp/plugin-boundaries/visual-qa`.
- Echte deutsche Provider-Audiodateien: `packages/opencode/test-results/tts-p0-live`. Sie belegen die Provider-Ausgabe, noch keine installierte Systemwiedergabe.

Der konfigurierte Multi-Agent-Review lief über die lokale OpenCode-Installation. Konkrete Befunde wurden geprüft und korrigiert; verworfene Befunde wurden begründet. GLM meldete ein Provider-Quotalimit (HTTP 429/1310); einzelne Cursor-Teilprüfungen erreichten das festgelegte Budget. Das ist keine vollständige grüne Reviewer-Abnahme. Einzelurteile und Dispositionen: `.agent-tmp/plugin-boundaries/review-scopes`.

## Gemeinsame Auslieferung und Rücksicherung

`packages/opencode/script/prepare-plugin-release.ts` erstellt unveränderliche App-/Server-Snapshots und erhält bestehende Konfigurationsoptionen. Neue Server-Runtimepakete liegen unter `~/.config/opencode/plugin-packages`; bestehende Junctions zu Quellrepos bleiben unangetastet.

Der vollständige Prod-Deploy bindet Host-Artefakt, externe Paketversionen, API-Anforderungen, Hashes und Konfiguration zusammen. Vor jedem Austausch werden Baselines geprüft. Rollback überschreibt keine zwischenzeitlichen Änderungen; Konflikte erhalten neue Arbeit und Sicherungen. Quittungen werden gegen das unveränderliche Manifest geprüft.

Konsistente SQLite-Sicherung einschließlich WAL: `C:/Users/crisc/AppData/Local/OpenCodeDeploy/database-snapshots/plugin-boundaries-20260909T113410.db`, SHA-256 `48f0565d0343723b2dad1c628fa0bbea28f62be596d1962daf4d692cfedd9b81`. Daten werden nicht automatisch auf einen alten Stand zurückgesetzt.

## Installierte Integration

Der Nutzer hat Schließen, erforderliches Erzwingen des Schließens und Neustarten für diesen Chat ausdrücklich freigegeben. Mehrere vollständige Prod-Deploys haben reale Integrationsfehler aufgedeckt, die inzwischen durch Regressionen abgesichert sind:

- Eigenständige Providerartefakte werden für Node gebaut und unter Bun, Node und Electron ohne Repo-Abhängigkeiten geladen. Beide Provider-HTTP-Kataloge werden im tatsächlich gebauten Electron-Utility-Prozess geprüft.
- Plugin und HTTP verwenden denselben echten Session-Runtime-Dienst. Fremde Projekt-Sessions werden vor Anlegen einer Verknüpfung abgewiesen.
- Runtime Services exportiert seinen Server-Einstiegspunkt mit stabiler Plugin-ID. Die generische HTTP-Grenze serialisiert optionale JSON-Felder korrekt.
- OpenRouter liefert TTS-Modelle über seinen gesonderten Speech-Katalog. Entfernte Modelle bleiben in der gespeicherten Auswahl erhalten; gültige Stimmen werden aus dem aktuellen Katalog übernommen.
- Öffentliche Session-Abonnements empfangen transiente und dauerhafte V2-Ereignisse. Der gemeinsame geordnete Ereignispuffer verhindert verdoppelte Antworttexte. 91 Tests/323 Assertions sowie erneute Desktop-/Mobile-Prüfung mit 170 User-Turns bestanden.
- Projektübergreifende Scheduler-Ergebnisabfragen verwenden das Arbeitsverzeichnis des Jobs. Der zuvor abgewiesene PhotoBrowser-Aufruf liefert mit korrektem Kontext HTTP 200; die Host-Projektsperre bleibt bestehen. 20 Tests/181 Assertions bestanden.
- Voice übernimmt beim erneuten Start aktuelle Audioeinstellungen, ohne das gepinnte Moderator-Modell zu ändern. 39 Tests/105 Assertions bestanden.

Der abschließende vollständige Prod-Deploy ist mit dauerhaftem Status `completed` und erfolgreichem Neustart geprüft:

| Quittung | Wert |
| --- | --- |
| Build | `20260909T105354Z-1262d8d0` |
| Quellfingerprint | `2d29ba192b3b2c1d81d28cd881361acb9582f29ca1f918fc1923b8febb0aa2c3` |
| Artefakt SHA-256 | `5769074a2948d1242985e3540e7aaf6905204fc37940f0b9bb941acf73dfd8c8` |
| Externes Manifest SHA-256 | `7b3752c31e93da4bd6b11bbcddda3cae7b84e346652721791716d3dd053908d4` |
| Backup | `C:/Users/crisc/AppData/Local/Programs/@opencode-aidesktop.backup-20260909T105649Z-20260909T105354Z-1262d8d0` |
| Log | `C:/Users/crisc/AppData/Local/OpenCodeDeploy/build-20260909T105354Z-1262d8d0.log` |
| Abschluss | `2026-09-09T10:57:02.966Z` |

Die abschließende Architekturprüfung aller 71 Pakete steht in `.agent-tmp/plugin-boundaries/architecture-audit-final.json`. Neue Quellen sind im Git-Index bekannt; es wurde nicht committet oder gepusht. Vorhandene fremde Änderungen bleiben erhalten.

## Deutsche Stimme und Audio-Nachweis

Auf Nutzerwunsch ist `model:openrouter/microsoft/mai-voice-2` mit `de-DE-Klaus:MAI-Voice-2` gewählt. Die vorherige Modellkette wurde nicht gelöscht. Der aktuelle OpenRouter-Katalog bestätigt diese deutsche Stimme; Voxtral bietet dort nur englische und französische Stimmen an. Quellen: [Microsoft MAI Voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices), [Mistral Sprachwahl](https://docs.mistral.ai/studio/audio/text_to_speech/speech).

Die direkte Klaus-Ausgabe wurde mit dem konfigurierten STT-Modell korrekt als deutscher Testsatz zurücktranskribiert (`.agent-tmp/plugin-boundaries/klaus-provider.wav`). Das ist zunächst ein Provider-Nachweis.

Windows hatte OpenCode auf 3 Prozent Anwendungslautstärke eingestellt. Ausschließlich OpenCode wurde zunächst auf 35 Prozent und wegen der weiterhin leisen Sprache abschließend auf normale 100 Prozent Anwendungslautstärke erhöht. Systemlautstärke und andere Anwendungen blieben unverändert. Bereits 993 Samples des separaten Windows-Audiosessions-Meters bei 35 Prozent belegten tatsächliche OpenCode-Ausgabe am verwendeten Kopfhörerausgang, davon 83 mit Signal und maximal 25,95 Prozent Pegel. Die frühen gemischten Loopback-Aufnahmen enthalten andere Anwendungen und wurden nicht als verständlicher deutscher End-to-End-Nachweis gewertet.

Für die abschließende reine Ausgabeprüfung wurde nur der vom Test erworbene Voice-Mikrofonstream stummgeschaltet. Ein getippter Prompt ging durch die echte Session-Ausführung, TTS durch den gewählten Provider und die Wiedergabe durch den normalen Systemausgang. Andere Mikrofonbenutzer blieben unberührt. Nach Abschluss wurde die Testunterhaltung beendet und die ursprüngliche PhotoBrowser-Sitzung wieder geöffnet.

## Abschließender Audio- und Visual-QA-Nachweis

- Die installierte Voice-Oberfläche erzeugte zwei erfolgreiche TTS-Aufrufe mit `openrouter/microsoft/mai-voice-2`, MP3 und `de-DE-Klaus:MAI-Voice-2`. Keine Seiten-/Netzfehler im abschließenden Interaktionsvideo; nur der bestehende ScriptProcessorNode-Abkündigungshinweis. Bericht: `.agent-tmp/plugin-boundaries/german-acceptance/events.json`.
- Die tatsächlich an AudioBufferSource gestarteten, unveränderten Sprachdaten wurden mit Zeitstempeln kopiert. Der Beobachter änderte weder Audiograph, Signal noch Scheduling und wurde anschließend entfernt. Beide Sprachstücke wurden zusammen korrekt zurücktranskribiert: „Guten Tag. Die Sprachausgabe von OpenCode funktioniert jetzt. Dies ist die abschließende Tonprüfung.“ Datei: `.agent-tmp/plugin-boundaries/klaus-voice-proof.wav` samt `.transcript.json`.
- Die unveränderte Windows-WASAPI-Mischaufnahme enthält exakt diese Sprachdaten: normierte Wellenformkorrelation 0,749 und 0,712 bei geschätztem Verstärkungsfaktor 0,989 und 0,992. Rückwärts abgespielte Referenzen als Negativkontrollen bleiben bei 0,148 und 0,124; beide konservativen Vergleichsprüfungen bestanden. Bericht: `.agent-tmp/plugin-boundaries/klaus-final-correlation.json`; Originalaufnahme: `klaus-final-volume.wav`. Dies belegt die Ausgabe am Windows-Audioendpoint, keine subjektive Hörbestätigung am physischen Ohr.
- Das geprüfte Video des tatsächlich installierten Voice-Ablaufs und der Screenshot liegen unter `.agent-tmp/plugin-boundaries/german-acceptance/{video.mp4,voice-installed.png}`. Die veröffentlichte Hörprobe enthält nur die tatsächlich vom Plugin abgespielte Sprache; andere System-Audioinhalte werden nicht als Hörprobe veröffentlicht.
- Erneute 170-Turn-Visual-QA nach dem Ereignisfix: `.agent-tmp/plugin-boundaries/visual-qa/event-order-20260909/verification-result.json`. Desktop/Mobile, Load Older, Assistant-Seitengrenze, Reload und Hash-Wiederherstellung bestanden. Der zusätzliche mobile Nachweis unter `visual-qa/mobile-paging-proof` schließt das Voice-Fenster physisch, damit der Seitenrand tatsächlich unverdeckt sichtbar ist. Videos vollständig decodiert und Screenshots/Kontaktbögen geprüft.

Die Implementierung und installierte Funktionsabnahme sind abgeschlossen. Die oben dokumentierte eingeschränkte Verfügbarkeit der konfigurierten Multi-Agent-Reviewer bleibt ausdrücklich bestehen; daraus wird kein vollständiger Reviewer-PASS abgeleitet.
