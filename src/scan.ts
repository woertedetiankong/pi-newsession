import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/**
 * Scans each directory for `*.jsonl` directly inside it and one level down
 * (the default layout is `<root>/<encoded-cwd>/*.jsonl`; a custom sessionDir is flat).
 * Only files whose mtime or size changed are re-parsed.
 */
export class SessionScanner {
  private cache = new Map<string, { mtimeMs: number; size: number; source: SessionSource; record?: SessionRecord }>();
  constructor(private dirs: () => Promise<string[]>, private extraRoots: () => Promise<SessionRoot[]> = async () => []) {}

  async roots(): Promise<string[]> { return [...new Set((await this.dirs()).map(d => resolve(d)))]; }
  async locations(): Promise<SessionRoot[]> {
    return [...(await this.roots()).map(path => ({ source: "pi" as const, path, maxDepth: 1 })), ...(await this.extraRoots()).map(r => ({ ...r, path: resolve(r.path) }))];
  }

  async scan(): Promise<SessionRecord[]> {
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
    const out: SessionRecord[] = [], seenIds = new Set<string>();
    for (const [path, source] of paths) {
      const record = await this.load(path, source);
      if (record && !seenIds.has(record.id)) { seenIds.add(record.id); out.push(record); }
    }
    for (const key of this.cache.keys()) if (!paths.has(key)) this.cache.delete(key);
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  /** True when `path` is a session file this scanner would read (used to validate switch targets). */
  async owns(path: string): Promise<boolean> {
    const target = resolve(path);
    if (!target.endsWith(".jsonl")) return false;
    const parent = dirname(target);
    return (await this.roots()).some(root => parent === root || dirname(parent) === root);
  }

  private async load(path: string, source: SessionSource): Promise<SessionRecord | undefined> {
    let s;
    try { s = await stat(path); } catch { return undefined; }
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size && hit.source === source) return hit.record;
    let record: SessionRecord | undefined;
    try {
      record = parseSession(path, normalizeSession(await readFile(path, "utf8"), source), s.mtime);
      if (record) {
        record.nativeId = record.id; record.source = source;
        if (source !== "pi") record.id = `${source}:${record.id}`;
      }
    } catch { record = undefined; }
    this.cache.set(path, { mtimeMs: s.mtimeMs, size: s.size, source, record });
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
