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

function protokoll(eintrag: Record<string, unknown>) {
  console.log(JSON.stringify({ zeit: new Date().toISOString(), ...eintrag }));
}

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
    protokoll({ typ: "werkzeug", kanal, werkzeug: name, eingabe, ergebnis, dauer_ms: Date.now() - start, ...wer });
    return ergebnis;
  } catch (e) {
    const fehler = e instanceof Error ? e.message : String(e);
    protokoll({ typ: "werkzeug", kanal, werkzeug: name, eingabe, fehler, dauer_ms: Date.now() - start, ...wer });
    throw e;
  }
}

/** MCP-Anfragen (JSON-RPC) protokollieren: welche Methode, welcher Client. */
async function protokolliereMcpAnfrage(request: Request, wer: Aufrufer) {
  if (request.method !== "POST") {
    protokoll({ typ: "mcp-anfrage", http: request.method, ...wer });
    return;
  }
  try {
    const body = await request.clone().json();
    for (const nachricht of Array.isArray(body) ? body : [body]) {
      const p = nachricht?.params ?? {};
      protokoll({
        typ: "mcp-anfrage",
        methode: nachricht?.method,
        werkzeug: p.name,
        argumente: p.arguments,
        client: p.clientInfo, // nur bei "initialize": Name/Version des Clients, z. B. Claude
        ...wer
      });
    }
  } catch {
    protokoll({ typ: "mcp-anfrage", hinweis: "Body nicht lesbar", ...wer });
  }
}

// ------------------------------------------------------------ MCP

function createServer(wer: Aufrufer) {
  const server = new McpServer({ name: "random-mcp", version: "1.1.0" });

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
</div>
<div class="out" hidden><div class="url"></div><pre></pre></div>
</main><script>
const out=document.querySelector('.out');
document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
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
        werkzeuge: Object.keys(WERKZEUGE),
        beispiel: `${url.origin}/api/wuerfeln?anzahl=2&seiten=6`
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method !== "GET") return json({ fehler: "Nur GET wird unterstützt" }, 405);
      try {
        return restAufruf(url.pathname.slice(5), url.searchParams, wer);
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
