import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionMeta {
  title?: string;
  /** "ai" titles may be regenerated; "manual" titles are never overwritten by AI organize. */
  titleSource?: "ai" | "manual";
  summary?: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  /** Session `modified` time when AI organize last ran, to detect sessions that changed since. */
  organizedAt?: string;
}
export type MetaPatch = Partial<Pick<SessionMeta, "title" | "pinned" | "archived" | "tags">>;

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = clip(t.replace(/^#+/, ""), 20).toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 5);
}

/** JSON file keyed by session id. Writes are serialized and atomic (write temp + rename). */
export class MetaStore {
  private data: Record<string, SessionMeta> = {};
  private loaded?: Promise<void>;
  private writing = Promise.resolve();
  constructor(readonly file: string) {}

  private load(): Promise<void> {
    return this.loaded ??= readFile(this.file, "utf8").then(raw => {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.sessions === "object") this.data = parsed.sessions;
    }, () => {});
  }
  async all(): Promise<Record<string, SessionMeta>> { await this.load(); return this.data; }
  async get(id: string): Promise<SessionMeta> { await this.load(); return this.data[id] ?? {}; }

  async patch(id: string, patch: MetaPatch): Promise<SessionMeta> {
    await this.load();
    const next: SessionMeta = { ...this.data[id] };
    if (patch.title !== undefined) {
      const title = clip(patch.title, 80);
      if (title) { next.title = title; next.titleSource = "manual"; } else { delete next.title; delete next.titleSource; }
    }
    if (patch.pinned !== undefined) next.pinned = patch.pinned || undefined;
    if (patch.archived !== undefined) next.archived = patch.archived || undefined;
    if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
    return this.put(id, next);
  }
  /** Stores AI results without overwriting a manual title. */
  async organized(id: string, result: { title: string; summary: string; tags: string[] }, modified: string): Promise<SessionMeta> {
    await this.load();
    const cur = this.data[id] ?? {};
    const next: SessionMeta = { ...cur, summary: clip(result.summary, 160), tags: cleanTags(result.tags), organizedAt: modified };
    if (cur.titleSource !== "manual") { next.title = clip(result.title, 40); next.titleSource = "ai"; }
    return this.put(id, next);
  }

  private async put(id: string, meta: SessionMeta): Promise<SessionMeta> {
    for (const k of Object.keys(meta) as (keyof SessionMeta)[]) if (meta[k] === undefined) delete meta[k];
    if (Object.keys(meta).length) this.data[id] = meta; else delete this.data[id];
    const snapshot = JSON.stringify({ version: 1, sessions: this.data }, null, 1);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.writing;
    return meta;
  }
}
