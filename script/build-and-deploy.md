# Build and Deploy von außen starten

Dieser Ablauf schließt OpenCode zuerst vollständig und baut danach in einer
unabhängigen CMD. Kein laufender Desktop und kein HTTP-Host sind nötig.

```cmd
E:\GitRepros\opencode\script\build-and-deploy.cmd
```

Alternativ aus dem Repository:

```cmd
cd /d E:\GitRepros\opencode
bun run desktop:deploy automatic
bun run desktop:deploy status
```

Der Button `Build and Deploy` ruft denselben `automatic`-Controller auf.
Ohne interaktive Konsole sind `--approved-close` und
`--force-close-approved` erforderlich; bei Fehlern fragt die sichtbare CMD
nach OpenCode-Reparatur, Codex-Reparatur, vorheriger App, geprüftem Backup
oder Abbruch. Alte manuelle `prepare`/`launch`-Kommandos bleiben als
bewusst wählbare Alternative erhalten.

Ein bereits fehlgeschlagener automatischer Lauf kann ohne neuen Build erneut
an die Reparatur-CLI übergeben werden:

```cmd
cd /d E:\GitRepros\opencode\packages\opencode
bun run desktop:deploy recover opencode
```

Der gespeicherte Fehler und Logpfad werden als Startauftrag übergeben. `recover`
gibt der CLI auch die Freigabe für erneute Builds und Deploys mit Schließen
und Neustarten von OpenCode. Die Reparatur bleibt interaktiv in derselben CMD.
Der Agent untersucht nach jedem fehlgeschlagenen Versuch den neuen Log und
fragt dort nach, wenn eine echte Entscheidung fehlt. Sein Deploy-Worker läuft
mit `--agent-retry` ohne eigenes Fenster und ohne zweites Reparaturmenü.
`recover opencode --non-interactive` ist für einen einmaligen Testlauf ohne
interaktive Konsole verfügbar. Die installierte
OpenCode-CLI stammt aus diesem Fork und benötigt ihre Anbieterpakete im
CLI-Installationsordner.
