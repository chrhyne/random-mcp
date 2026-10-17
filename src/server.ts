/**
 * random-mcp – Zufall-MCP-Server (Cloudflare Worker)
 * ===================================================
 * Gibt LLMs wie Claude über MCP Zugriff auf echte Zufallszahlen –
 * und bietet dieselben Funktionen zusätzlich als REST-API an.
 *
 * Quelle (Stufe 1): crypto.getRandomValues() von Cloudflare Workers.
 * Kryptografisch sicherer Zufall aus der Hardware-Entropie der Cloudflare-Server.
 *
 * Endpunkte:
 *   /            Demo-Seite im Browser
 *   /mcp         MCP-Endpunkt für Claude & Co.
 *   /api/...     REST-API (GET, Antwort als JSON), siehe README
 *
 * Protokoll: Jeder Aufruf wird als JSON-Zeile per console.log geschrieben
 * und ist im Cloudflare-Dashboard unter Workers → random-mcp → Logs zu sehen
 * (live auch per `npx wrangler tail`).
 *
 * Neues Werkzeug hinzufügen:
 *   1. Funktion in WERKZEUGE eintragen (Logik, für MCP und REST gemeinsam)
 *   2. In createServer() per registriere(...) für MCP anmelden
 *   3. In restAufruf() die URL-Parameter zuordnen
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const QUELLE = "cloudflare (crypto.getRandomValues)";
const MAX_ANZAHL = 1000;

// ------------------------------------------------------------ Zufallskern

/** Gleichverteilte ganze Zahl in [min, max], ohne Modulo-Verzerrung. */
function zufallsInt(min: number, max: number): number {
  const spanne = max - min + 1;
  if (spanne > 2 ** 32) throw new Error("Bereich zu groß (max. 2^32 Werte)");
  const grenze = Math.floor(2 ** 32 / spanne) * spanne; // Rejection Sampling
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < grenze) return min + (buf[0] % spanne);
  }
}

function zufallsInts(anzahl: number, min: number, max: number): number[] {
  if (!Number.isInteger(min) || !Number.isInteger(max))
    throw new Error("minimum und maximum müssen ganze Zahlen sein");
  if (min > max) throw new Error("minimum darf nicht größer als maximum sein");
  if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > MAX_ANZAHL)
    throw new Error(`anzahl muss zwischen 1 und ${MAX_ANZAHL} liegen`);
  return Array.from({ length: anzahl }, () => zufallsInt(min, max));
}

/** Fisher-Yates-Mischen mit sicherem Zufall. */
function mischeListe<T>(liste: T[]): T[] {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = zufallsInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------ Werkzeuge (gemeinsame Logik)

type Ergebnis = Record<string, unknown>;

const WERKZEUGE = {
  zufallszahlen(p: { minimum: number; maximum: number; anzahl: number }): Ergebnis {
    return { zahlen: zufallsInts(p.anzahl, p.minimum, p.maximum) };
  },
  wuerfeln(p: { anzahl: number; seiten: number }): Ergebnis {
    if (p.seiten < 2) throw new Error("ein Würfel braucht mindestens 2 Seiten");
    const wuerfe = zufallsInts(p.anzahl, 1, p.seiten);
    return { wuerfe, summe: wuerfe.reduce((s, w) => s + w, 0) };
  },
  muenzwurf(p: { anzahl: number }): Ergebnis {
    return { ergebnisse: zufallsInts(p.anzahl, 0, 1).map((b) => (b ? "Kopf" : "Zahl")) };
  },
  auswaehlen(p: { optionen: string[]; anzahl: number; ohne_zuruecklegen: boolean }): Ergebnis {
    if (p.optionen.length === 0) throw new Error("optionen darf nicht leer sein");
    if (p.ohne_zuruecklegen) {
      if (p.anzahl > p.optionen.length)
        throw new Error("anzahl ist größer als die Zahl der Optionen");
      return { auswahl: mischeListe(p.optionen).slice(0, p.anzahl) };
    }
    return {
      auswahl: zufallsInts(p.anzahl, 0, p.optionen.length - 1).map((i) => p.optionen[i])
    };
  },
  mischen(p: { elemente: string[] }): Ergebnis {
    if (p.elemente.length === 0) throw new Error("elemente darf nicht leer sein");
    return { reihenfolge: mischeListe(p.elemente) };
  }
};

type WerkzeugName = keyof typeof WERKZEUGE;

// ------------------------------------------------------------ Protokoll

/** Informationen über den Aufrufer, aus der HTTP-Anfrage. */
interface Aufrufer {
  anfrage_id: string;
  ip: string | null;
  land: string | null;
  stadt: string | null;
  user_agent: string | null;
}

function aufrufer(request: Request): Aufrufer {
  const cf = (request as { cf?: Record<string, unknown> }).cf ?? {};
  return {
    anfrage_id: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    ip: request.headers.get("cf-connecting-ip"),
    land: (cf.country as string) ?? null,
    stadt: (cf.city as string) ?? null,
    user_agent: request.headers.get("user-agent")
  };
}

/** Ein Protokolleintrag. `message` erscheint im Cloudflare-Dashboard in der Spalte "Message". */
function protokoll(message: string, eintrag: Record<string, unknown>) {
  console.log(JSON.stringify({ message, zeit: new Date().toISOString(), ...eintrag }));
}

const kurz = (wert: unknown) => {
  const text = JSON.stringify(wert);
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
};

/** Werkzeug ausführen und Aufruf + Ergebnis (oder Fehler) protokollieren. */
function ausfuehren(
  kanal: "mcp" | "rest",
  name: WerkzeugName,
  eingabe: Record<string, unknown>,
  wer: Aufrufer
): Ergebnis {
  const start = Date.now();
  try {
    const ergebnis = {
      ...(WERKZEUGE[name] as (p: any) => Ergebnis)(eingabe),
      quelle: QUELLE
    };
    const { quelle: _q, ...nurErgebnis } = ergebnis;
    protokoll(`[${kanal}] ${name} ${kurz(eingabe)} → ${kurz(nurErgebnis)}`,
      { typ: "werkzeug", kanal, werkzeug: name, eingabe, ergebnis, dauer_ms: Date.now() - start, ...wer });
    return ergebnis;
  } catch (e) {
    const fehler = e instanceof Error ? e.message : String(e);
    protokoll(`[${kanal}] ${name} ${kurz(eingabe)} → FEHLER: ${fehler}`,
      { typ: "werkzeug", kanal, werkzeug: name, eingabe, fehler, dauer_ms: Date.now() - start, ...wer });
    throw e;
  }
}

/** MCP-Anfragen (JSON-RPC) protokollieren: welche Methode, welcher Client. */
async function protokolliereMcpAnfrage(request: Request, wer: Aufrufer) {
  if (request.method !== "POST") {
    protokoll(`[mcp] HTTP ${request.method}`, { typ: "mcp-anfrage", http: request.method, ...wer });
    return;
  }
  try {
    const body = await request.clone().json();
    for (const nachricht of Array.isArray(body) ? body : [body]) {
      const p = nachricht?.params ?? {};
      const client = p.clientInfo ? ` von ${p.clientInfo.name} ${p.clientInfo.version ?? ""}`.trimEnd() : "";
      protokoll(`[mcp] ${nachricht?.method ?? "?"}${p.name ? " " + p.name : ""}${client}`, {
        typ: "mcp-anfrage",
        methode: nachricht?.method,
        werkzeug: p.name,
        argumente: p.arguments,
        client: p.clientInfo, // nur bei "initialize": Name/Version des Clients, z. B. Claude
        ...wer
      });
    }
  } catch {
    protokoll("[mcp] Anfrage nicht lesbar", { typ: "mcp-anfrage", hinweis: "Body nicht lesbar", ...wer });
  }
}

// ------------------------------------------------------------ Langsamer Fake-Dienst (Demo)
//
// Simuliert eine Zufallsquelle, die ~30 Sekunden braucht – um zu zeigen,
// wie man Nutzer bei langen Wartezeiten informiert. Zwei Muster:
//
//  A) Blockierend: `langsame_zufallszahl` wartet selbst und schickt währenddessen
//     MCP-Fortschrittsmeldungen (notifications/progress) und Log-Meldungen.
//  B) Auftrag: `auftrag_starten` antwortet sofort mit einer Auftrags-ID,
//     `auftrag_status` liefert Fortschritt bzw. Ergebnis.
//     Ohne Datenbank: Startzeit und Bereich stecken in der Auftrags-ID,
//     das Ergebnis wird aus der (zufälligen) ID abgeleitet.

const PHASEN = [
  "Verbinde mit der (erfundenen) Rauschquelle …",
  "Sammle Hintergrundrauschen …",
  "Filtere Störsignale heraus …",
  "Mische die Bits gründlich durch …",
  "Prüfe die Gleichverteilung …",
  "Fast fertig, poliere die Zahl …"
];

const phase = (anteil: number) =>
  PHASEN[Math.min(PHASEN.length - 1, Math.floor(anteil * PHASEN.length))];

const schlafe = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok, abbruch) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      abbruch(new Error("Aufruf wurde abgebrochen"));
    });
  });

interface Auftrag {
  s: number; // Startzeit (ms)
  d: number; // Dauer (s)
  min: number;
  max: number;
  n: string; // zufällige Kennung
}

const b64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const vonB64url = (text: string) => atob(text.replace(/-/g, "+").replace(/_/g, "/"));

function neuerAuftrag(min: number, max: number, dauer: number): string {
  if (min > max) throw new Error("minimum darf nicht größer als maximum sein");
  const n = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return b64url(JSON.stringify({ s: Date.now(), d: dauer, min, max, n } satisfies Auftrag));
}

function leseAuftrag(id: string): Auftrag {
  try {
    const a = JSON.parse(vonB64url(id)) as Auftrag;
    if (typeof a.s === "number" && typeof a.n === "string") return a;
  } catch {}
  throw new Error("Unbekannte oder ungültige Auftrags-ID");
}

/** Ergebnis aus der zufälligen Auftrags-Kennung ableiten (gleichverteilt, Rejection Sampling). */
async function auftragsErgebnis(a: Auftrag): Promise<number> {
  const spanne = a.max - a.min + 1;
  const grenze = Math.floor(2 ** 32 / spanne) * spanne;
  for (let runde = 0; ; runde++) {
    const hash = new DataView(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${a.n}:${runde}`))
    );
    for (let i = 0; i < 32; i += 4) {
      const wert = hash.getUint32(i);
      if (wert < grenze) return a.min + (wert % spanne);
    }
  }
}

async function auftragsStatus(id: string) {
  const a = leseAuftrag(id);
  const vergangen = (Date.now() - a.s) / 1000;
  const anteil = Math.min(1, vergangen / a.d);
  if (anteil < 1) {
    return {
      status: "laeuft",
      fortschritt_prozent: Math.floor(anteil * 100),
      meldung: phase(anteil),
      restzeit_sekunden: Math.ceil(a.d - vergangen),
      auftrag_id: id
    };
  }
  return {
    status: "fertig",
    fortschritt_prozent: 100,
    zahl: await auftragsErgebnis(a),
    bereich: [a.min, a.max],
    auftrag_id: id,
    quelle: "fake-langsam (Demo, abgeleitet aus Cloudflare-Zufall)"
  };
}

// ------------------------------------------------------------ MCP

function createServer(wer: Aufrufer) {
  const server = new McpServer({ name: "random-mcp", version: "1.2.0" });

  const registriere = (
    name: WerkzeugName,
    description: string,
    inputSchema: Record<string, z.ZodType>
  ) =>
    server.registerTool(name, { description, inputSchema }, async (eingabe: Record<string, unknown>) => {
      const ergebnis = ausfuehren("mcp", name, eingabe, wer);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ergebnis, null, 2) }],
        structuredContent: ergebnis
      };
    });

  const anzahl = z.number().int().min(1).max(MAX_ANZAHL).default(1);

  registriere(
    "zufallszahlen",
    "Erzeugt echte Zufallszahlen (ganze Zahlen) im Bereich minimum..maximum (inklusive). " +
      "Nutze dieses Werkzeug immer, wenn eine wirklich zufällige Zahl gebraucht wird, " +
      "statt dir selbst eine Zahl auszudenken.",
    { minimum: z.number().int().default(1), maximum: z.number().int().default(100), anzahl }
  );
  registriere(
    "wuerfeln",
    "Würfelt mit `anzahl` Würfeln mit je `seiten` Seiten (z. B. 2 x W6, 1 x W20).",
    { anzahl, seiten: z.number().int().min(2).max(1_000_000).default(6) }
  );
  registriere("muenzwurf", 'Wirft eine Münze `anzahl` Mal. Ergebnis je Wurf: "Kopf" oder "Zahl".', {
    anzahl
  });
  registriere(
    "auswaehlen",
    "Wählt zufällig aus einer Liste aus (z. B. wer anfängt, welches Spiel, welches Essen). " +
      "ohne_zuruecklegen=true: jede Option höchstens einmal.",
    { optionen: z.array(z.string()).min(1), anzahl, ohne_zuruecklegen: z.boolean().default(true) }
  );
  registriere(
    "mischen",
    "Bringt eine Liste in eine zufällige Reihenfolge (z. B. Spielreihenfolge, Karten).",
    { elemente: z.array(z.string()).min(1) }
  );

  // ---------------- Muster A: blockierend mit Fortschrittsmeldungen
  server.registerTool(
    "langsame_zufallszahl",
    {
      description:
        "DEMO eines langsamen Dienstes: erzeugt EINE Zufallszahl, braucht aber ca. `dauer_sekunden` (Standard 30). " +
        "Sendet währenddessen Fortschrittsmeldungen. Sage dem Nutzer VOR dem Aufruf, dass es etwa so lange dauert.",
      inputSchema: {
        minimum: z.number().int().default(1),
        maximum: z.number().int().default(100),
        dauer_sekunden: z.number().int().min(5).max(60).default(30)
      }
    },
    async ({ minimum, maximum, dauer_sekunden }, ctx) => {
      const start = Date.now();
      const token = ctx.mcpReq._meta?.progressToken;
      const schritte = 10;
      protokoll(`[mcp] langsame_zufallszahl gestartet (${dauer_sekunden}s, Fortschritt ${token !== undefined ? "an" : "aus"})`,
        { typ: "langsam", eingabe: { minimum, maximum, dauer_sekunden }, fortschritt_token: token ?? null, ...wer });

      for (let i = 0; i < schritte; i++) {
        const meldung = phase(i / schritte);
        if (token !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: i, total: schritte, message: meldung }
          }).catch(() => {});
        }
        await schlafe((dauer_sekunden * 1000) / schritte, ctx.mcpReq.signal);
      }

      const zahl = zufallsInts(1, minimum, maximum)[0];
      const ergebnis = { zahl, dauer_sekunden: Math.round((Date.now() - start) / 1000), quelle: "fake-langsam (Demo, Cloudflare-Zufall)" };
      protokoll(`[mcp] langsame_zufallszahl → ${zahl} nach ${ergebnis.dauer_sekunden}s`,
        { typ: "langsam", ergebnis, ...wer });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ergebnis, null, 2) }],
        structuredContent: ergebnis
      };
    }
  );

  // ---------------- Muster B: Auftrag starten + Status abfragen
  server.registerTool(
    "auftrag_starten",
    {
      description:
        "DEMO eines langsamen Dienstes als Auftrag: startet die Erzeugung EINER Zufallszahl, die ca. `dauer_sekunden` " +
        "(Standard 30) braucht, und antwortet SOFORT mit einer auftrag_id. Sage dem Nutzer die geschätzte Dauer. " +
        "Hole danach das Ergebnis mit `auftrag_status` ab.",
      inputSchema: {
        minimum: z.number().int().default(1),
        maximum: z.number().int().default(100),
        dauer_sekunden: z.number().int().min(5).max(180).default(30)
      }
    },
    async ({ minimum, maximum, dauer_sekunden }) => {
      const auftrag_id = neuerAuftrag(minimum, maximum, dauer_sekunden);
      const ergebnis = {
        auftrag_id,
        status: "gestartet",
        geschaetzte_dauer_sekunden: dauer_sekunden,
        naechster_schritt: "auftrag_status mit dieser auftrag_id aufrufen (z. B. mit warten_sekunden=10)"
      };
      protokoll(`[mcp] auftrag_starten (${minimum}–${maximum}, ${dauer_sekunden}s)`,
        { typ: "auftrag", eingabe: { minimum, maximum, dauer_sekunden }, auftrag_id, ...wer });
      return { content: [{ type: "text" as const, text: JSON.stringify(ergebnis, null, 2) }], structuredContent: ergebnis };
    }
  );

  server.registerTool(
    "auftrag_status",
    {
      description:
        "Fragt den Stand eines mit `auftrag_starten` gestarteten Auftrags ab. Mit `warten_sekunden` (bis 20) wartet der " +
        "Server erst und meldet dann den Stand – so musst du nicht ständig fragen. Solange status='laeuft': schreibe dem " +
        "Nutzer eine kurze Zwischenmeldung (Fortschritt + meldung) und frage erneut. Bei status='fertig' steht das Ergebnis in `zahl`.",
      inputSchema: {
        auftrag_id: z.string().min(1),
        warten_sekunden: z.number().int().min(0).max(20).default(10)
      }
    },
    async ({ auftrag_id, warten_sekunden }, ctx) => {
      const a = leseAuftrag(auftrag_id);
      const token = ctx.mcpReq._meta?.progressToken;
      const ende = Math.min(Date.now() + warten_sekunden * 1000, a.s + a.d * 1000);
      while (Date.now() < ende) {
        if (token !== undefined) {
          const anteil = Math.min(1, (Date.now() - a.s) / 1000 / a.d);
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: Math.floor(anteil * 100), total: 100, message: phase(anteil) }
          }).catch(() => {});
        }
        await schlafe(Math.min(2000, Math.max(0, ende - Date.now())), ctx.mcpReq.signal);
      }
      const ergebnis = await auftragsStatus(auftrag_id);
      protokoll(`[mcp] auftrag_status → ${ergebnis.status === "fertig" ? `fertig: ${ergebnis.zahl}` : `${ergebnis.fortschritt_prozent} % (${ergebnis.meldung})`}`,
        { typ: "auftrag", ergebnis, ...wer });
      return { content: [{ type: "text" as const, text: JSON.stringify(ergebnis, null, 2) }], structuredContent: ergebnis };
    }
  );

  return server;
}

// ------------------------------------------------------------ REST

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS"
};

function json(daten: unknown, status = 200) {
  return new Response(JSON.stringify(daten, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}

function zahl(q: URLSearchParams, name: string, standard: number): number {
  const wert = q.get(name);
  if (wert === null || wert === "") return standard;
  const n = Number(wert);
  if (!Number.isInteger(n)) throw new Error(`${name} muss eine ganze Zahl sein`);
  return n;
}

/** Liste aus ?x=a,b,c oder ?x=a&x=b&x=c */
function liste(q: URLSearchParams, name: string): string[] {
  return q
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function restAufruf(name: string, q: URLSearchParams, wer: Aufrufer): Response {
  let eingabe: Record<string, unknown>;
  switch (name) {
    case "zufallszahlen":
      eingabe = { minimum: zahl(q, "minimum", 1), maximum: zahl(q, "maximum", 100), anzahl: zahl(q, "anzahl", 1) };
      break;
    case "wuerfeln":
      eingabe = { anzahl: zahl(q, "anzahl", 1), seiten: zahl(q, "seiten", 6) };
      break;
    case "muenzwurf":
      eingabe = { anzahl: zahl(q, "anzahl", 1) };
      break;
    case "auswaehlen":
      eingabe = {
        optionen: liste(q, "optionen"),
        anzahl: zahl(q, "anzahl", 1),
        ohne_zuruecklegen: q.get("ohne_zuruecklegen") !== "false"
      };
      break;
    case "mischen":
      eingabe = { elemente: liste(q, "elemente") };
      break;
    default:
      return json({ fehler: `Unbekanntes Werkzeug: ${name}`, werkzeuge: Object.keys(WERKZEUGE) }, 404);
  }
  return json(ausfuehren("rest", name as WerkzeugName, eingabe, wer));
}

// ------------------------------------------------------------ Demo-Seite

const DEMO_SEITE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>random-mcp</title>
<style>
:root{--bg:#f7f5f0;--fg:#1d1b18;--muted:#6b665d;--card:#fff;--line:#e3ded3;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ede9e1;--muted:#a39d92;--card:#201e1b;--line:#35322d;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{margin:0 0 4px;font-size:28px}p{color:var(--muted);margin:0 0 24px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
button{font:inherit;padding:14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-align:left}
button:hover{border-color:var(--accent)}button b{display:block}button span{color:var(--muted);font-size:13px}
.out{margin-top:24px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.url{font:13px ui-monospace,monospace;color:var(--accent);word-break:break-all}pre{margin:8px 0 0;font:14px ui-monospace,monospace;white-space:pre-wrap}
</style></head><body><main>
<h1>random-mcp</h1>
<p>Echte Zufallszahlen für LLMs per MCP (<code>/mcp</code>) – und hier dieselben Funktionen per REST.</p>
<div class="grid">
<button data-u="/api/wuerfeln?anzahl=2"><b>🎲 2 Würfel</b><span>/api/wuerfeln?anzahl=2</span></button>
<button data-u="/api/muenzwurf"><b>🪙 Münzwurf</b><span>/api/muenzwurf</span></button>
<button data-u="/api/zufallszahlen?minimum=1&maximum=49&anzahl=6"><b>🔢 6 aus 49</b><span>/api/zufallszahlen?…</span></button>
<button data-u="/api/auswaehlen?optionen=Ida,Adrian,Papa"><b>👆 Wer fängt an?</b><span>/api/auswaehlen?optionen=…</span></button>
<button data-u="/api/mischen?elemente=Rot,Blau,Gelb,Gr%C3%BCn"><b>🔀 Reihenfolge</b><span>/api/mischen?elemente=…</span></button>
<button data-u="/api/wuerfeln?seiten=20"><b>🐉 W20</b><span>/api/wuerfeln?seiten=20</span></button>
<button id="langsam"><b>🐢 Langsamer Dienst (30 s)</b><span>/api/auftrag_starten → /api/auftrag_status</span></button>
</div>
<div class="out" id="fortschritt" hidden><div class="url"></div>
<div style="height:10px;background:var(--line);border-radius:5px;margin:12px 0 8px;overflow:hidden"><div id="balken" style="height:100%;width:0;background:var(--accent);transition:width .8s"></div></div>
<pre id="fmeldung"></pre></div>
<div class="out" hidden><div class="url"></div><pre></pre></div>
</main><script>
const out=document.querySelector('.out');
const fb=document.getElementById('fortschritt'),balken=document.getElementById('balken'),fm=document.getElementById('fmeldung');
document.getElementById('langsam').onclick=async()=>{
  fb.hidden=false;balken.style.width='0';fm.textContent='Starte Auftrag …';
  const s=await (await fetch('/api/auftrag_starten?minimum=1&maximum=100')).json();
  fb.querySelector('.url').textContent='Auftrag gestartet – geschätzte Dauer '+s.geschaetzte_dauer_sekunden+' s';
  while(true){
    const r=await (await fetch('/api/auftrag_status?id='+s.auftrag_id)).json();
    balken.style.width=r.fortschritt_prozent+'%';
    if(r.status==='fertig'){fm.textContent='🎉 Ergebnis: '+r.zahl+'\\n\\n'+JSON.stringify(r,null,2);break}
    fm.textContent=r.fortschritt_prozent+' % – '+r.meldung+' (noch ca. '+r.restzeit_sekunden+' s)';
    await new Promise(x=>setTimeout(x,1000));
  }
};
document.querySelectorAll('button[data-u]').forEach(b=>b.onclick=async()=>{
  const u=b.dataset.u;out.hidden=false;out.querySelector('.url').textContent='GET '+location.origin+u;
  const pre=out.querySelector('pre');pre.textContent='…';
  try{const r=await fetch(u);pre.textContent=JSON.stringify(await r.json(),null,2)}catch(e){pre.textContent='Fehler: '+e}
});
</script></body></html>`;

// ------------------------------------------------------------ Worker-Einstieg

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const wer = aufrufer(request);

    if (url.pathname === "/") {
      return new Response(DEMO_SEITE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return json({
        werkzeuge: [...Object.keys(WERKZEUGE), "auftrag_starten", "auftrag_status"],
        beispiel: `${url.origin}/api/wuerfeln?anzahl=2&seiten=6`
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method !== "GET") return json({ fehler: "Nur GET wird unterstützt" }, 405);
      try {
        const name = url.pathname.slice(5);
        const q = url.searchParams;
        if (name === "auftrag_starten") {
          const dauer = zahl(q, "dauer_sekunden", 30);
          if (dauer < 5 || dauer > 180) throw new Error("dauer_sekunden muss zwischen 5 und 180 liegen");
          const auftrag_id = neuerAuftrag(zahl(q, "minimum", 1), zahl(q, "maximum", 100), dauer);
          protokoll(`[rest] auftrag_starten (${dauer}s)`, { typ: "auftrag", kanal: "rest", auftrag_id, ...wer });
          return json({ auftrag_id, status: "gestartet", geschaetzte_dauer_sekunden: dauer,
            status_url: `${url.origin}/api/auftrag_status?id=${auftrag_id}` });
        }
        if (name === "auftrag_status") {
          const ergebnis = await auftragsStatus(q.get("id") ?? "");
          if (ergebnis.status === "fertig")
            protokoll(`[rest] auftrag_status → fertig: ${ergebnis.zahl}`, { typ: "auftrag", kanal: "rest", ergebnis, ...wer });
          return json(ergebnis);
        }
        return restAufruf(name, q, wer);
      } catch (e) {
        return json({ fehler: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    if (url.pathname.startsWith("/mcp")) {
      await protokolliereMcpAnfrage(request, wer);
      return createMcpHandler(() => createServer(wer))(request, env, ctx);
    }

    return json({ fehler: "Nicht gefunden", endpunkte: ["/", "/api", "/mcp"] }, 404);
  }
} satisfies ExportedHandler;
