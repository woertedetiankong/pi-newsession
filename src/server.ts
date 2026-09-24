import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { SessionScanner, searchSnippet, type SessionRecord } from "./scan.ts";
import { MetaStore, type MetaPatch } from "./meta.ts";
import { Organizer, organizeOne, type ModelContext } from "./organize.ts";
import { askSessions } from "./ask.ts";

/** What the server needs from the live pi runtime; replaced on every session_start. */
export interface Binding {
  currentSessionFile(): string | undefined;
  model(): ModelContext | undefined;
  open(path: string): Promise<{ ok: boolean; message: string }>;
  rename(path: string, title: string): Promise<void>;
}
export interface ServerOptions {
  /** Default session root; extra custom session dirs come from the meta store. */
  root: string; metaFile: string; webFile: string; token: string; port?: number; }

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class SessionsServer {
  binding?: Binding;
  readonly scanner: SessionScanner;
  readonly meta: MetaStore;
  readonly organizer: Organizer;
  private server?: Server;
  private port = 0;
  private records: SessionRecord[] = [];

  constructor(private opts: ServerOptions) {
    this.meta = new MetaStore(opts.metaFile);
    this.scanner = new SessionScanner(async () => [opts.root, ...(await this.meta.sessionDirs())]);
    this.organizer = new Organizer((id, signal) => this.organize(id, signal));
  }

  get url(): string | undefined { return this.server ? `http://127.0.0.1:${this.port}/#token=${this.opts.token}` : undefined; }

  async start(): Promise<string> {
    if (this.server) return this.url!;
    const server = createServer((req, res) => { void this.handle(req, res); });
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    try { await listen(this.opts.port ?? 0); } catch { await listen(0); }
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.url!;
  }
  async close(): Promise<void> {
    this.organizer.cancel();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }

  private async refresh(): Promise<SessionRecord[]> { return this.records = await this.scanner.scan(); }
  private async find(id: unknown): Promise<SessionRecord> {
    if (typeof id !== "string") throw new HttpError(400, "缺少会话 id");
    const hit = this.records.find(r => r.id === id) ?? (await this.refresh()).find(r => r.id === id);
    if (!hit) throw new HttpError(404, "找不到这个会话，可能已被删除");
    return hit;
  }

  private async organize(id: string, signal: AbortSignal): Promise<void> {
    const ctx = this.binding?.model();
    if (!ctx) throw new Error("pi 正在切换会话，请稍后重试");
    const record = await this.find(id), all = await this.meta.all();
    const tags = [...new Set(Object.values(all).flatMap(m => m.tags ?? []))];
    const result = await organizeOne(ctx, record, tags, signal);
    await this.meta.organized(id, result, record.modified);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Reject DNS-rebinding style requests: only our own loopback host is accepted.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(403, "forbidden host");
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(this.opts.webFile, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
      if (req.headers["x-token"] !== this.opts.token) throw new HttpError(401, "令牌无效，请在 pi 中重新运行 /sessions");
      const body = req.method === "POST" ? await readJson(req) : {};
      // Cancel model work when the page goes away mid-request.
      const aborter = new AbortController();
      res.on("close", () => { if (!res.writableFinished) aborter.abort(); });
      json(res, 200, await this.route(req.method ?? "GET", url, body, aborter.signal));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: (e as Error).message });
    }
  }

  private async route(method: string, url: URL, body: any, signal: AbortSignal): Promise<unknown> {
    const p = url.pathname;
    if (method === "GET" && p === "/api/sessions") {
      const [records, meta] = await Promise.all([this.refresh(), this.meta.all()]);
      return {
        current: this.binding?.currentSessionFile(),
        model: this.binding?.model()?.model?.id,
        connected: !!this.binding,
        organize: this.organizer.status,
        sessions: records.map(r => ({
          id: r.id, path: r.path, cwd: r.cwd, name: r.name, model: r.model, parent: r.parent,
          created: r.created, modified: r.modified, count: r.count, firstUser: r.firstUser, meta: meta[r.id] ?? {},
        })),
      };
    }
    if (method === "GET" && p === "/api/session") {
      const r = await this.find(url.searchParams.get("id"));
      return { id: r.id, messages: r.messages };
    }
    if (method === "GET" && p === "/api/search") {
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!this.records.length) await this.refresh();
      const hits: { id: string; snippet: string }[] = [];
      for (const r of this.records) { const snippet = searchSnippet(r, words); if (snippet !== undefined) hits.push({ id: r.id, snippet }); }
      return { hits };
    }
    if (method === "POST" && p === "/api/meta") {
      const r = await this.find(body.id), patch: MetaPatch = {};
      if (typeof body.title === "string") patch.title = body.title;
      if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
      if (typeof body.archived === "boolean") patch.archived = body.archived;
      if (Array.isArray(body.tags)) patch.tags = body.tags;
      const meta = await this.meta.patch(r.id, patch);
      let warning: string | undefined;
      if (patch.title && this.binding) {
        try { await this.binding.rename(r.path, meta.title!); } catch (e) { warning = "标题已保存，但写回会话文件失败：" + (e as Error).message; }
      }
      return { meta, warning };
    }
    if (method === "POST" && p === "/api/open") {
      const r = await this.find(body.id);
      if (!this.binding) throw new HttpError(503, "pi 正在切换会话，请稍后重试");
      return this.binding.open(r.path);
    }
    if (method === "POST" && p === "/api/organize") {
      if (!this.binding?.model()?.model) throw new HttpError(409, "pi 当前没有选择模型");
      const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 500) : [];
      this.organizer.enqueue(ids);
      return { organize: this.organizer.status };
    }
    if (method === "POST" && p === "/api/ask") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) throw new HttpError(400, "请先输入要找的内容");
      const ctx = this.binding?.model();
      if (!ctx?.model) throw new HttpError(409, this.binding ? "pi 当前没有选择模型" : "pi 正在切换会话，请稍后重试");
      const [records, meta] = await Promise.all([this.refresh(), this.meta.all()]);
      return { ...(await askSessions(ctx, query, records, meta, signal)), model: ctx.model.id };
    }
    if (method === "POST" && p === "/api/organize/cancel") { this.organizer.cancel(); return { organize: this.organizer.status }; }
    throw new HttpError(404, "not found");
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function readJson(req: IncomingMessage): Promise<any> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return Promise.reject(new HttpError(415, "需要 JSON"));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64 * 1024) { reject(new HttpError(413, "请求太大")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new HttpError(400, "JSON 格式错误")); } });
    req.on("error", reject);
  });
}
