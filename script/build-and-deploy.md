# Build and Deploy von außen starten

Dieser Ablauf schließt OpenCode zuerst vollständig und baut danach in einer
unabhängigen CMD. Kein laufender Desktop und kein HTTP-Host sind nötig.

```cmd
C:\GitRepros\opencode\script\build-and-deploy.cmd
```

Alternativ aus dem Repository:

```cmd
cd /d C:\GitRepros\opencode
bun run desktop:deploy automatic
bun run desktop:deploy status
```

Der Button `Build and Deploy` ruft denselben `automatic`-Controller auf.
Ohne interaktive Konsole sind `--approved-close` und
`--force-close-approved` erforderlich; bei Fehlern fragt die sichtbare CMD
nach OpenCode-Reparatur, Codex-Reparatur, vorheriger App, geprüftem Backup
oder Abbruch. Alte manuelle `prepare`/`launch`-Kommandos bleiben als
bewusst wählbare Alternative erhalten.
