/**
 * random-mcp – Zufall-MCP-Server (Cloudflare Worker)
 * ======================================
 * Gibt Claude über MCP Zugriff auf echte Zufallszahlen.
 *
 * Quelle (Stufe 1): crypto.getRandomValues() von Cloudflare Workers.
 * Das ist ein kryptografisch sicherer Zufallsgenerator, gespeist aus der
 * Hardware-Entropie der Cloudflare-Server. Nicht vorhersagbar, kein Seed.
 *
 * Endpunkt: https://<worker-name>.<konto>.workers.dev/mcp
 *
 * Neue Werkzeuge hinzufügen: unten in createServer() ein weiteres
 * server.registerTool(...) nach dem gleichen Muster einbauen.
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
  if (min > max) throw new Error("minimum darf nicht größer als maximum sein");
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

/** Ergebnis als Text (für Claude) und strukturiert zurückgeben. */
function antwort(daten: Record<string, unknown>) {
  const mitQuelle = { ...daten, quelle: QUELLE };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(mitQuelle, null, 2) }],
    structuredContent: mitQuelle
  };
}

const anzahlSchema = z.number().int().min(1).max(MAX_ANZAHL).default(1);

// ------------------------------------------------------------ Werkzeuge

function createServer() {
  const server = new McpServer({ name: "random-mcp", version: "1.0.0" });

  server.registerTool(
    "zufallszahlen",
    {
      description:
        "Erzeugt echte Zufallszahlen (ganze Zahlen) im Bereich minimum..maximum (inklusive). " +
        "Nutze dieses Werkzeug immer, wenn eine wirklich zufällige Zahl gebraucht wird, " +
        "statt dir selbst eine Zahl auszudenken.",
      inputSchema: {
        minimum: z.number().int().default(1),
        maximum: z.number().int().default(100),
        anzahl: anzahlSchema
      }
    },
    async ({ minimum, maximum, anzahl }) =>
      antwort({ zahlen: zufallsInts(anzahl, minimum, maximum) })
  );

  server.registerTool(
    "wuerfeln",
    {
      description: "Würfelt mit `anzahl` Würfeln mit je `seiten` Seiten (z. B. 2 x W6, 1 x W20).",
      inputSchema: {
        anzahl: anzahlSchema,
        seiten: z.number().int().min(2).max(1_000_000).default(6)
      }
    },
    async ({ anzahl, seiten }) => {
      const wuerfe = zufallsInts(anzahl, 1, seiten);
      return antwort({ wuerfe, summe: wuerfe.reduce((s, w) => s + w, 0) });
    }
  );

  server.registerTool(
    "muenzwurf",
    {
      description: 'Wirft eine Münze `anzahl` Mal. Ergebnis je Wurf: "Kopf" oder "Zahl".',
      inputSchema: { anzahl: anzahlSchema }
    },
    async ({ anzahl }) =>
      antwort({ ergebnisse: zufallsInts(anzahl, 0, 1).map((b) => (b ? "Kopf" : "Zahl")) })
  );

  server.registerTool(
    "auswaehlen",
    {
      description:
        "Wählt zufällig aus einer Liste aus (z. B. wer anfängt, welches Spiel, welches Essen). " +
        "ohne_zuruecklegen=true: jede Option höchstens einmal.",
      inputSchema: {
        optionen: z.array(z.string()).min(1),
        anzahl: anzahlSchema,
        ohne_zuruecklegen: z.boolean().default(true)
      }
    },
    async ({ optionen, anzahl, ohne_zuruecklegen }) => {
      if (ohne_zuruecklegen) {
        if (anzahl > optionen.length)
          throw new Error("anzahl ist größer als die Zahl der Optionen");
        return antwort({ auswahl: mischeListe(optionen).slice(0, anzahl) });
      }
      return antwort({
        auswahl: zufallsInts(anzahl, 0, optionen.length - 1).map((i) => optionen[i])
      });
    }
  );

  server.registerTool(
    "mischen",
    {
      description: "Bringt eine Liste in eine zufällige Reihenfolge (z. B. Spielreihenfolge, Karten).",
      inputSchema: { elemente: z.array(z.string()).min(1) }
    },
    async ({ elemente }) => antwort({ reihenfolge: mischeListe(elemente) })
  );

  return server;
}

// ------------------------------------------------------------ Worker-Einstieg

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("random-mcp läuft. MCP-Endpunkt: /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    return createMcpHandler(createServer)(request, env, ctx);
  }
} satisfies ExportedHandler;
