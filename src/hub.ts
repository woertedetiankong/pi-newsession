/**
 * pi-web hub: one local web server shared by several pi extensions (pi-sessions, pi-kb, ...).
 *
 * KEEP THIS FILE IDENTICAL in every package that ships it. Packages load with separate
 * module roots, so each carries its own copy; they meet through globalThis.__piWebHub and
 * only the WebHub / WebApp contract below (checked structurally, never with instanceof).
 * Change the contract only in backward-compatible ways, and bump HUB_VERSION when adding to it.
 *
 * Layout: /<app>/ serves the app's page, /api/<app>/... its API (token required),
 * /hub.js the shared client (token, language, app switcher), / redirects to the first app.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const HUB_VERSION = 1;
export const DEFAULT_PORT = 47291;

export type WebLanguage = "zh" | "en";

export interface WebRequest {
  method: string;
  /** Path below /api/<app id>, e.g. "/search". */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Aborted when the browser goes away mid-request. */
  signal: AbortSignal;
  /** JSON body (application/json, at most 64 KiB); {} when empty. */
  json(): Promise<any>;
  /** Raw body, rejected with 413 above `limit` bytes. */
  raw(limit: number): Promise<Buffer>;
}

/** Return an object of this shape from WebApp.handle to send bytes instead of JSON. */
export interface WebBinary { binary: Uint8Array; type: string; cacheSeconds?: number; filename?: string }

export interface WebApp {
  id: string;
  /** Position in the app switcher, lower first; also picks the app / redirects to. */
  order: number;
  title: Record<WebLanguage, string>;
  /** Languages the page supports; the switcher offers a toggle when there is more than one. */
  languages: WebLanguage[];
  page(): Promise<string>;
  /** Throw an error with a numeric `status` for HTTP errors. */
  handle(req: WebRequest): Promise<unknown>;
}

export interface WebHub {
  readonly version: number;
  /** Add or replace an app. Cheap; does not start the server. */
  mount(app: WebApp): void;
  /** Remove an app; when the last app leaves, the server stops and the hub is discarded. */
  unmount(id: string): Promise<void>;
  apps(): WebApp[];
  start(): Promise<void>;
  /** Page URL including the access token, once the server runs. */
  url(appId?: string): string | undefined;
  /** Stop listening; mounted apps stay registered for the next start(). */
  close(): Promise<void>;
}

/** "zh_CN.UTF-8", "zh-Hans-US", "en_US" … → a supported language; undefined for C/POSIX or others. */
export function parseLanguage(value: string | undefined): WebLanguage | undefined {
  const v = value?.trim().toLowerCase();
  if (!v || v === "c" || v.startsWith("c.") || v === "posix") return undefined;
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("en")) return "en";
  return undefined;
}

let detected: WebLanguage | undefined;
/**
 * The OS interface language, for terminal messages: LC_ALL, LC_MESSAGES, LANG, then (macOS keeps
 * it outside the environment and terminals often export LANG=C.UTF-8) AppleLanguages, then Intl.
 */
export function systemLanguage(): WebLanguage {
  if (detected) return detected;
  const apple = () => {
    if (process.platform !== "darwin") return undefined;
    try {
      const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 });
      return parseLanguage(/"?([A-Za-z-]+)"?/.exec(out.replace(/^\s*\(\s*/, ""))?.[1]) ?? "en";
    } catch { return undefined; }
  };
  return detected = parseLanguage(process.env.LC_ALL) ?? parseLanguage(process.env.LC_MESSAGES) ?? parseLanguage(process.env.LANG)
    ?? apple() ?? parseLanguage(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
}

export function webError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export interface HubOptions {
  /** pi's agent directory; the token lives in <agentDir>/pi-web/token. */
  agentDir: string;
  /** Fixed token (tests). */
  token?: string;
  port?: number;
}

const shared = globalThis as typeof globalThis & { __piWebHub?: WebHub };

/** The process-wide hub, created on first use. */
export function sharedHub(agentDir: string): WebHub {
  const existing = shared.__piWebHub;
  if (existing && typeof existing.mount === "function" && existing.version >= 1) return existing;
  const hub = new Hub({ agentDir }, () => { if (shared.__piWebHub === hub) shared.__piWebHub = undefined; });
  shared.__piWebHub = hub;
  return hub;
}

/** A private hub, for tests. */
export function createHub(options: HubOptions): WebHub {
  return new Hub(options);
}

function loadToken(agentDir: string): string {
  const dir = join(agentDir, "pi-web"), file = join(dir, "token");
  const valid = (path: string) => { try { const t = readFileSync(path, "utf8").trim(); return /^[a-f0-9]{32,}$/.test(t) ? t : undefined; } catch { return undefined; } };
  const found = valid(file);
  if (found) return found;
  mkdirSync(dir, { recursive: true });
  // Keep links that pi-sessions handed out before the hub existed working.
  const legacy = join(agentDir, "pi-sessions", "token");
  if (!existsSync(file) && valid(legacy)) { copyFileSync(legacy, file); return valid(file)!; }
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

const isBinary = (value: unknown): value is WebBinary =>
  !!value && typeof value === "object" && (value as WebBinary).binary instanceof Uint8Array && typeof (value as WebBinary).type === "string";

class Hub implements WebHub {
  readonly version = HUB_VERSION;
  private readonly registry = new Map<string, WebApp>();
  private server?: Server;
  private port = 0;
  private token?: string;
  private readonly options: HubOptions;
  private readonly onDiscard?: () => void;

  constructor(options: HubOptions, onDiscard?: () => void) {
    this.options = options;
    this.onDiscard = onDiscard;
    this.token = options.token;
  }

  mount(app: WebApp): void { this.registry.set(app.id, app); }

  async unmount(id: string): Promise<void> {
    this.registry.delete(id);
    if (this.registry.size) return;
    await this.close();
    this.onDiscard?.();
  }

  apps(): WebApp[] { return [...this.registry.values()].sort((a, b) => a.order - b.order); }

  url(appId?: string): string | undefined {
    if (!this.server) return undefined;
    const id = appId ?? this.apps()[0]?.id ?? "";
    return `http://127.0.0.1:${this.port}/${id ? `${id}/` : ""}#token=${this.token}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token ??= loadToken(this.options.agentDir);
    const server = createServer((req, res) => { void this.handle(req, res); });
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    try { await listen(this.options.port ?? DEFAULT_PORT); } catch { await listen(0); }
    // Never keep pi alive just for the page.
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Reject DNS-rebinding style requests: only our own loopback host is accepted.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw webError(403, "forbidden host");
      const url = new URL(req.url ?? "/", `http://${host}`);
      const [, first = "", ...rest] = url.pathname.split("/");
      const method = req.method ?? "GET";

      if (first !== "api") {
        if (method !== "GET") throw webError(405, "method not allowed");
        if (first === "hub.js") return send(res, 200, CLIENT_JS, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        const app = first ? this.registry.get(first) : this.apps()[0];
        if (!app) throw webError(404, "not found");
        if (!first || rest.length === 0) return redirect(res, `/${app.id}/`);
        if (rest.join("/") !== "") throw webError(404, "not found");
        return send(res, 200, await app.page(), {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
        });
      }

      if (req.headers["x-token"] !== this.token) throw webError(401, "invalid token / 令牌无效，请在 pi 中重新打开页面");
      const [appId = "", ...sub] = rest;
      if (appId === "hub" && sub.join("/") === "apps" && method === "GET") {
        return sendJson(req, res, { version: this.version, apps: this.apps().map(a => ({ id: a.id, title: a.title, languages: a.languages })) });
      }
      const app = this.registry.get(appId);
      if (!app) throw webError(404, "not found");
      const aborter = new AbortController();
      res.on("close", () => { if (!res.writableFinished) aborter.abort(); });
      const data = await app.handle({
        method, path: `/${sub.join("/")}`, query: url.searchParams, headers: req.headers, signal: aborter.signal,
        json: () => readJson(req), raw: limit => readBody(req, limit),
      });
      if (isBinary(data)) {
        const headers: Record<string, string | number> = {
          "content-type": data.type, "content-length": data.binary.length, "x-content-type-options": "nosniff",
          "cache-control": data.cacheSeconds ? `private, max-age=${data.cacheSeconds}` : "no-store",
        };
        if (data.filename) headers["content-disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(data.filename)}`;
        res.writeHead(200, headers);
        res.end(data.binary);
        return;
      }
      sendJson(req, res, data);
    } catch (e) {
      const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
      if (!res.headersSent) send(res, status, JSON.stringify({ error: (e as Error).message }), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      else res.destroy();
    }
  }
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string>): void {
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

/** GET answers carry an ETag so polling pages get 304 when nothing changed. */
function sendJson(req: IncomingMessage, res: ServerResponse, data: unknown): void {
  const text = JSON.stringify(data ?? null);
  if (req.method === "GET") {
    const etag = `"${createHash("sha1").update(text).digest("base64url")}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-store" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", etag });
  } else {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  }
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(webError(413, "request too large / 请求太大")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw webError(415, "JSON required / 需要 JSON");
  const body = await readBody(req, 64 * 1024);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { throw webError(400, "invalid JSON / JSON 格式错误"); }
}

/**
 * Shared page client, loaded by every app page before its own script as <script src="/hub.js">.
 * window.piWeb = { token, lang, app, setLang(lang) }; ?lang=zh|en in the URL sets the language.
 * Renders the app switcher into #pi-web-nav
 * and sets class "pi-web-multi" on <html> when more than one app is mounted.
 */
const CLIENT_JS = String.raw`(() => {
  const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let token = "";
  const m = location.hash.match(/token=([a-f0-9]+)/);
  if (m) { token = m[1]; write("pi-web-token", token); history.replaceState(null, "", location.pathname + location.search); }
  else token = read("pi-web-token") || read("pi-sessions-token") || "";
  // ?lang=zh|en in a link picks (and remembers) the language.
  const asked = new URLSearchParams(location.search).get("lang");
  if (asked === "zh" || asked === "en") write("pi-web-lang", asked);
  const saved = read("pi-web-lang");
  const lang = saved === "zh" || saved === "en" ? saved : (/^zh/i.test(navigator.language || "") ? "zh" : "en");
  const app = location.pathname.split("/")[1] || "";
  const setLang = l => { write("pi-web-lang", l); location.reload(); };
  window.piWeb = { token, lang, app, setLang };
  const css = "#pi-web-nav{display:flex;align-items:center;gap:2px}" +
    "#pi-web-nav a,#pi-web-nav button{padding:4px 10px;border-radius:8px;color:var(--muted,#666);text-decoration:none;font:inherit;font-weight:500;background:none;border:0;cursor:pointer;white-space:nowrap}" +
    "#pi-web-nav a:hover,#pi-web-nav button:hover{color:var(--text,#111)}" +
    "#pi-web-nav a[aria-current]{background:var(--accent-soft,#e8ecff);color:var(--accent-text,#2a3fc2)}" +
    "#pi-web-nav .pw-lang{margin-left:6px;font-size:12px;border:1px solid var(--line,#ddd)}";
  const render = async () => {
    const nav = document.getElementById("pi-web-nav");
    if (!nav) return;
    let apps = [];
    try { const r = await fetch("/api/hub/apps", { headers: { "x-token": token } }); if (r.ok) apps = (await r.json()).apps || []; } catch {}
    const current = apps.find(a => a.id === app);
    // Pages can hide their own title when the switcher already names them.
    document.documentElement.classList.toggle("pi-web-multi", apps.length > 1);
    const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    let html = apps.length > 1 ? apps.map(a => '<a href="/' + esc(a.id) + '/"' + (a.id === app ? ' aria-current="page"' : "") + ">" + esc(a.title[lang] || a.title.en || a.id) + "</a>").join("") : "";
    if (current && current.languages.length > 1) html += '<button class="pw-lang" title="Language / 语言">' + (lang === "zh" ? "EN" : "中文") + "</button>";
    nav.innerHTML = html;
    const btn = nav.querySelector(".pw-lang");
    if (btn) btn.addEventListener("click", () => setLang(lang === "zh" ? "en" : "zh"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render); else render();
})();`;
