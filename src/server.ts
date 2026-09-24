import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { SessionScanner, searchSnippet, type SessionRecord } from "./scan.ts";
import { MetaStore, type MetaPatch } from "./meta.ts";
import { Organizer, organizeOne, type ModelContext } from "./organize.ts";
import { askSessions } from "./ask.ts";
import { checkWritable, expandDir, openPath, type DataLocation } from "./storage.ts";
import { buildTranscript, firstMatch, type TranscriptItem } from "./transcript.ts";

/** What the server needs from the live pi runtime; replaced on every session_start. */
export interface Binding {
  currentSessionFile(): string | undefined;
  /** Directory pi writes new sessions to. */
  sessionDir?(): string | undefined;
  model(): ModelContext | undefined;
  open(path: string): Promise<{ ok: boolean; message: string }>;
  rename(path: string, title: string): Promise<void>;
}
export interface ServerOptions {
  /** Default session root; extra custom session dirs come from the meta store. */
  root: string; metaFile: string; webFile: string; token: string; port?: number;
  /** Lets the page move meta.json; without it the data dir is fixed at metaFile. */
  location?: DataLocation;
  /** pi's settings.json, shown in the "how to move sessions" hint. */
  settingsFile?: string; }

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class SessionsServer {
  binding?: Binding;
  readonly scanner: SessionScanner;
  meta: MetaStore;
  readonly organizer: Organizer;
  private server?: Server;
  private port = 0;
  private records: SessionRecord[] = [];
  /** Recently opened transcripts, keyed by path; re-parsed when the file changes. */
  private transcripts = new Map<string, { version: string; items: TranscriptItem[] }>();
  /** Model picked on the page for each queued organize job ("provider/id"); absent means follow pi. */
  private organizeModels = new Map<string, string>();

  constructor(private opts: ServerOptions) {
    this.meta = new MetaStore(opts.metaFile);
    this.scanner = new SessionScanner(async () => [opts.root, ...(await (await this.currentMeta()).sessionDirs())]);
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

  /** Follows a data dir change made on the page, in this or another pi window. */
  async currentMeta(): Promise<MetaStore> {
    const loc = this.opts.location;
    if (!loc) return this.meta;
    const file = join((await loc.resolve()).dir, "meta.json");
    if (resolve(file) !== resolve(this.meta.file)) this.meta = new MetaStore(file);
    return this.meta;
  }

  private async storage() {
    const meta = await this.currentMeta(), records = this.records.length ? this.records : await this.refresh();
    const current = this.binding?.sessionDir?.(), inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
    const dirs = await Promise.all([this.opts.root, ...(await meta.sessionDirs())].map(async (dir, i) => ({
      path: dir, isDefault: i === 0,
      exists: !!(await stat(dir).catch(() => undefined))?.isDirectory(),
      current: !!current && inside(resolve(current), resolve(dir)),
      count: records.filter(r => inside(r.path, dir)).length,
    })));
    const data = this.opts.location ? await this.opts.location.resolve() : { dir: dirname(meta.file), source: "default" as const };
    return {
      sessions: { dirs, settingsFile: this.opts.settingsFile },
      data: { ...data, defaultDir: this.opts.location?.defaultDir ?? data.dir, movable: !!this.opts.location },
    };
  }

  /** Points meta.json at a new folder, merging what is there with the data in use now. */
  private async moveData(input: string | undefined): Promise<void> {
    const loc = this.opts.location;
    if (!loc) throw new HttpError(409, "这个位置不能在页面上修改");
    const now = await loc.resolve();
    if (now.source === "env") throw new HttpError(409, "位置由环境变量 PI_SESSIONS_DATA_DIR 指定，请先去掉它再在这里修改");
    let target: string;
    try { target = input ? expandDir(input) : loc.defaultDir; } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (resolve(target) === resolve(now.dir)) return;
    // Results written during the move would land in the old file.
    if (this.organizer.status.running) throw new HttpError(409, "正在 AI 整理，完成或取消后再移动");
    try { await checkWritable(target); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const from = await this.currentMeta(), to = new MetaStore(join(target, "meta.json"));
    await to.mergeFrom(from);
    await loc.set(target);
    this.meta = to;
  }

  private async refresh(): Promise<SessionRecord[]> { return this.records = await this.scanner.scan(); }
  private async find(id: unknown): Promise<SessionRecord> {
    if (typeof id !== "string") throw new HttpError(400, "缺少会话 id");
    const hit = this.records.find(r => r.id === id) ?? (await this.refresh()).find(r => r.id === id);
    if (!hit) throw new HttpError(404, "找不到这个会话，可能已被删除");
    return hit;
  }

  private async transcript(path: string): Promise<TranscriptItem[]> {
    const s = await stat(path), version = `${s.mtimeMs}:${s.size}`, hit = this.transcripts.get(path);
    if (hit?.version === version) return hit.items;
    const items = buildTranscript(await readFile(path, "utf8"));
    this.transcripts.delete(path); this.transcripts.set(path, { version, items });
    while (this.transcripts.size > 5) this.transcripts.delete(this.transcripts.keys().next().value!);
    return items;
  }

  private async organize(id: string, signal: AbortSignal): Promise<void> {
    const ctx = this.binding?.model();
    if (!ctx) throw new Error("pi 正在切换会话，请稍后重试");
    const key = this.organizeModels.get(id);
    const model = key ? pickModel(ctx, key) : ctx.model;
    if (!model) throw new Error("pi 当前没有选择模型");
    const meta = await this.currentMeta(), record = await this.find(id), all = await meta.all();
    const tags = [...new Set(Object.values(all).flatMap(m => m.tags ?? []))];
    const result = await organizeOne({ model, modelRegistry: ctx.modelRegistry }, record, tags, signal);
    await meta.organized(id, result, record.modified);
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
      const data = await this.route(req.method ?? "GET", url, body, aborter.signal);
      if (req.method === "GET") {
        // The page polls; answer 304 when nothing changed so it neither re-downloads nor re-renders.
        const text = JSON.stringify(data), etag = `"${createHash("sha1").update(text).digest("base64url")}"`;
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-store" }); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", etag });
        res.end(text);
        return;
      }
      json(res, 200, data);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: (e as Error).message });
    }
  }

  private async route(method: string, url: URL, body: any, signal: AbortSignal): Promise<unknown> {
    const p = url.pathname;
    await this.currentMeta();
    if (method === "GET" && p === "/api/sessions") {
      const [records, meta] = await Promise.all([this.refresh(), this.meta.all()]);
      return {
        current: this.binding?.currentSessionFile(),
        home: homedir(),
        model: this.binding?.model()?.model?.id,
        connected: !!this.binding,
        organize: this.organizer.status,
        sessions: records.map(r => ({
          id: r.id, path: r.path, cwd: r.cwd, name: r.name, model: r.model, parent: r.parent,
          created: r.created, modified: r.modified, count: r.count, firstUser: r.firstUser, meta: meta[r.id] ?? {},
        })),
      };
    }
    if (method === "GET" && p === "/api/transcript") {
      const r = await this.find(url.searchParams.get("id"));
      const items = await this.transcript(r.path).catch(() => { throw new HttpError(404, "读取会话文件失败，可能已被删除"); });
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      return { id: r.id, total: items.length, offset, items: items.slice(offset, offset + limit), firstMatch: offset === 0 ? firstMatch(items, words) : undefined };
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
      const ctx = this.binding?.model();
      if (!ctx) throw new HttpError(503, "pi 正在切换会话，请稍后重试");
      const key = typeof body.model === "string" && body.model ? body.model : undefined;
      // Check the pick now so a bad model fails here instead of on every queued session.
      if (!(key ? pickModel(ctx, key) : ctx.model)) throw new HttpError(409, "pi 当前没有选择模型");
      const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 500) : [];
      if (!this.organizer.status.running) this.organizeModels.clear();
      for (const id of ids) if (key) this.organizeModels.set(id, key); else this.organizeModels.delete(id);
      this.organizer.enqueue(ids);
      return { organize: this.organizer.status };
    }
    if (method === "POST" && p === "/api/ask") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) throw new HttpError(400, "请先输入要找的内容");
      const ctx = this.binding?.model();
      if (!ctx) throw new HttpError(503, "pi 正在切换会话，请稍后重试");
      // An explicit "provider/id" picked on the page; otherwise follow pi's current model.
      const model = typeof body.model === "string" && body.model ? pickModel(ctx, body.model) : ctx.model;
      if (!model) throw new HttpError(409, "pi 当前没有选择模型");
      const [records, meta] = await Promise.all([this.refresh(), this.meta.all()]);
      return { ...(await askSessions({ model, modelRegistry: ctx.modelRegistry }, query, records, meta, signal)), model: model.id };
    }
    if (method === "GET" && p === "/api/models") {
      const ctx = this.binding?.model();
      // No list while pi is switching sessions, so the page keeps the user's pick.
      if (!ctx) return {};
      return { models: ctx.modelRegistry.getAvailable().map(m => ({ key: modelKey(m), name: m.name || m.id, provider: m.provider })) };
    }
    if (method === "GET" && p === "/api/storage") return this.storage();
    if (method === "POST" && p === "/api/storage/open") {
      // Only folders the page lists, never an arbitrary path from the request.
      const { sessions, data } = await this.storage();
      const allowed = [...sessions.dirs.filter(d => d.exists).map(d => d.path), data.dir];
      if (typeof body.path !== "string" || !allowed.includes(body.path)) throw new HttpError(400, "不能打开这个位置");
      openPath(body.path);
      return { ok: true };
    }
    if (method === "POST" && p === "/api/storage/data") {
      await this.moveData(typeof body.dir === "string" && body.dir.trim() ? body.dir : undefined);
      return this.storage();
    }
    if (method === "POST" && p === "/api/organize/cancel") { this.organizer.cancel(); return { organize: this.organizer.status }; }
    throw new HttpError(404, "not found");
  }
}

const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
/** Model ids may contain "/" (e.g. openrouter), provider names do not. */
function pickModel(ctx: ModelContext, key: string) {
  const slash = key.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1)) : undefined;
  if (!model) throw new HttpError(400, "找不到所选模型，可能已从 pi 中移除");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new HttpError(409, `${model.id} 还没有配置登录或 API Key`);
  return model;
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
