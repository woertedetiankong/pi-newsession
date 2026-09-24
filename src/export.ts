import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "./scan.ts";
import { type Lang, text } from "./i18n.ts";

export interface SessionImage { data: Buffer; mimeType: string; role: string; }
export interface ExportResult { dir: string; sessions: number; images: number; written: number; folder?: string; }

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif", "image/svg+xml": "svg" };

/** Every image in the file, all branches, in the order they were written. */
/** `role` names who sent the image in `lang`, for file names such as 001-用户.png / 001-user.png. */
export function sessionImages(raw: string, lang: Lang = "zh"): SessionImage[] {
  const role = (r: string) => r === "user" ? text(lang, "roleUser") : r === "toolResult" ? text(lang, "roleTool") : text(lang, "roleAssistant");
  const out: SessionImage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"image"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "message" || !Array.isArray(e.message?.content)) continue;
    for (const p of e.message.content) {
      if (p?.type === "image" && typeof p.data === "string") out.push({ data: Buffer.from(p.data, "base64"), mimeType: String(p.mimeType ?? ""), role: role(e.message.role) });
    }
  }
  return out;
}

/** "2026-09-23_修复滚动_abcd1234": readable, sortable, and safe on macOS, Windows and Linux. */
export function folderName(record: Pick<SessionRecord, "id" | "created">, title: string): string {
  const d = new Date(record.created), pad = (n: number) => String(n).padStart(2, "0");
  const date = Number.isNaN(d.getTime()) ? "unknown" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).replace(/[. ]+$/, "");
  return [date, safe, record.id.slice(0, 8)].filter(Boolean).join("_");
}

/**
 * Writes each session's images to <dir>/<folder>/001-用户.png …
 * A session keeps its folder after a rename (matched by id), and files already there with the same size are skipped,
 * so exporting again only adds what is new.
 */
export async function exportImages(sessions: { record: SessionRecord; title: string }[], dir: string, lang: Lang = "zh"): Promise<ExportResult> {
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir).catch(() => [] as string[]);
  const result: ExportResult = { dir, sessions: 0, images: 0, written: 0 };
  for (const { record, title } of sessions) {
    const images = sessionImages(await readFile(record.path, "utf8"), lang);
    if (!images.length) continue;
    const folder = join(dir, existing.find(n => n.endsWith("_" + record.id.slice(0, 8))) ?? folderName(record, title));
    await mkdir(folder, { recursive: true });
    result.sessions++; result.folder = folder;
    const present = await readdir(folder).catch(() => [] as string[]);
    for (const [i, img] of images.entries()) {
      const n = String(i + 1).padStart(3, "0");
      const file = join(folder, `${n}-${img.role}.${EXT[img.mimeType] ?? "bin"}`);
      result.images++;
      // Match by number and size, not name: an export in the other language must not duplicate it.
      const same = await Promise.all(present.filter(f => f.startsWith(n + "-")).map(f => stat(join(folder, f)).then(s => s.size, () => -1)));
      if (same.includes(img.data.length)) continue;
      await writeFile(file, img.data);
      result.written++;
    }
  }
  if (result.sessions !== 1) delete result.folder;
  return result;
}
