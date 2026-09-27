import { copyFile, mkdir, readdir, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/** Deleted sessions older than this are removed from the trash when /sessions starts. */
export const TRASH_DAYS = 30;

/**
 * Moves a session file into `<trash>/<its folder name>/`, keeping the file name so it can be
 * put back by hand. A name already in the trash gets a numbered suffix. The file's mtime is set
 * to the deletion time, which purgeTrash() counts from. Returns the new path.
 */
export async function moveToTrash(path: string, trash: string): Promise<string> {
  const dir = join(trash, basename(dirname(path)));
  await mkdir(dir, { recursive: true });
  const ext = extname(path), stem = basename(path, ext);
  let target = join(dir, stem + ext);
  for (let n = 2; await stat(target).then(() => true, () => false); n++) target = join(dir, `${stem}-${n}${ext}`);
  try { await rename(path, target); }
  catch (e) {
    // The data folder may be on another disk (e.g. a synced folder).
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(path, target);
    await rm(path);
  }
  const now = new Date();
  await utimes(target, now, now);
  return target;
}

/** Session files in the trash (`<trash>/<folder>/*.jsonl`); nothing else there is touched. */
async function trashFiles(trash: string): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  let dirs;
  try { dirs = await readdir(trash, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names: string[];
    try { names = await readdir(join(trash, d.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(trash, d.name, name), s = await stat(path).catch(() => undefined);
      if (s?.isFile()) out.push({ path, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

export async function trashCount(trash: string): Promise<number> { return (await trashFiles(trash)).length; }

/** Removes trashed sessions deleted before `olderThan` (all of them when absent). Returns how many were removed. */
export async function purgeTrash(trash: string, olderThan?: number): Promise<number> {
  let removed = 0;
  for (const f of await trashFiles(trash)) {
    if (olderThan !== undefined && f.mtimeMs >= olderThan) continue;
    try { await rm(f.path); removed++; } catch {}
  }
  // Drop folders left empty; rmdir refuses the ones that still hold something.
  try { for (const d of await readdir(trash)) await rmdir(join(trash, d)).catch(() => {}); } catch {}
  return removed;
}
