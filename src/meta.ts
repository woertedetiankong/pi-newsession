import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
interface MetaFile { sessions: Record<string, SessionMeta>; sessionDirs: string[]; }

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

const LOCK_STALE_MS = 10_000, LOCK_WAIT_MS = 5_000;

/**
 * JSON file keyed by session id, shared by every pi process on the machine.
 * Each write takes a lock file, re-reads the latest file and changes only one entry,
 * so two pi windows never overwrite each other's changes.
 */
export class MetaStore {
  private data: MetaFile = { sessions: {}, sessionDirs: [] };
  /** mtime and size of the file as last read, to notice writes by other pi processes. */
  private version = "";
  private queue = Promise.resolve();
  constructor(readonly file: string) {}

  /** Reloads when another process changed the file since the last read. */
  private async load(): Promise<MetaFile> {
    let version: string;
    try { const s = await stat(this.file); version = `${s.mtimeMs}:${s.size}`; } catch { this.version = ""; this.data = { sessions: {}, sessionDirs: [] }; return this.data; }
    if (version === this.version) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.data = {
        sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
        sessionDirs: Array.isArray(parsed?.sessionDirs) ? parsed.sessionDirs.filter((d: unknown) => typeof d === "string") : [],
      };
      this.version = version;
    } catch {
      // A half-written or corrupt file: keep the last good copy rather than dropping everything.
    }
    return this.data;
  }
  async all(): Promise<Record<string, SessionMeta>> { return (await this.load()).sessions; }
  async get(id: string): Promise<SessionMeta> { return (await this.load()).sessions[id] ?? {}; }
  async sessionDirs(): Promise<string[]> { return (await this.load()).sessionDirs; }

  async patch(id: string, patch: MetaPatch): Promise<SessionMeta> {
    return this.update(id, cur => {
      const next: SessionMeta = { ...cur };
      if (patch.title !== undefined) {
        const title = clip(patch.title, 80);
        if (title) { next.title = title; next.titleSource = "manual"; } else { delete next.title; delete next.titleSource; }
      }
      if (patch.pinned !== undefined) next.pinned = patch.pinned || undefined;
      if (patch.archived !== undefined) next.archived = patch.archived || undefined;
      if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
      return next;
    });
  }
  /** Stores AI results without overwriting a manual title. */
  async organized(id: string, result: { title: string; summary: string; tags: string[] }, modified: string): Promise<SessionMeta> {
    return this.update(id, cur => {
      const next: SessionMeta = { ...cur, summary: clip(result.summary, 160), tags: cleanTags(result.tags), organizedAt: modified };
      if (cur.titleSource !== "manual") { next.title = clip(result.title, 40); next.titleSource = "ai"; }
      return next;
    });
  }
  /** Remembers a session directory outside the default location (custom sessionDir). */
  async addSessionDir(dir: string): Promise<void> {
    if ((await this.load()).sessionDirs.includes(dir)) return;
    await this.write(data => { if (!data.sessionDirs.includes(dir)) data.sessionDirs.push(dir); });
  }

  /** Brings another store's data in when the data dir moves; the incoming entry wins for a session both have. */
  async mergeFrom(other: MetaStore): Promise<void> {
    const [sessions, dirs] = [await other.all(), await other.sessionDirs()];
    await this.write(data => {
      Object.assign(data.sessions, sessions);
      for (const d of dirs) if (!data.sessionDirs.includes(d)) data.sessionDirs.push(d);
    });
  }

  private async update(id: string, change: (cur: SessionMeta) => SessionMeta): Promise<SessionMeta> {
    let result: SessionMeta = {};
    await this.write(data => {
      const next = change(data.sessions[id] ?? {});
      for (const k of Object.keys(next) as (keyof SessionMeta)[]) if (next[k] === undefined) delete next[k];
      if (Object.keys(next).length) data.sessions[id] = next; else delete data.sessions[id];
      result = next;
    });
    return result;
  }

  /** Serialized within this process, locked across processes, always applied to the latest file. */
  private write(change: (data: MetaFile) => void): Promise<void> {
    const run = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const release = await lock(this.file + ".lock");
      try {
        this.version = "";
        const data = await this.load();
        change(data);
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 1, sessions: data.sessions, sessionDirs: data.sessionDirs }, null, 1), { mode: 0o600 });
        await renameRetry(tmp, this.file);
        const s = await stat(this.file);
        this.version = `${s.mtimeMs}:${s.size}`;
      } finally { await release(); }
    });
    this.queue = run;
    return run;
  }
}

/** Windows refuses to replace a file another process is reading (EPERM/EBUSY); retry briefly. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await rm(from, { force: true }); throw e; }
      await delay(25);
    }
  }
}

async function lock(path: string): Promise<() => Promise<void>> {
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A crashed process may leave the lock behind.
      const age = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) { await rm(path, { force: true }); continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error("会话管理数据正被另一个 pi 占用，请稍后重试");
      await delay(15 + Math.random() * 20);
    }
  }
}
