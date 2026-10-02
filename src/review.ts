// A session as a review: one task per question the user asked, with what the AI changed (the edit tool's own patches),
// the commands it ran and whether its checks passed, and, when pi-lab was in use, its debug ledger and flashes.
// Built from the session file alone: no git, no model.

import { isAbsolute, relative } from "node:path";
import { activeBranch } from "./transcript.ts";

export interface ReviewFile {
  path: string;
  /** Unified patches in the order they were made; a whole-file write is one "+" patch. */
  patches: string[];
  added: number;
  removed: number;
  /** Written with the write tool (created or replaced) rather than edited. */
  written: boolean;
  /** Outside the session's project directory: an SDK, a toolchain, a system file. */
  outside: boolean;
}

export type CommandKind = "test" | "build" | "flash" | "serial" | "git" | "install" | "run";

export interface ReviewCommand {
  kind: CommandKind;
  tool: string;
  command: string;
  ok: boolean;
  /** The last lines of its output. */
  tail: string;
}

export interface ReviewLedger {
  target?: string;
  facts: { id: string; text: string; evidence?: string; verified?: boolean }[];
  hypotheses: { id: string; text: string; status: string; evidence?: string }[];
}

export interface ReviewTask {
  n: number;
  prompt: string;
  time?: string;
  end?: string;
  /** The AI's last words in this task. */
  reply: string;
  files: ReviewFile[];
  commands: ReviewCommand[];
  /** Tests, builds, flashes and board reads: how many passed and failed. */
  checks: { passed: number; failed: number };
  toolCalls: number;
  toolErrors: number;
  /** pi-lab's debug ledger as it stood at the end of the task. */
  ledger?: ReviewLedger;
  flashes: { at: number; source: string }[];
}

const KINDS: [CommandKind, RegExp][] = [
  ["flash", /\bidf\.py\b[^\n]*\b(?:flash|app-flash)\b|\besptool[^\n]*write[-_]flash|\b(?:pio|platformio)\b[^\n]*upload|\bwest\s+flash|\bopenocd\b[^\n]*\bprogram\b|\bprobe-rs\s+(?:download|run)|\bst-flash\b|\bnrfjprog\b[^\n]*--program|\bmake\b[^\n]*\bflash\b/],
  ["serial", /\bidf\.py\b[^\n]*\bmonitor\b|\bserial_capture\b|\bminiterm\b|\bpicocom\b|\bminicom\b|\bserial\.Serial\b/],
  ["test", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\b(?:jest|vitest|mocha)\b|\bmake\s+(?:test|check)\b|\bctest\b|\bidf\.py\b[^\n]*\bpytest\b/],
  ["build", /\bidf\.py\b[^\n]*\bbuild\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|check|typecheck)\b|\btsc\b|\bcmake\s+--build\b|\bcargo\s+(?:build|check)\b|\bgo\s+build\b|\b(?:pio|platformio)\s+run\b|\bninja\b|\bmake\b(?!\s+(?:test|check|flash))|\bgcc\b|\bclang\b/],
  ["git", /\bgit\s+(?:commit|push|merge|rebase|checkout|reset|apply|stash|tag)\b/],
  ["install", /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/],
];

export function commandKind(tool: string, command: string): CommandKind {
  if (tool === "board_flash") return "flash";
  if (tool === "board_serial") return "serial";
  for (const [kind, pattern] of KINDS) if (pattern.test(command)) return kind;
  return "run";
}

const CHECKS = new Set<CommandKind>(["test", "build", "flash", "serial"]);

// A check can fail with exit code 0: `npm test | head` exits with head's status. Read the output too.
const FAILED: Partial<Record<CommandKind, RegExp>> = {
  test: /^ℹ fail [1-9]|^# fail [1-9]|^not ok \d+|^\s*✖ |Tests?:.*\b[1-9]\d* failed|\b[1-9]\d* (?:failed|failing)\b|^FAIL\b|test result: FAILED|^--- FAIL/m,
  build: /\berror(?:\[\w+\])?:|ninja: build stopped|^FAILED:|Build failed|BUILD FAILED|make: \*\*\*/m,
  flash: /A fatal error occurred|Failed to connect|Flashing failed|Upload failed/,
};

/** Whether a command did what it was for: its tool said so, and its output shows no failure. */
export function commandOk(kind: CommandKind, isError: boolean, output: string): boolean {
  return !isError && !FAILED[kind]?.test(output);
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n") : "";

const tailOf = (text: string, lines = 4) => text.trimEnd().split("\n").slice(-lines).join("\n").slice(-600);

/** "+3 −1" for a unified patch: lines added and removed, headers left out. */
export function patchStats(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** A patch for an edit without one recorded: each replaced text as removed and added lines. */
function editPatch(args: any): string {
  const edits: any[] = Array.isArray(args?.edits) ? args.edits : args?.oldText !== undefined ? [args] : [];
  return edits.map(e => {
    const minus = String(e.oldText ?? "").split("\n").map(l => `-${l}`);
    const plus = String(e.newText ?? "").split("\n").map(l => `+${l}`);
    return ["@@", ...minus, ...plus].join("\n");
  }).join("\n");
}

const MAX_WRITE_LINES = 400;

export function buildReview(raw: string): { cwd?: string; tasks: ReviewTask[] } {
  let cwd: string | undefined;
  for (const line of raw.split("\n", 3)) {
    try { const e = JSON.parse(line); if (e.type === "session") { cwd = e.cwd; break; } } catch {}
  }
  const rel = (path: string) => (cwd && isAbsolute(path) && !relative(cwd, path).startsWith("..") ? relative(cwd, path) : path);
  const outside = (path: string) => !!cwd && isAbsolute(path) && relative(cwd, path).startsWith("..");

  const tasks: ReviewTask[] = [];
  let task: ReviewTask | undefined;
  let files = new Map<string, ReviewFile>();
  const calls = new Map<string, { name: string; args: any }>();

  const finish = () => {
    if (!task) return;
    task.files = [...files.values()];
    tasks.push(task);
  };

  for (const e of activeBranch(raw)) {
    const time = typeof e.timestamp === "string" ? e.timestamp : undefined;
    // The next question starts a new task: it is not the end of this one.
    const asks = e.type === "message" && e.message?.role === "user" && !!textOf(e.message.content).trim();
    if (task && time && !asks) task.end = time;
    if (e.type === "custom" && task) {
      if (e.customType === "pi-lab.ledger" && e.data) task.ledger = e.data as ReviewLedger;
      if (e.customType === "pi-lab.flash" && e.data) task.flashes.push({ at: Number(e.data.at) || 0, source: String(e.data.source ?? "") });
      continue;
    }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") {
      const prompt = textOf(m.content).trim();
      if (!prompt) continue;
      finish();
      files = new Map();
      task = {
        n: tasks.length + 1, prompt, time, end: time, reply: "", files: [], commands: [], checks: { passed: 0, failed: 0 },
        toolCalls: 0, toolErrors: 0, flashes: [],
      };
      continue;
    }
    if (!task) continue;
    if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) task.reply = text;
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type !== "toolCall") continue;
        task.toolCalls++;
        calls.set(String(p.id ?? ""), { name: String(p.name ?? ""), args: p.arguments ?? {} });
      }
      continue;
    }
    if (m.role === "toolResult") {
      const call = calls.get(String(m.toolCallId ?? ""));
      const name = call?.name ?? String(m.toolName ?? "");
      const args = call?.args ?? {};
      const ok = !m.isError;
      if (!ok) task.toolErrors++;
      if ((name === "edit" || name === "write") && ok && typeof args.path === "string") {
        const path = rel(args.path);
        const file = files.get(path) ?? { path, patches: [], added: 0, removed: 0, written: false, outside: outside(args.path) };
        let patch: string;
        if (name === "edit") patch = typeof m.details?.patch === "string" && m.details.patch ? m.details.patch : editPatch(args);
        else {
          const lines = String(args.content ?? "").split("\n");
          patch = [`@@ ${path} (${lines.length} lines written)`, ...lines.slice(0, MAX_WRITE_LINES).map(l => `+${l}`), ...(lines.length > MAX_WRITE_LINES ? [`… ${lines.length - MAX_WRITE_LINES} more lines`] : [])].join("\n");
          file.written = true;
        }
        const stats = patchStats(patch);
        file.patches.push(patch);
        file.added += stats.added;
        file.removed += stats.removed;
        files.set(path, file);
        continue;
      }
      const isCommand = name === "bash" || name === "board_flash" || name === "board_serial";
      if (isCommand) {
        const command = name === "bash" ? String(args.command ?? "") : `${name} ${Object.keys(args).length ? JSON.stringify(args) : ""}`.trim();
        const kind = commandKind(name, command), output = textOf(m.content);
        const worked = commandOk(kind, !ok, output);
        task.commands.push({ kind, tool: name, command, ok: worked, tail: tailOf(output) });
        if (CHECKS.has(kind)) worked ? task.checks.passed++ : task.checks.failed++;
      }
      continue;
    }
    if (m.role === "bashExecution") {
      // A command the user ran with "!" in pi.
      const command = String(m.command ?? "");
      const kind = commandKind("bash", command), output = String(m.output ?? "");
      const ok = commandOk(kind, typeof m.exitCode === "number" && m.exitCode !== 0, output);
      task.commands.push({ kind, tool: "user", command, ok, tail: tailOf(output) });
    }
  }
  finish();
  return { cwd, tasks };
}
