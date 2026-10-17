# random-mcp

Ein eigener MCP-Server, der Claude echte Zufallszahlen liefert, statt dass Claude sich selbst Zahlen ausdenkt.
Läuft als Cloudflare Worker im kostenlosen Tarif, ohne eigenen Rechner.

## Werkzeuge

| Werkzeug | Was es tut | Beispiel |
|---|---|---|
| `zufallszahlen` | ganze Zahlen von `minimum` bis `maximum` | 6 aus 49 |
| `wuerfeln` | `anzahl` Würfel mit `seiten` Seiten, inkl. Summe | 2 × W6 |
| `muenzwurf` | Kopf oder Zahl | 3 Würfe |
| `auswaehlen` | zufällig aus einer Liste wählen | Wer fängt an? |
| `mischen` | Liste in zufällige Reihenfolge bringen | Spielreihenfolge |

Jede Antwort enthält das Feld `quelle`, damit Claude sagen kann, woher die Zahlen kommen.

**Zufallsquelle (Stufe 1):** `crypto.getRandomValues()` von Cloudflare Workers, ein kryptografisch sicherer Generator,
gespeist aus Hardware-Entropie. Zahlen in einem Bereich werden per Rejection Sampling gezogen (keine Verzerrung),
Listen per Fisher-Yates gemischt.

## Projektaufbau

```
src/server.ts     der komplette Server (Werkzeuge + Zufallskern)
wrangler.jsonc    Cloudflare-Konfiguration (Name des Workers)
package.json      Abhängigkeiten
```

Ein neues Werkzeug = ein weiterer `server.registerTool(...)`-Block in `createServer()`.

## Veröffentlichen (ohne lokale Installation)

1. Dieses Projekt in ein neues GitHub-Repository hochladen.
2. Im Cloudflare-Dashboard unter *Workers & Pages* einen neuen Worker anlegen und dabei das GitHub-Repository importieren.
   Cloudflare baut und veröffentlicht den Worker; jede Änderung im Repository wird automatisch neu veröffentlicht.
3. Die Adresse lautet dann `https://random-mcp.<dein-konto>.workers.dev`. Aufruf im Browser zeigt „random-mcp läuft“.
4. In claude.ai unter den Einstellungen einen eigenen Connector hinzufügen mit der URL
   `https://random-mcp.<dein-konto>.workers.dev/mcp`. Danach steht er auch in der Handy-App zur Verfügung.

Alternativ per Kommandozeile (Node.js nötig): `npm install`, `npx wrangler login`, `npm run deploy`.
Lokal testen: `npm run dev` → `http://localhost:8787/mcp`.

## Roadmap

- [x] **Stufe 1:** Cloudflare-Zufall (`crypto.getRandomValues`), 5 Werkzeuge, öffentlich über Cloudflare Worker
- [ ] **Stufe 2: random.org als Quelle** (atmosphärisches Rauschen)
  - kostenloser Developer-Schlüssel von api.random.org (max. 1.000 Anfragen/Tag, für Entwicklung/Test gedacht)
  - Schlüssel als Cloudflare-Secret hinterlegen (`RANDOM_ORG_API_KEY`), nicht im Code
  - Parameter `quelle` für die Werkzeuge; automatischer Rückfall auf Cloudflare-Zufall bei Fehler oder leerem Kontingent
- [ ] Ideen für später
  - Zugriffsschutz (der Endpunkt ist bisher ohne Anmeldung erreichbar)
  - weitere Werkzeuge, z. B. Passwort- oder Namensgenerator, Teams auslosen, Glücksrad
  - Quantenzufall (ANU) als weitere Quelle prüfen
