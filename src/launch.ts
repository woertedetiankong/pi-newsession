import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { SessionRecord } from "./scan.ts";
import type { Lang } from "./i18n.ts";

const exec = promisify(execFile);
export const sourceName = (source: string | undefined) => source === "claude" ? "Claude Code" : source === "codex" ? "Codex" : "pi";
export const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
export function resumeArgs(record: SessionRecord): { command: string; args: string[] } {
  const source = record.source ?? "pi", id = record.nativeId ?? record.id;
  if (source !== "pi" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid stored session ID");
  if (source === "claude") return { command: "claude", args: ["--resume", id] };
  if (source === "codex") return { command: "codex", args: ["resume", id] };
  return { command: "pi", args: ["--session", record.path] };
}
export function resumeCommand(record: SessionRecord, executable?: string, platform = process.platform): string {
  const { command, args } = resumeArgs(record);
  if (platform === "win32") {
    const quote = (v: string) => "'" + v.replace(/'/g, "''") + "'";
    return `Set-Location -LiteralPath ${quote(record.cwd)}; & ${[executable ?? command, ...args].map(quote).join(" ")}`;
  }
  return `cd -- ${shellQuote(record.cwd)} && ${[executable ?? command, ...args].map(shellQuote).join(" ")}`;
}
async function executable(command: string): Promise<string | undefined> {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(p => p && isAbsolute(p))) {
    for (const suffix of suffixes) {
      const path = join(dir, command + suffix);
      if (await stat(path).then(s => s.isFile(), () => false) && await access(path, constants.X_OK).then(() => true, () => false)) return path;
    }
  }
  return undefined;
}
/** Launches only after a user clicks Open. The original runtime's permissions and
 * configuration apply; no prompt is submitted and no permissions are bypassed. */
export async function launchSession(record: SessionRecord, lang: Lang): Promise<{ ok: boolean; message: string; command: string }> {
  const command = resumeCommand(record), name = sourceName(record.source);
  const fail = (zh: string, en: string) => ({ ok: false, command, message: lang === "zh" ? zh : en });
  if (!isAbsolute(record.cwd) || !(await stat(record.cwd).catch(() => undefined))?.isDirectory())
    return fail("项目目录不存在。请复制恢复命令，修改目录后运行。", "The project folder is missing. Copy the resume command and change its directory.");
  const plan = resumeArgs(record), binary = await executable(plan.command);
  if (!binary) return fail(`找不到 ${name} 命令。请安装后复制恢复命令运行。`, `${name} is not on PATH. Install it and run the copied resume command.`);
  try {
    if (process.platform === "darwin") {
      await exec("osascript", ["-e", 'on run argv\n tell application "Terminal"\n activate\n do script (item 1 of argv)\n end tell\nend run', resumeCommand(record, binary)], { timeout: 15_000 });
    } else if (process.platform === "linux") {
      const terminal = await executable("x-terminal-emulator");
      if (!terminal) return fail("没有可用的终端启动器。请复制恢复命令运行。", "No terminal launcher is available. Run the copied resume command.");
      // Do not await an interactive terminal's lifetime.
      const child = execFile(terminal, ["-e", binary, ...plan.args], { cwd: record.cwd }, () => {}); child.unref();
    } else {
      return fail("请复制恢复命令，在终端中运行。", "Copy the resume command and run it in your terminal.");
    }
    return { ok: true, command, message: lang === "zh" ? `已在新终端打开 ${name}` : `Opened ${name} in a new terminal` };
  } catch {
    return fail("无法自动打开终端。请复制恢复命令运行。", "Could not open a terminal. Run the copied resume command.");
  }
}
