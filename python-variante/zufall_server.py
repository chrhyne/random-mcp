"""
Zufall-MCP-Server
=================
Gibt Claude über MCP Zugriff auf echte Zufallszahlen.

Zwei Quellen:
  - "system"     : Kryptografischer Zufall des Betriebssystems (Python `secrets`).
                   Wird aus Hardware-Rauschen gespeist (CPU-Jitter, Interrupts,
                   Hardware-RNG). Schnell, offline, nicht vorhersagbar.
  - "random.org" : Zufall aus atmosphärischem Rauschen (Funkempfänger).
                   Physikalisch "echt", braucht Internet, hat ein Tageskontingent.
                   Fällt automatisch auf "system" zurück, wenn nicht erreichbar.

Start:
  lokal für Claude Desktop (stdio):   python zufall_server.py
  als Web-Server (für Connector):     python zufall_server.py --http --port 8000
                                      -> Endpunkt: http://<host>:8000/mcp

Voraussetzung:  pip install mcp
"""

import argparse
import secrets
import urllib.parse
import urllib.request

try:  # MCP-SDK 2.x
    from mcp.server.mcpserver import MCPServer as _Server
    _SDK2 = True
except ImportError:  # MCP-SDK 1.x
    from mcp.server.fastmcp import FastMCP as _Server
    _SDK2 = False

mcp = _Server("zufall")
_rng = secrets.SystemRandom()  # OS-Entropie, kein Seed, nicht reproduzierbar


# ---------------------------------------------------------------- Hilfsfunktionen

def _system_ints(n: int, lo: int, hi: int) -> list[int]:
    return [lo + secrets.randbelow(hi - lo + 1) for _ in range(n)]


def _random_org_ints(n: int, lo: int, hi: int) -> list[int]:
    params = urllib.parse.urlencode({
        "num": n, "min": lo, "max": hi, "col": 1,
        "base": 10, "format": "plain", "rnd": "new",
    })
    req = urllib.request.Request(
        f"https://www.random.org/integers/?{params}",
        headers={"User-Agent": "zufall-mcp/1.0"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return [int(x) for x in resp.read().decode().split()]


def _ints(n: int, lo: int, hi: int, quelle: str) -> tuple[list[int], str]:
    if lo > hi:
        raise ValueError("minimum darf nicht größer als maximum sein")
    if not 1 <= n <= 1000:
        raise ValueError("anzahl muss zwischen 1 und 1000 liegen")
    if quelle == "random.org":
        if -1_000_000_000 <= lo and hi <= 1_000_000_000:
            try:
                return _random_org_ints(n, lo, hi), "random.org (atmosphärisches Rauschen)"
            except Exception as e:  # Netz weg, Kontingent leer, ...
                return _system_ints(n, lo, hi), f"system (random.org nicht erreichbar: {e.__class__.__name__})"
        return _system_ints(n, lo, hi), "system (Bereich zu groß für random.org)"
    return _system_ints(n, lo, hi), "system (OS-Entropie)"


# ---------------------------------------------------------------- Tools

@mcp.tool()
def zufallszahlen(minimum: int = 1, maximum: int = 100, anzahl: int = 1,
                  quelle: str = "system") -> dict:
    """Erzeugt echte Zufallszahlen (ganze Zahlen) im Bereich minimum..maximum (inklusive).
    quelle: "system" (Standard, OS-Entropie) oder "random.org" (atmosphärisches Rauschen).
    Nutze dieses Tool immer, wenn eine wirklich zufällige Zahl gebraucht wird,
    statt selbst eine Zahl auszudenken."""
    zahlen, q = _ints(anzahl, minimum, maximum, quelle)
    return {"zahlen": zahlen, "quelle": q}


@mcp.tool()
def wuerfeln(anzahl: int = 1, seiten: int = 6, quelle: str = "system") -> dict:
    """Würfelt mit `anzahl` Würfeln mit je `seiten` Seiten (z. B. 2 x W6, 1 x W20)."""
    if seiten < 2:
        raise ValueError("ein Würfel braucht mindestens 2 Seiten")
    wuerfe, q = _ints(anzahl, 1, seiten, quelle)
    return {"wuerfe": wuerfe, "summe": sum(wuerfe), "quelle": q}


@mcp.tool()
def muenzwurf(anzahl: int = 1, quelle: str = "system") -> dict:
    """Wirft eine Münze `anzahl` Mal. Ergebnis: "Kopf" oder "Zahl"."""
    bits, q = _ints(anzahl, 0, 1, quelle)
    return {"ergebnisse": ["Kopf" if b else "Zahl" for b in bits], "quelle": q}


@mcp.tool()
def auswaehlen(optionen: list[str], anzahl: int = 1,
               ohne_zuruecklegen: bool = True) -> dict:
    """Wählt zufällig aus einer Liste aus (z. B. wer anfängt, welches Spiel, welches Essen).
    ohne_zuruecklegen=True: jede Option höchstens einmal."""
    if not optionen:
        raise ValueError("optionen darf nicht leer sein")
    if ohne_zuruecklegen:
        if anzahl > len(optionen):
            raise ValueError("anzahl ist größer als die Zahl der Optionen")
        auswahl = _rng.sample(optionen, anzahl)
    else:
        auswahl = [_rng.choice(optionen) for _ in range(anzahl)]
    return {"auswahl": auswahl, "quelle": "system (OS-Entropie)"}


@mcp.tool()
def mischen(elemente: list[str]) -> dict:
    """Bringt eine Liste in eine zufällige Reihenfolge (z. B. Spielreihenfolge, Karten)."""
    gemischt = list(elemente)
    _rng.shuffle(gemischt)
    return {"reihenfolge": gemischt, "quelle": "system (OS-Entropie)"}


# ---------------------------------------------------------------- Start

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Zufall-MCP-Server")
    ap.add_argument("--http", action="store_true", help="als HTTP-Server starten statt stdio")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if args.http:
        if _SDK2:
            mcp.run(transport="streamable-http", host=args.host, port=args.port)
        else:
            mcp.settings.host = args.host
            mcp.settings.port = args.port
            mcp.run(transport="streamable-http")
    else:
        mcp.run()  # stdio für Claude Desktop
