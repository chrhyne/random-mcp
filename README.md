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

Alle Werkzeuge gibt es auf zwei Wegen:

- **MCP** für LLMs wie Claude: `https://random-mcp.<konto>.workers.dev/mcp`
- **REST** für Browser, Skripte, Apps: `GET https://random-mcp.<konto>.workers.dev/api/<werkzeug>?...`
- **Demo-Seite** mit Knöpfen zum Ausprobieren: `https://random-mcp.<konto>.workers.dev/`

Jede Antwort enthält das Feld `quelle`, damit Claude sagen kann, woher die Zahlen kommen.

**Zufallsquelle (Stufe 1):** `crypto.getRandomValues()` von Cloudflare Workers, ein kryptografisch sicherer Generator,
gespeist aus Hardware-Entropie. Zahlen in einem Bereich werden per Rejection Sampling gezogen (keine Verzerrung),
Listen per Fisher-Yates gemischt.

## REST-API

Alle Aufrufe sind `GET`, die Antwort ist JSON. Listen werden kommagetrennt übergeben.

| Aufruf | Parameter (Standard) |
|---|---|
| `/api/zufallszahlen?minimum=1&maximum=49&anzahl=6` | `minimum` (1), `maximum` (100), `anzahl` (1) |
| `/api/wuerfeln?anzahl=2&seiten=6` | `anzahl` (1), `seiten` (6) |
| `/api/muenzwurf?anzahl=3` | `anzahl` (1) |
| `/api/auswaehlen?optionen=Ida,Adrian,Papa` | `optionen`, `anzahl` (1), `ohne_zuruecklegen` (true) |
| `/api/mischen?elemente=A,B,C,D` | `elemente` |

`/api` listet alle Werkzeuge. Fehler kommen mit Status 400 und Feld `fehler` zurück.

## Demo: langsamer Dienst (~30 Sekunden)

Zeigt, wie man Nutzer bei langen Wartezeiten bei Laune hält – komplett mit MCP. Die Zufallszahl selbst ist echt,
nur die Wartezeit ist gespielt.

| Werkzeug | Muster | Was passiert |
|---|---|---|
| `langsame_zufallszahl` | blockierend | Aufruf dauert `dauer_sekunden` (Standard 30, max. 60); der Server schickt dabei jede Sekunde-ish eine MCP-Fortschrittsmeldung (`notifications/progress`) mit Prozent und Text |
| `auftrag_starten` | Auftrag | antwortet sofort mit `auftrag_id` und geschätzter Dauer (bis 180 s) |
| `auftrag_status` | Auftrag | liefert Fortschritt + Statustext oder das Ergebnis; mit `warten_sekunden` (bis 20) wartet der Server erst und schickt währenddessen Fortschrittsmeldungen |

**Wann welches Muster?**
- Fortschrittsmeldungen zeigt nicht jeder Client an, und manche brechen lange Aufrufe ab. Das blockierende Muster
  ist daher gut zum Vorführen, aber riskant im Alltag.
- Das Auftragsmuster funktioniert mit jedem Client: Das LLM sagt dem Nutzer die Dauer, fragt in Abständen nach und
  schreibt zwischendurch Zwischenmeldungen – der Nutzer sieht so die ganze Zeit, dass etwas passiert.

REST: `/api/auftrag_starten?minimum=1&maximum=100&dauer_sekunden=30` → `/api/auftrag_status?id=<auftrag_id>`.
Auf der Demo-Seite gibt es dafür den Knopf „🐢 Langsamer Dienst“ mit Fortschrittsbalken.

Technik: Ohne Datenbank – Startzeit, Bereich und eine zufällige Kennung stecken in der Auftrags-ID, das Ergebnis wird
daraus abgeleitet (für eine Demo okay; wer die ID kennt, könnte das Ergebnis vorab ausrechnen).

## Protokoll / Debugging

Jeder Aufruf wird als JSON-Zeile protokolliert:

- `typ: "mcp-anfrage"` – jede MCP-Nachricht: Methode (`initialize`, `tools/list`, `tools/call`), Werkzeug, Argumente,
  bei `initialize` auch Name und Version des Clients
- `typ: "werkzeug"` – jede Ausführung über MCP oder REST (`kanal`): Eingabe, Ergebnis oder Fehler, Dauer

Zu jedem Eintrag: Zeit, Anfrage-ID (Cloudflare-Ray-ID), IP, Land, Stadt und User-Agent des Aufrufers.

**Ansehen:** Cloudflare-Dashboard → *Workers & Pages* → `random-mcp` → *Logs* (gespeichert, filterbar).
Live mitlesen: `npx wrangler tail random-mcp`.

**Hinweis zum „Wer“:** Ruft Claude über einen Connector auf, kommt die Anfrage von Anthropics Servern –
IP und User-Agent zeigen also „Claude“, nicht den einzelnen Menschen. Wer genau dahinter steckt, lässt sich
erst mit einem Zugriffsschutz (Roadmap) unterscheiden.

## Projektaufbau

```
src/server.ts     der komplette Server (Zufallskern, Werkzeuge, MCP, REST, Demo-Seite, Protokoll)
wrangler.jsonc    Cloudflare-Konfiguration (Name des Workers)
package.json      Abhängigkeiten
```

Ein neues Werkzeug: Logik in `WERKZEUGE` eintragen, in `createServer()` für MCP anmelden, in `restAufruf()` die URL-Parameter zuordnen.

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
- [x] REST-API, Demo-Seite und Protokoll aller Aufrufe
- [x] Demo „langsamer Dienst“: Fortschrittsmeldungen und Auftragsmuster
- [ ] **Stufe 2: random.org als Quelle** (atmosphärisches Rauschen)
  - kostenloser Developer-Schlüssel von api.random.org (max. 1.000 Anfragen/Tag, für Entwicklung/Test gedacht)
  - Schlüssel als Cloudflare-Secret hinterlegen (`RANDOM_ORG_API_KEY`), nicht im Code
  - Parameter `quelle` für die Werkzeuge; automatischer Rückfall auf Cloudflare-Zufall bei Fehler oder leerem Kontingent
- [ ] Vorrat (Pool) für langsame Quellen: im Hintergrund per Cron auffüllen, Aufrufe antworten sofort
- [ ] Ideen für später
  - Zugriffsschutz (der Endpunkt ist bisher ohne Anmeldung erreichbar)
  - weitere Werkzeuge, z. B. Passwort- oder Namensgenerator, Teams auslosen, Glücksrad
  - Quantenzufall (ANU) als weitere Quelle prüfen
