import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { normalizeSession, type SessionRoot, type SessionSource } from "./adapters.ts";

export interface Message { role: "user" | "assistant"; text: string; }
export interface SessionRecord {
  id: string; path: string; cwd: string; name?: string; model?: string; parent?: string;
  source?: SessionSource; nativeId?: string;
  created: string; modified: string; count: number; firstUser: string;
  /** Images in any message on any branch (what "export images" writes). */
  images: number;
  /** First few messages, truncated, for the preview pane. */
  messages: Message[];
  /** Lower-cased conversation text for full-text search (capped). */
  text: string;
}

export async function readSession(record: SessionRecord): Promise<string> {
  return normalizeSession(await readFile(record.path, "utf8"), record.source);
}

const PREVIEW_MESSAGES = 10, PREVIEW_CHARS = 1200, TEXT_CAP = 100_000;
const SCAN_CACHE_VERSION = 1;
const SCAN_CONCURRENCY = 16;
const CODEX_CONTEXT_RE = /^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<external_codex_apps_open_page>)/;
const DATA_IMAGE_RE = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+$/;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

function codexTextOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const p of v) {
    if (p && (p.type === "text" || p.type === "input_text" || p.type === "output_text")) parts.push(String(p.text ?? ""));
  }
  return parts.join("\n");
}

function codexImageCount(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  let n = 0;
  for (const p of v) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "image" && p.source?.type === "base64" && typeof p.source.data === "string") { n++; continue; }
    if (p.type === "input_image" || p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (typeof url === "string" && DATA_IMAGE_RE.test(url)) n++;
    }
  }
  return n;
}

/**
 * Fast streaming Codex scanner: reads line-by-line and skips JSON.parse on huge tool calls/outputs
 * unless they contain inline images, avoiding multi-hundred-MB double parse + stringify.
 */
async function parseCodexFile(path: string, mtime: Date): Promise<SessionRecord | undefined> {
  let header: { id: string; cwd?: unknown; timestamp?: unknown; forked_from_id?: unknown } | undefined;
  let model: string | undefined, last: string | undefined;
  let count = 0, images = 0, firstUser = "", size = 0;
  let hasMessages = false;
  const messages: Message[] = [], chunks: string[] = [];
  const fallbackEvents: { role: Message["role"]; content: unknown }[] = [];

  const pushMessage = (role: Message["role"], content: unknown): void => {
    count++;
    images += codexImageCount(content);
    const text = codexTextOf(content).trim();
    if (!text) return;
    if (role === "user" && !firstUser) firstUser = displayLine(text);
    if (messages.length < PREVIEW_MESSAGES) messages.push({ role, text: text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text });
    if (size < TEXT_CAP) { chunks.push(text); size += text.length; }
  };

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const head = line.length > 200 ? line.slice(0, 200) : line;
      const tsMatch = TIMESTAMP_RE.exec(head);
      if (tsMatch) last = tsMatch[1];

      const isMeta = !header && line.includes('"session_meta"');
      const isTurn = line.includes('"turn_context"');
      const isResp = line.includes('"response_item"') && (line.includes('"message"') || line.includes("data:image/"));
      const isEvt = !hasMessages && line.includes('"event_msg"') && (line.includes('"user_message"') || line.includes('"agent_message"'));
      if (!isMeta && !isTurn && !isResp && !isEvt) continue;

      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== "object" || Array.isArray(e)) continue;
      if (typeof e.timestamp === "string") last = e.timestamp;
      const p = e.payload;
      if (e.type === "session_meta" && !header && p && typeof p.id === "string") {
        header = p;
      } else if (e.type === "turn_context" && typeof p?.model === "string") {
        model = p.model;
      } else if (e.type === "response_item" && p) {
        if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
          hasMessages = true;
          fallbackEvents.length = 0;
          const text = codexTextOf(p.content);
          if (p.role === "user" && CODEX_CONTEXT_RE.test(text.trim())) {
            images += codexImageCount(p.content);
          } else {
            pushMessage(p.role, p.content);
          }
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          let data = p.output;
          if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
          const outContent = data && typeof data === "object" && !Array.isArray(data) && "output" in data ? data.output : p.output;
          images += codexImageCount(outContent);
        }
      } else if (!hasMessages && e.type === "event_msg" && (p?.type === "user_message" || p?.type === "agent_message")) {
        fallbackEvents.push({ role: p.type === "user_message" ? "user" : "assistant", content: p.message });
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header) return undefined;
  if (!hasMessages) {
    for (const ev of fallbackEvents) pushMessage(ev.role, ev.content);
  }
  const created = typeof header.timestamp === "string" ? header.timestamp : mtime.toISOString();
  const lastTime = last ? Date.parse(last) : NaN;
  const modified = new Date(Math.max(Number.isNaN(lastTime) ? 0 : lastTime, Date.parse(created) || 0) || mtime.getTime()).toISOString();
  return {
    id: header.id, path, cwd: typeof header.cwd === "string" ? header.cwd : "", model,
    parent: typeof header.forked_from_id === "string" ? header.forked_from_id : undefined,
    created, modified, count, images, firstUser, messages,
    text: ["", ...chunks].join("\n").slice(0, TEXT_CAP).toLowerCase(),
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => p && p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
}

/**
 * First line of a user message for display. Skill invocations arrive as
 * `<skill name="x" ...>…</skill>` followed by the user's own words, if any.
 */
export function displayLine(text: string): string {
  const skill = text.match(/^<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/);
  if (skill) {
    const rest = text.slice(skill[0].length).trim();
    return (rest ? `[${skill[1]}] ${rest.split("\n")[0]}` : `[${skill[1]}]`).slice(0, 200);
  }
  return text.split("\n")[0].slice(0, 200);
}

/** Parse one pi session file (JSONL). Returns undefined for files without a session header. */
export function parseSession(path: string, raw: string, mtime: Date): SessionRecord | undefined {
  let header: any, name: string | undefined, model: string | undefined, last: string | undefined, count = 0, images = 0, firstUser = "";
  const messages: Message[] = [], chunks: string[] = [];
  let size = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!header) { if (e.type !== "session") return undefined; header = e; }
    if (typeof e.timestamp === "string") last = e.timestamp;
    if (e.type === "message" && Array.isArray(e.message?.content)) for (const p of e.message.content) if (p?.type === "image") images++;
    if (e.type === "session_info") name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : undefined;
    else if (e.type === "model_change" && typeof e.modelId === "string") model = e.modelId;
    else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      count++;
      const role = e.message.role as Message["role"], text = textOf(e.message.content).trim();
      if (!text) continue;
      if (role === "user" && !firstUser) firstUser = displayLine(text);
      if (messages.length < PREVIEW_MESSAGES) messages.push({ role, text: text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text });
      if (size < TEXT_CAP) { chunks.push(text); size += text.length; }
    }
  }
  if (!header || typeof header.id !== "string") return undefined;
  const created = typeof header.timestamp === "string" ? header.timestamp : mtime.toISOString();
  const lastTime = last ? Date.parse(last) : NaN;
  const modified = new Date(Math.max(Number.isNaN(lastTime) ? 0 : lastTime, Date.parse(created) || 0) || mtime.getTime()).toISOString();
  return {
    id: header.id, path, cwd: typeof header.cwd === "string" ? header.cwd : "", name, model,
    parent: typeof header.parentSession === "string" ? header.parentSession : undefined,
    created, modified, count, images, firstUser, messages,
    text: [name ?? "", ...chunks].join("\n").slice(0, TEXT_CAP).toLowerCase(),
  };
}

interface CacheEntry { mtimeMs: number; size: number; source: SessionSource; record?: SessionRecord; }

/**
 * Scans each directory for `*.jsonl` directly inside it and one level down
 * (the default layout is `<root>/<encoded-cwd>/*.jsonl`; a custom sessionDir is flat).
 * Only files whose mtime or size changed are re-parsed, and results can be persisted to disk.
 */
export class SessionScanner {
  private cache = new Map<string, CacheEntry>();
  private cacheLoaded = false;
  private pendingScan?: Promise<SessionRecord[]>;
  private saveQueue: Promise<void> = Promise.resolve();
  private saveTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private dirs: () => Promise<string[]>,
    private extraRoots: () => Promise<SessionRoot[]> = async () => [],
    private cacheFile?: string,
  ) {}

  async roots(): Promise<string[]> { return [...new Set((await this.dirs()).map(d => resolve(d)))]; }
  async locations(): Promise<SessionRoot[]> {
    return [...(await this.roots()).map(path => ({ source: "pi" as const, path, maxDepth: 1 })), ...(await this.extraRoots()).map(r => ({ ...r, path: resolve(r.path) }))];
  }

  async scan(): Promise<SessionRecord[]> {
    return this.pendingScan ??= this.doScan().finally(() => { this.pendingScan = undefined; });
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    if (!this.cacheFile) return;
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (parsed?.version !== SCAN_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") return;
      for (const [k, v] of Object.entries(parsed.entries)) {
        const e = v as Partial<CacheEntry>;
        if (typeof e?.mtimeMs === "number" && typeof e.size === "number" && (e.source === "pi" || e.source === "claude" || e.source === "codex")) {
          this.cache.set(k, { mtimeMs: e.mtimeMs, size: e.size, source: e.source, record: e.record });
        }
      }
    } catch {}
  }

  private persistCache(): Promise<void> {
    const file = this.cacheFile;
    if (!file) return Promise.resolve();
    const payload = JSON.stringify({ version: SCAN_CACHE_VERSION, entries: Object.fromEntries(this.cache) });
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await rename(tmp, file);
    }).catch(() => {});
    return this.saveQueue;
  }

  private schedulePersist(immediate: boolean): Promise<void> {
    if (!this.cacheFile) return Promise.resolve();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (immediate) return this.persistCache();
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.persistCache(); }, 15_000);
    this.saveTimer.unref?.();
    return Promise.resolve();
  }

  private async doScan(): Promise<SessionRecord[]> {
    await this.ensureCacheLoaded();
    const paths = new Map<string, SessionSource>();
    const walk = async (root: string, source: SessionSource, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        // Do not follow symlinks or Claude subagent trees into unrelated conversations.
        if (e.isFile() && e.name.endsWith(".jsonl")) paths.set(join(root, e.name), source);
        else if (e.isDirectory() && depth > 0) await walk(join(root, e.name), source, depth - 1);
      }
    };
    for (const root of await this.locations()) await walk(root.path, root.source, root.maxDepth);

    const items = [...paths.entries()];
    const loaded = new Array<SessionRecord | undefined>(items.length);
    let changedCount = 0, cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const i = cursor++;
        const [path, source] = items[i];
        const res = await this.load(path, source);
        loaded[i] = res.record;
        if (res.changed) changedCount++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));

    const out: SessionRecord[] = [], seenIds = new Set<string>();
    for (const record of loaded) {
      if (record && !seenIds.has(record.id)) { seenIds.add(record.id); out.push(record); }
    }
    for (const key of this.cache.keys()) if (!paths.has(key)) { this.cache.delete(key); changedCount++; }
    if (changedCount > 0 && this.cacheFile) await this.schedulePersist(changedCount >= 5);
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  /** True when `path` is a session file this scanner would read (used to validate switch targets). */
  async owns(path: string): Promise<boolean> {
    const target = resolve(path);
    if (!target.endsWith(".jsonl")) return false;
    const parent = dirname(target);
    return (await this.roots()).some(root => parent === root || dirname(parent) === root);
  }

  private async load(path: string, source: SessionSource): Promise<{ record?: SessionRecord; changed: boolean }> {
    let s;
    try { s = await stat(path); } catch { return { record: undefined, changed: false }; }
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size && hit.source === source) return { record: hit.record, changed: false };
    let record: SessionRecord | undefined;
    try {
      record = source === "codex"
        ? await parseCodexFile(path, s.mtime)
        : parseSession(path, normalizeSession(await readFile(path, "utf8"), source), s.mtime);
      if (record) {
        record.nativeId = record.id; record.source = source;
        if (source !== "pi") record.id = `${source}:${record.id}`;
      }
    } catch { record = undefined; }
    this.cache.set(path, { mtimeMs: s.mtimeMs, size: s.size, source, record });
    return { record, changed: true };
  }
}

/** Finds a snippet around the earliest hit of any word, or undefined when not every word matches. */
export function searchSnippet(record: SessionRecord, words: string[], width = 90): string | undefined {
  if (!words.length || !words.every(w => record.text.includes(w))) return undefined;
  for (const m of record.messages) {
    const low = m.text.toLowerCase();
    const i = Math.min(...words.map(w => { const k = low.indexOf(w); return k < 0 ? Infinity : k; }));
    if (i !== Infinity) return excerpt(m.text, i, width);
  }
  const i = Math.min(...words.map(w => record.text.indexOf(w)));
  return excerpt(record.text, i, width);
}
function excerpt(text: string, i: number, width: number): string {
  const a = Math.max(0, i - 24);
  return (a ? "…" : "") + text.slice(a, a + width).replace(/\s+/g, " ") + (a + width < text.length ? "…" : "");
}
