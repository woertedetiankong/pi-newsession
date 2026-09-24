import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Message { role: "user" | "assistant"; text: string; }
export interface SessionRecord {
  id: string; path: string; cwd: string; name?: string; model?: string; parent?: string;
  created: string; modified: string; count: number; firstUser: string;
  /** First few messages, truncated, for the preview pane. */
  messages: Message[];
  /** Lower-cased conversation text for full-text search (capped). */
  text: string;
}

const PREVIEW_MESSAGES = 10, PREVIEW_CHARS = 1200, TEXT_CAP = 400_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => p && p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
}

/** Parse one pi session file (JSONL). Returns undefined for files without a session header. */
export function parseSession(path: string, raw: string, mtime: Date): SessionRecord | undefined {
  let header: any, name: string | undefined, model: string | undefined, last: string | undefined, count = 0, firstUser = "";
  const messages: Message[] = [], chunks: string[] = [];
  let size = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!header) { if (e.type !== "session") return undefined; header = e; }
    if (typeof e.timestamp === "string") last = e.timestamp;
    if (e.type === "session_info") name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : undefined;
    else if (e.type === "model_change" && typeof e.modelId === "string") model = e.modelId;
    else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      count++;
      const role = e.message.role as Message["role"], text = textOf(e.message.content).trim();
      if (!text) continue;
      if (role === "user" && !firstUser) firstUser = text.split("\n")[0].slice(0, 200);
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
    created, modified, count, firstUser, messages,
    text: [name ?? "", ...chunks].join("\n").slice(0, TEXT_CAP).toLowerCase(),
  };
}

/** Scans `<root>/<project>/*.jsonl`, re-parsing only files whose mtime or size changed. */
export class SessionScanner {
  private cache = new Map<string, { mtimeMs: number; size: number; record?: SessionRecord }>();
  constructor(readonly root: string) {}

  async scan(): Promise<SessionRecord[]> {
    let dirs: string[];
    try { dirs = await readdir(this.root); } catch { return []; }
    const seen = new Set<string>(), out: SessionRecord[] = [];
    for (const dir of dirs) {
      let files: string[];
      try { files = (await readdir(join(this.root, dir))).filter(f => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const path = join(this.root, dir, f);
        seen.add(path);
        const record = await this.load(path);
        if (record) out.push(record);
      }
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  private async load(path: string): Promise<SessionRecord | undefined> {
    let s;
    try { s = await stat(path); } catch { return undefined; }
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.record;
    let record: SessionRecord | undefined;
    try { record = parseSession(path, await readFile(path, "utf8"), s.mtime); } catch { record = undefined; }
    this.cache.set(path, { mtimeMs: s.mtimeMs, size: s.size, record });
    return record;
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
