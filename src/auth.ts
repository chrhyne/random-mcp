/**
 * Anmeldung und Freigaben für random-mcp
 * =======================================
 *
 * Rollen (Hotel-Analogie):
 *   Google              = Personalausweis   → sagt, WER jemand ist (OpenID Connect)
 *   dieser Worker       = Rezeption         → entscheidet, OB jemand darf (Freigabeliste),
 *                                              stellt Claude & Co. eine Schlüsselkarte (Token) aus
 *   MCP-/REST-Endpunkte = Zimmertür         → lassen nur mit gültiger Karte/Sitzung rein
 *
 * Zwei Wege rein:
 *   1. MCP-Clients (Claude, Gemini CLI …): OAuth 2.1 über @cloudflare/workers-oauth-provider.
 *      /authorize zeigt eine Zustimmungsseite und leitet zu Google weiter, /callback prüft die
 *      Freigabeliste und stellt das Token aus.
 *   2. Browser (Demo-Seite, REST-API): /login → Google → /login/callback → signiertes Sitzungs-Cookie.
 *
 * Einstellungen (Cloudflare-Dashboard → Worker → Settings → Variables and Secrets, als „Secret“):
 *   GOOGLE_CLIENT_ID      OAuth-Client-ID aus der Google Cloud Console
 *   GOOGLE_CLIENT_SECRET  zugehöriges Secret
 *   ERLAUBTE_NUTZER       kommagetrennte E-Mail-Adressen, z. B. "stratze@gmail.com"
 * Fehlt ERLAUBTE_NUTZER, kommt niemand rein (sicherer Standard).
 */

import { authorizationErrorRedirect, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers; // vom OAuthProvider eingesetzt
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ERLAUBTE_NUTZER?: string;
}

/** Was im Token gespeichert wird und bei jedem MCP-Aufruf als ctx.props ankommt. */
export interface Nutzer {
  email: string;
  name?: string;
}

// ------------------------------------------------------------ Freigabeliste (Autorisierung)

export function freigabeliste(env: Env): string[] {
  return (env.ERLAUBTE_NUTZER ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function istErlaubt(env: Env, email: string | undefined): boolean {
  return !!email && freigabeliste(env).includes(email.toLowerCase());
}

// ------------------------------------------------------------ Hilfsfunktionen

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const zufallsText = (laenge = 32) => b64url(crypto.getRandomValues(new Uint8Array(laenge)));

async function s256(text: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** Schlüssel für Sitzungs-Cookies: wird beim ersten Mal erzeugt und in KV abgelegt. */
async function geheimerSchluessel(env: Env): Promise<string> {
  let s = await env.OAUTH_KV.get("random-mcp:sitzungsschluessel");
  if (!s) {
    s = zufallsText(48);
    await env.OAUTH_KV.put("random-mcp:sitzungsschluessel", s);
  }
  return s;
}

async function hmac(env: Env, text: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(await geheimerSchluessel(env)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

async function signiere(env: Env, daten: object) {
  const nutzlast = b64url(new TextEncoder().encode(JSON.stringify(daten)));
  return `${nutzlast}.${await hmac(env, nutzlast)}`;
}

async function pruefeSignatur<T>(env: Env, wert: string | undefined): Promise<T | null> {
  if (!wert) return null;
  const [nutzlast, sig] = wert.split(".");
  if (!nutzlast || !sig || sig !== (await hmac(env, nutzlast))) return null;
  try {
    const json = atob(nutzlast.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as T;
  } catch {
    return null;
  }
}

function cookie(request: Request, name: string): string | undefined {
  const zeile = request.headers.get("cookie") ?? "";
  for (const teil of zeile.split(/;\s*/)) {
    const [k, ...v] = teil.split("=");
    if (k === name) return v.join("=");
  }
}

function setzeCookie(name: string, wert: string, maxAge: number) {
  return `${name}=${wert}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// ------------------------------------------------------------ Google (Authentifizierung)

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

function pruefeKonfiguration(env: Env): string | null {
  const fehlt = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ERLAUBTE_NUTZER"].filter(
    (k) => !(env as unknown as Record<string, string | undefined>)[k]
  );
  return fehlt.length ? `Der Server ist noch nicht fertig eingerichtet. Es fehlen die Secrets: ${fehlt.join(", ")}` : null;
}

async function googleUrl(env: Env, redirectUri: string, state: string, verifier: string) {
  const u = new URL(GOOGLE_AUTH);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    prompt: "select_account"
  }).toString();
  return u.toString();
}

/** Google-Code gegen Nutzerdaten tauschen. */
async function googleNutzer(env: Env, code: string, redirectUri: string, verifier: string) {
  const tokenAntwort = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier
    })
  });
  if (!tokenAntwort.ok) throw new Error(`Google-Anmeldung fehlgeschlagen (${tokenAntwort.status})`);
  const { access_token } = (await tokenAntwort.json()) as { access_token: string };
  const info = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${access_token}` } });
  if (!info.ok) throw new Error(`Google-Nutzerdaten nicht lesbar (${info.status})`);
  const daten = (await info.json()) as { email?: string; email_verified?: boolean; name?: string };
  if (!daten.email || !daten.email_verified) throw new Error("Google hat keine bestätigte E-Mail-Adresse geliefert");
  return { email: daten.email.toLowerCase(), name: daten.name } satisfies Nutzer;
}

// ------------------------------------------------------------ Seiten

const STIL = `
:root{--bg:#f7f5f0;--fg:#1d1b18;--muted:#6b665d;--card:#fff;--line:#e3ded3;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ede9e1;--muted:#a39d92;--card:#201e1b;--line:#35322d;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:520px;margin:0 auto;padding:48px 16px}h1{font-size:24px;margin:0 0 12px}p{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
.btn{display:inline-block;font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;margin:4px 8px 0 0}
.btn.primaer{background:var(--accent);border-color:var(--accent);color:#fff}
.warn{color:var(--accent)}strong{color:var(--fg)}`;

export function seite(titel: string, inhalt: string, status = 200, headers?: Headers) {
  const h = headers ?? new Headers();
  h.set("content-type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(titel)}</title><style>${STIL}</style></head><body><main><div class="card">${inhalt}</div></main></body></html>`,
    { status, headers: h }
  );
}

const fehlerSeite = (text: string, status = 400) =>
  seite("random-mcp – Fehler", `<h1>Das hat nicht geklappt</h1><p>${escape(text)}</p>`, status);

// ------------------------------------------------------------ Weg 1: MCP-Clients (OAuth)

/** GET /authorize: Anfrage prüfen, Zustimmungsseite zeigen. POST /authorize: weiter zu Google. */
export async function authorize(request: Request, env: Env): Promise<Response> {
  const konfig = pruefeKonfiguration(env);
  if (konfig) return fehlerSeite(konfig, 503);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const anfrage = await oauth.parseAuthRequest(request);
      const d = await oauth.describeConsent(anfrage);
      const zustimmung = await oauth.beginConsent(anfrage);
      const herkunft = d.clientDomain
        ? `Herausgeber: <strong>${escape(d.clientDomain)}</strong>`
        : "Diese App hat sich selbst registriert; ihr Name ist nicht überprüft.";
      return seite(
        "random-mcp – Zugriff erlauben?",
        `<h1>${escape(d.clientName)} möchte random-mcp nutzen</h1>
         <p>${herkunft}<br>Der Zugang wird an <strong>${escape(d.redirectHost)}</strong> übergeben.</p>
         ${d.redirectIsLoopback ? '<p class="warn"><strong>Achtung:</strong> Der Zugang geht an ein Programm auf diesem Computer. Nur fortfahren, wenn du die Anmeldung gerade selbst dort gestartet hast.</p>' : ""}
         <p>Im nächsten Schritt meldest du dich mit Google an. Zugriff bekommen nur freigegebene Konten.</p>
         <form method="post"><input type="hidden" name="handle" value="${escape(zustimmung.handle)}">
           <button class="btn primaer" name="entscheidung" value="ja">Weiter mit Google</button>
           <button class="btn" name="entscheidung" value="nein">Ablehnen</button></form>`,
        200,
        zustimmung.headers
      );
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle"));
      if (form.get("entscheidung") !== "ja") {
        const abgelehnt = await oauth.denyConsent(request, handle);
        abgelehnt.headers.set("location", abgelehnt.redirectTo);
        return new Response(null, { status: 302, headers: abgelehnt.headers });
      }
      const ok = await oauth.approveConsent(request, handle);
      const verifier = zufallsText(48);
      const { state, headers } = await oauth.beginUpstream(ok.request, { data: { verifier }, headers: ok.headers });
      headers.set("location", await googleUrl(env, new URL("/callback", request.url).toString(), state, verifier));
      return new Response(null, { status: 302, headers });
    }
    return new Response("Methode nicht erlaubt", { status: 405 });
  } catch (e) {
    return oauthFehler(e);
  }
}

/** GET /callback: Google meldet sich zurück → Freigabeliste prüfen → Token für den Client ausstellen. */
export async function callback(request: Request, env: Env, protokoll: (m: string, d: Record<string, unknown>) => void) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const url = new URL(request.url);
    if (url.searchParams.get("error") || !url.searchParams.get("code")) {
      headers.set("location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }

    const nutzer = await googleNutzer(env, url.searchParams.get("code")!, `${url.origin}/callback`, data.verifier);

    if (!istErlaubt(env, nutzer.email)) {
      protokoll(`[auth] abgelehnt: ${nutzer.email} (mcp)`, { typ: "auth", ergebnis: "abgelehnt", email: nutzer.email });
      const zurueck = authorizationErrorRedirect(original, "access_denied", "Dieses Konto ist nicht freigegeben");
      return seite(
        "random-mcp – Kein Zugriff",
        `<h1>Kein Zugriff</h1><p>Das Konto <strong>${escape(nutzer.email)}</strong> ist für random-mcp nicht freigegeben.</p>
         <a class="btn" href="${escape(zurueck)}">Zurück zur App</a>`,
        403,
        headers
      );
    }

    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: nutzer.email,
      metadata: { name: nutzer.name ?? null },
      scope: original.scope,
      props: nutzer satisfies Nutzer
    });
    protokoll(`[auth] angemeldet: ${nutzer.email} (mcp, ${original.clientId})`, {
      typ: "auth", ergebnis: "angemeldet", email: nutzer.email, client_id: original.clientId
    });
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return oauthFehler(e);
  }
}

function oauthFehler(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError) return fehlerSeite(`${e.description} – bitte die Anmeldung in der App neu starten.`);
  if (e instanceof CimdFetchError) return fehlerSeite("Diese App konnte nicht überprüft werden.");
  if (e instanceof Error && e.message.startsWith("Google")) return fehlerSeite(e.message, 502);
  throw e;
}

// ------------------------------------------------------------ Weg 2: Browser (Demo-Seite, REST)

const SITZUNG = "__Host-random-mcp-sitzung";
const LOGIN = "__Host-random-mcp-login";
const SITZUNG_DAUER = 7 * 24 * 3600; // 7 Tage

/** Angemeldeter Browser-Nutzer – oder null. Prüft die Freigabeliste bei jedem Aufruf neu. */
export async function webNutzer(request: Request, env: Env): Promise<Nutzer | null> {
  const s = await pruefeSignatur<Nutzer & { bis: number }>(env, cookie(request, SITZUNG));
  if (!s || s.bis < Date.now() || !istErlaubt(env, s.email)) return null;
  return { email: s.email, name: s.name };
}

export async function login(request: Request, env: Env): Promise<Response> {
  const konfig = pruefeKonfiguration(env);
  if (konfig) return fehlerSeite(konfig, 503);
  const state = zufallsText();
  const verifier = zufallsText(48);
  const wert = await signiere(env, { state, verifier, bis: Date.now() + 600_000 });
  const ziel = await googleUrl(env, new URL("/login/callback", request.url).toString(), state, verifier);
  return new Response(null, {
    status: 302,
    headers: { location: ziel, "set-cookie": setzeCookie(LOGIN, wert, 600) }
  });
}

export async function loginCallback(request: Request, env: Env, protokoll: (m: string, d: Record<string, unknown>) => void) {
  const url = new URL(request.url);
  const merk = await pruefeSignatur<{ state: string; verifier: string; bis: number }>(env, cookie(request, LOGIN));
  if (!merk || merk.bis < Date.now() || merk.state !== url.searchParams.get("state"))
    return fehlerSeite("Die Anmeldung ist abgelaufen oder wurde in einem anderen Browser gestartet. Bitte noch einmal versuchen.");
  if (!url.searchParams.get("code")) return fehlerSeite("Die Anmeldung bei Google wurde abgebrochen.");

  try {
    const nutzer = await googleNutzer(env, url.searchParams.get("code")!, `${url.origin}/login/callback`, merk.verifier);
    const h = new Headers();
    h.append("set-cookie", setzeCookie(LOGIN, "", 0));
    if (!istErlaubt(env, nutzer.email)) {
      protokoll(`[auth] abgelehnt: ${nutzer.email} (web)`, { typ: "auth", ergebnis: "abgelehnt", email: nutzer.email });
      return seite("random-mcp – Kein Zugriff",
        `<h1>Kein Zugriff</h1><p>Das Konto <strong>${escape(nutzer.email)}</strong> ist für random-mcp nicht freigegeben.</p>
         <a class="btn" href="/login">Mit anderem Konto anmelden</a>`, 403, h);
    }
    h.append("set-cookie", setzeCookie(SITZUNG, await signiere(env, { ...nutzer, bis: Date.now() + SITZUNG_DAUER * 1000 }), SITZUNG_DAUER));
    h.set("location", "/");
    protokoll(`[auth] angemeldet: ${nutzer.email} (web)`, { typ: "auth", ergebnis: "angemeldet", email: nutzer.email });
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    return fehlerSeite(e instanceof Error ? e.message : String(e), 502);
  }
}

export function logout() {
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setzeCookie(SITZUNG, "", 0) } });
}

export const loginSeite = () =>
  seite("random-mcp – Anmelden",
    `<h1>random-mcp</h1><p>Echte Zufallszahlen für LLMs per MCP – und hier im Browser per REST.</p>
     <p>Zugriff nur für freigegebene Google-Konten.</p>
     <a class="btn primaer" href="/login">Mit Google anmelden</a>`);
