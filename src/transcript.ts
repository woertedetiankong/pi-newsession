import { readFile } from "node:fs/promises";
import { type Lang, text as t } from "./i18n.ts";

/** Where an image sits in the session file; the bytes are served separately by /api/image. */
export interface ImageRef { entry: string; n: number; mimeType: string; }
export interface ToolItem { id: string; name: string; summary: string; args: string; output?: string; isError?: boolean; images?: ImageRef[]; }
export type TranscriptItem =
  | { kind: "user"; text: string; images: ImageRef[]; time?: string }
  | { kind: "assistant"; text: string; thinking?: string; tools: ToolItem[]; error?: string; model?: string; time?: string }
  | { kind: "note"; title: string; text: string; time?: string };

const TEXT_MAX = 200_000, ARGS_MAX = 4_000, OUTPUT_MAX = 20_000;

function parts(content: unknown): { text: string; images: string[]; thinking: string; calls: any[] } {
  if (typeof content === "string") return { text: content, images: [], thinking: "", calls: [] };
  const out = { text: "", images: [] as string[], thinking: "", calls: [] as any[] };
  const texts: string[] = [], thoughts: string[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p?.type === "image") out.images.push(String(p.mimeType ?? ""));
    else if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) thoughts.push(p.thinking);
    else if (p?.type === "toolCall") out.calls.push(p);
  }
  out.text = texts.join("\n\n"); out.thinking = thoughts.join("\n\n");
  return out;
}

/** One line that says what a tool call did, e.g. the bash command or the file path. */
export function toolSummary(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const pick = ["command", "path", "file_path", "filePath", "pattern", "query", "url"].map(k => a[k]).find(v => typeof v === "string") as string | undefined;
  const first = pick ?? Object.values(a).find(v => typeof v === "string") as string | undefined;
  return (first ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || name;
}
function stringify(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

/** The entries on the active branch: from the last entry in the file back to the root, like pi does on resume. */
export function activeBranch(raw: string): any[] {
  const byId = new Map<string, any>();
  let leaf: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session" || typeof e.id !== "string") continue;
    byId.set(e.id, e); leaf = e.id;
  }
  const path: any[] = [], seen = new Set<string>();
  for (let id = leaf; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId ?? undefined) {
    seen.add(id); path.push(byId.get(id));
  }
  return path.reverse();
}

const refs = (entry: string, mimeTypes: string[]): ImageRef[] => entry ? mimeTypes.map((mimeType, n) => ({ entry, n, mimeType })) : [];

/** The n-th image of a message entry on any branch, as bytes. */
export function findImage(raw: string, entry: string, n: number): { data: Buffer; mimeType: string } | undefined {
  for (const line of raw.split("\n")) {
    if (!line.includes(entry)) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.id !== entry || !Array.isArray(e.message?.content)) continue;
    const img = e.message.content.filter((p: any) => p?.type === "image")[n];
    if (!img || typeof img.data !== "string") return undefined;
    return { data: Buffer.from(img.data, "base64"), mimeType: String(img.mimeType ?? "") };
  }
  return undefined;
}

/** `language` picks the wording of notes and markers the page shows (Chinese by default). */
export function buildTranscript(raw: string, lang: Lang = "zh"): TranscriptItem[] {
  const cut = (s: string, n: number) => s.length > n ? s.slice(0, n) + t(lang, "truncated", s.length.toLocaleString()) : s;
  const items: TranscriptItem[] = [], calls = new Map<string, ToolItem>();
  for (const e of activeBranch(raw)) {
    const time = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "compaction") { items.push({ kind: "note", title: t(lang, "compacted"), text: cut(String(e.summary ?? ""), TEXT_MAX), time }); continue; }
    if (e.type === "branch_summary") { items.push({ kind: "note", title: t(lang, "branchReturn"), text: cut(String(e.summary ?? ""), TEXT_MAX), time }); continue; }
    if (e.type === "custom_message" && e.display) { items.push({ kind: "note", title: String(e.customType ?? t(lang, "pluginMessage")), text: cut(parts(e.content).text, TEXT_MAX), time }); continue; }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") {
      const p = parts(m.content);
      if (p.text.trim() || p.images.length) items.push({ kind: "user", text: cut(p.text, TEXT_MAX), images: refs(e.id, p.images), time });
    } else if (m.role === "assistant") {
      const p = parts(m.content);
      const tools = p.calls.map(c => {
        const t: ToolItem = { id: String(c.id ?? ""), name: String(c.name ?? "tool"), summary: toolSummary(String(c.name ?? ""), c.arguments), args: cut(stringify(c.arguments), ARGS_MAX) };
        if (t.id) calls.set(t.id, t);
        return t;
      });
      const error = m.stopReason === "error" ? String(m.errorMessage ?? t(lang, "requestError")) : m.stopReason === "aborted" ? t(lang, "aborted") : undefined;
      if (p.text.trim() || tools.length || error || p.thinking) items.push({ kind: "assistant", text: cut(p.text, TEXT_MAX), thinking: p.thinking ? cut(p.thinking, TEXT_MAX) : undefined, tools, error, model: m.model, time });
    } else if (m.role === "toolResult") {
      const t = calls.get(String(m.toolCallId ?? ""));
      const p = parts(m.content), images = refs(e.id, p.images);
      if (t) { t.output = cut(p.text, OUTPUT_MAX); t.isError = !!m.isError; if (images.length) t.images = images; }
    } else if (m.role === "bashExecution") {
      const tool: ToolItem = { id: "", name: "bash", summary: `! ${String(m.command ?? "")}`.slice(0, 160), args: String(m.command ?? ""), output: cut(String(m.output ?? ""), OUTPUT_MAX), isError: typeof m.exitCode === "number" && m.exitCode !== 0 };
      items.push({ kind: "assistant", text: "", tools: [tool], time });
    } else if (m.role === "custom" && m.display) {
      items.push({ kind: "note", title: String(m.customType ?? t(lang, "pluginMessage")), text: cut(parts(m.content).text, TEXT_MAX), time });
    } else if (m.role === "branchSummary" || m.role === "compactionSummary") {
      items.push({ kind: "note", title: t(lang, m.role === "branchSummary" ? "branchReturn" : "compacted"), text: cut(String(m.summary ?? ""), TEXT_MAX), time });
    }
  }
  return items;
}

/** Index of the first item mentioning every word (case-insensitive), or -1. */
export function firstMatch(items: TranscriptItem[], words: string[]): number {
  if (!words.length) return -1;
  const textOf = (i: TranscriptItem) => (i.kind === "note" ? i.title + "\n" + i.text : i.kind === "assistant" ? [i.text, ...i.tools.map(t => t.summary)].join("\n") : i.text).toLowerCase();
  const all = words.every(w => items.some(i => textOf(i).includes(w)));
  if (!all) return -1;
  const idx = items.findIndex(i => { const t = textOf(i); return words.some(w => t.includes(w)); });
  return idx;
}

export async function readTranscript(path: string): Promise<TranscriptItem[]> { return buildTranscript(await readFile(path, "utf8")); }
