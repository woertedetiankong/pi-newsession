/** Convert local Claude Code/Codex logs into the event shape used by our readers.
 * This is an in-memory view: source files are never rewritten. */
export type SessionSource = "pi" | "claude" | "codex";
export interface SessionRoot { source: SessionSource; path: string; maxDepth: number; }

function entries(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    try { const e = JSON.parse(line); if (e && typeof e === "object" && !Array.isArray(e)) out.push(e); } catch {}
  }
  return out;
}
const textOf = (v: any): string => typeof v === "string" ? v : Array.isArray(v)
  ? v.filter(p => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text").map(p => String(p.text ?? "")).join("\n") : "";

function image(p: any): any | undefined {
  if (p?.type === "image" && p.source?.type === "base64" && typeof p.source.data === "string")
    return { type: "image", mimeType: p.source.media_type, data: p.source.data };
  if (p?.type === "input_image" || p?.type === "image_url") {
    const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
    const match = typeof url === "string" && url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (match) return { type: "image", mimeType: match[1], data: match[2] };
  }
  return undefined;
}
function content(v: any): any[] {
  if (typeof v === "string") return [{ type: "text", text: v }];
  return (Array.isArray(v) ? v : []).flatMap(p => {
    if (["text", "input_text", "output_text"].includes(p?.type)) return [{ type: "text", text: String(p.text ?? "") }];
    if (p?.type === "thinking") return [{ type: "thinking", thinking: String(p.thinking ?? "") }];
    const img = image(p);
    return img ? [img] : [];
  });
}
function argsOf(v: any): any {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return { input: v }; } }
  return v && typeof v === "object" ? v : {};
}
/** Common tool names/arguments make command and edit review work across sources. */
function tool(name: string, input: any): { name: string; arguments: any } {
  const a = argsOf(input), short = name.split(".").at(-1);
  if (short === "Bash" || short === "exec_command" || short === "shell_command" || short === "shell") {
    const command = a.command ?? a.cmd ?? "";
    return { name: "bash", arguments: { ...a, command: Array.isArray(command) ? command.join(" ") : command } };
  }
  if (short === "Edit" || short === "MultiEdit") return { name: "edit", arguments: {
    path: a.file_path, oldText: a.old_string, newText: a.new_string,
    ...(Array.isArray(a.edits) ? { edits: a.edits.map((e: any) => ({ oldText: e.old_string, newText: e.new_string })) } : {}),
  } };
  if (short === "Write") return { name: "write", arguments: { path: a.file_path, content: a.content } };
  if (short === "apply_patch") return { name: "apply_patch", arguments: { patch: typeof input === "string" ? input : a.patch ?? a.input ?? "" } };
  return { name, arguments: a };
}
function output(v: any): { content: any[]; isError: boolean } {
  let data = v;
  if (typeof v === "string") { try { data = JSON.parse(v); } catch {} }
  if (data && typeof data === "object" && !Array.isArray(data) && ("output" in data || "exit_code" in data))
    return { content: content(data.output ?? ""), isError: typeof data.exit_code === "number" && data.exit_code !== 0 };
  const text = typeof v === "string" ? v : textOf(v);
  return { content: content(v), isError: /(?:Process exited with code|Exit code:)\s*[1-9]\d*/i.test(text) };
}

class View {
  private rows: any[];
  private leaf: string | null = null;
  constructor(id: string, cwd: string, timestamp?: string, parent?: string) {
    this.rows = [{ type: "session", id, cwd, timestamp, parentSession: parent }];
  }
  add(e: any, timestamp?: string, key?: string): void {
    const id = key ?? `view-${this.rows.length}`;
    this.rows.push({ ...e, id, parentId: this.leaf, timestamp }); this.leaf = id;
  }
  message(message: any, timestamp?: string, key?: string): void { this.add({ type: "message", message }, timestamp, key); }
  raw(): string { return this.rows.map(e => JSON.stringify(e)).join("\n") + "\n"; }
}

/** Main branch only; sidechains/subagents are not silently merged into the conversation. */
function claudeBranch(all: any[], sessionId: string): any[] {
  const main = all.filter(e => !e.isSidechain && (!e.sessionId || e.sessionId === sessionId));
  const byId = new Map(main.filter(e => typeof e.uuid === "string").map(e => [e.uuid, e]));
  const leaf = main.findLast(e => typeof e.uuid === "string");
  if (!leaf) return main;
  const branch = new Set<string>(); let e = leaf;
  while (e && !branch.has(e.uuid)) { branch.add(e.uuid); e = byId.get(e.parentUuid); }
  return main.filter(e => !e.uuid || branch.has(e.uuid));
}

function claude(all: any[]): string {
  const first = all.find(e => (e.type === "user" || e.type === "assistant") && !e.isSidechain && typeof e.sessionId === "string");
  if (!first) return "";
  const branch = claudeBranch(all, first.sessionId);
  const view = new View(first.sessionId, String(first.cwd ?? ""), first.timestamp);
  const title = all.findLast(e => e.sessionId === first.sessionId && (e.type === "custom-title" || e.type === "ai-title"));
  for (const e of branch) {
    const m = e.message;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      view.add({ type: "compaction", summary: textOf(m?.content) || "" }, e.timestamp); continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || !m) continue;
    if (e.isCompactSummary) {
      view.add({ type: "compaction", summary: textOf(m.content) }, e.timestamp); continue;
    }
    if (e.isMeta) continue;
    if (e.type === "assistant") {
      if (typeof m.model === "string") view.add({ type: "model_change", modelId: m.model }, e.timestamp);
      const parts = content(m.content);
      for (const p of Array.isArray(m.content) ? m.content : []) if (p?.type === "tool_use")
        parts.push({ type: "toolCall", id: p.id, ...tool(String(p.name ?? "tool"), p.input) });
      view.message({ role: "assistant", content: parts, model: m.model }, e.timestamp, e.uuid);
    } else {
      for (const [n, p] of (Array.isArray(m.content) ? m.content : []).entries()) if (p?.type === "tool_result")
        view.message({ role: "toolResult", toolCallId: p.tool_use_id, content: content(p.content), isError: !!p.is_error }, e.timestamp, `${e.uuid}:result:${n}`);
      const parts = content(m.content);
      if (parts.length) view.message({ role: "user", content: parts }, e.timestamp, e.uuid);
    }
  }
  if (title) view.add({ type: "session_info", name: title.customTitle ?? title.aiTitle });
  return view.raw();
}

function codex(all: any[]): string {
  const header = all.find(e => e.type === "session_meta")?.payload;
  if (!header || typeof header.id !== "string") return "";
  const view = new View(header.id, String(header.cwd ?? ""), header.timestamp, header.forked_from_id);
  // event_msg mirrors response_item; using both would duplicate questions/replies.
  const hasMessages = all.some(e => e.type === "response_item" && e.payload?.type === "message" && ["user", "assistant"].includes(e.payload.role));
  for (const [n, e] of all.entries()) {
    const p = e.payload;
    const key = `codex-${e.ordinal ?? n}`;
    if (e.type === "turn_context" && typeof p?.model === "string") view.add({ type: "model_change", modelId: p.model }, e.timestamp);
    if (e.type === "compacted") { view.add({ type: "compaction", summary: String(p?.message ?? "") }, e.timestamp); continue; }
    if (!hasMessages && e.type === "event_msg" && ["user_message", "agent_message"].includes(p?.type))
      view.message({ role: p.type === "user_message" ? "user" : "assistant", content: content(p.message) }, e.timestamp, key);
    if (e.type !== "response_item" || !p) continue;
    if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
      const parts = content(p.content), text = textOf(p.content);
      if (p.role === "user" && /^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<external_codex_apps_open_page>)/.test(text.trim()))
        view.add({ type: "custom_message", display: true, customType: "Context", content: parts }, e.timestamp, key);
      else view.message({ role: p.role, content: parts }, e.timestamp, key);
    }
    else if (p.type === "reasoning") {
      const thinking = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => String(s.text ?? "")).join("\n");
      if (thinking) view.message({ role: "assistant", content: [{ type: "thinking", thinking }] }, e.timestamp, key);
    } else if (p.type === "function_call" || p.type === "custom_tool_call")
      view.message({ role: "assistant", content: [{ type: "toolCall", id: p.call_id, ...tool(String(p.name ?? "tool"), p.arguments ?? p.input) }] }, e.timestamp, key);
    else if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
      view.message({ role: "toolResult", toolCallId: p.call_id, ...output(p.output) }, e.timestamp, key);
  }
  return view.raw();
}

export function normalizeSession(raw: string, source: SessionSource = "pi"): string {
  return source === "pi" ? raw : source === "claude" ? claude(entries(raw)) : codex(entries(raw));
}
