# session-schaubild-app

App-Plugin mit Composer-Knopf: Erzeugt auf Knopfdruck für die beim Klick
aktuelle Session ein kleines Schaubild (Infografik) und zeigt es inline im
Overlay an.

## Ablauf pro Klick

1. `host.sessions.context` liest den Klick-aktuellen Sessionstand (Directory +
   SessionID kommen vom Toolbar-Kontext bzw. `host.navigation.current()`).
2. `host.ai.run` (konfigurierbares Beschriftungsmodell, kein neuer Agentenchat)
   verdichtet den Kontext in kurze, nur belegte Beschriftungen: Erledigt,
   Aktueller Stand, Offen, Deine nächsten Schritte (leer = klar gekennzeichnet),
   Nächste Schritte mit Ausführungskürzel.
3. `host.images.generate` erzeugt über die vorhandene Codex-Image-Integration
   (`/app/host/images/generate` → Core `ImageGeneration`) ein 1536x1024-Schaubild
   ausschließlich mit diesen Beschriftungen. Die Bildform (Ablauf, Roadmap,
   Vorher/Nachher, Flussdiagramm) wird je Inhalt gewählt, statt starr fünf
   Infoboxen zu setzen; alle fünf Inhaltsgruppen bleiben erhalten.
4. Das Overlay zeigt Bild, Beschriftungen, Kontext-Hinweise (begrenzter
   Kontext) und die Quell-Session; „Neu erzeugen“ nutzt dieselbe Quelle.

## Laufende Session = Zwischenstand

Läuft der Agent beim Klick noch, entsteht trotzdem ein read-only
Zwischenstands-Snapshot: mit Zeitstempel, klarem „Agent arbeitet noch / noch
nicht final“-Banner im Bild und Overlay-Hinweis, ohne den Run anzuhalten oder
zu steuern und ohne unfertige Arbeit als Testerfolg darzustellen. Der
Fingerprint-Vergleich ist bewusst nur für finale Schnappschüsse aktiv; bei
Zwischenständen trägt der Zeitstempel die Frische-Aussage.

## Guardrails

- Läuft der Agent beim Klick, entsteht trotzdem ein ehrlicher, zeitgestempelter
  Zwischenstand (siehe unten) – gelesen wird nur, nie gesteuert oder
  unterbrochen; der Overlay-Hinweis markiert den Stand als nicht final.
- Doppelklick während einer Generierung wird ignoriert (Button deaktiviert,
  Generation-Zähler im Controller).
- Ändert sich bei einem finalen Schnappschuss der Session-Fingerprint zwischen
  Kontextlesen und Bildlauf, schlägt die Generierung bewusst fehl („Chat hat
  sich verändert“); Zwischenstände tragen stattdessen ihren Zeitstempel.
- Bildfehler (z. B. Codex-Backend liefert kein Bild) werden ehrlich als
  Fehlermeldung gezeigt, nicht als Erfolg.

## Echte Session-Todos

Die fünf Inhaltsgruppen werden durch einen verbindlichen „Session-Todos“-
Block ergänzt, der aus dem kanonischen Session-Todo-Speicher kommt
(`context.todos` aus `SessionPluginContext.read` → `SessionTodo.load`):
Statuswerte pending/in_progress/completed/cancelled, Fremd-Session-Todos
erscheinen nie, fehlende Listen werden ehrlich als „keine Todo-Liste
verfügbar“ markiert statt erfunden. Viele Todos werden pro Status gekürzt
(„+N weitere“); die vollständige Liste mit Details bleibt im Popup. Jede
Todo-Änderung ändert den Kontext-Fingerprint und damit die Stale-Erkennung
finaler Snapshots.

## Tests

- `core.test.js` / `app.test.js` laufen über
  `packages/app/src/plugin/session-schaubild.test.ts` in der App-Unit-Suite
  (`bun test --preload ./happydom.ts ./src` aus `packages/app`).
