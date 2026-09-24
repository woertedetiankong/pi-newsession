import { execFile } from "node:child_process";

/**
 * Brings the terminal running this pi process to the front after a session switch,
 * so the user does not have to click back from the browser.
 *
 * macOS: iTerm2 / Terminal.app are matched by tty and the exact tab is selected;
 * other terminals are activated as an app. Windows (experimental, untested): the
 * hosting window is raised, not a specific Windows Terminal tab. Linux: no-op.
 * Every step is best effort; failures never affect the switch itself.
 */

export type FocusStep =
  | { kind: "tmux"; pane: string }
  | { kind: "iterm"; tty: string }
  | { kind: "terminal-app"; tty: string }
  | { kind: "open-bundle"; bundleId: string }
  | { kind: "open-app"; path: string }
  | { kind: "windows"; pid: number };

export interface FocusEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pid: number;
  /** Controlling tty of pi (or of the tmux client), e.g. "/dev/ttys004". */
  tty?: string;
  /** Executable paths of ancestor processes, nearest first (macOS fallback). */
  ancestors?: string[];
}

const BUNDLES: Record<string, string> = {
  "iTerm.app": "com.googlecode.iterm2",
  Apple_Terminal: "com.apple.Terminal",
  ghostty: "com.mitchellh.ghostty",
  WezTerm: "com.github.wez.wezterm",
  WarpTerminal: "dev.warp.Warp-Stable",
  vscode: "com.microsoft.VSCode",
  Tabby: "org.tabby",
  Hyper: "co.zeit.hyper",
};

/** Decides how to raise the terminal. Pure, so every platform/terminal combination is unit-tested. */
export function planFocus(f: FocusEnv): FocusStep[] {
  if (f.platform === "win32") return [{ kind: "windows", pid: f.pid }];
  if (f.platform !== "darwin") return [];
  const steps: FocusStep[] = [];
  if (f.env.TMUX && f.env.TMUX_PANE) steps.push({ kind: "tmux", pane: f.env.TMUX_PANE });
  const bundle = f.env.__CFBundleIdentifier || BUNDLES[f.env.TERM_PROGRAM ?? ""] || (f.env.TERM === "xterm-kitty" ? "net.kovidgoyal.kitty" : undefined);
  if (f.tty && bundle === "com.googlecode.iterm2") steps.push({ kind: "iterm", tty: f.tty });
  if (f.tty && bundle === "com.apple.Terminal") steps.push({ kind: "terminal-app", tty: f.tty });
  if (bundle) steps.push({ kind: "open-bundle", bundleId: bundle });
  else {
    const app = f.ancestors?.map(p => p.match(/^(.*?\.app)\//)?.[1]).find(Boolean);
    if (app) steps.push({ kind: "open-app", path: app });
  }
  return steps;
}

const ITERM = `on run argv
  set t to item 1 of argv
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if tty of s is t then
            select tb
            select s
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

const TERMINAL_APP = `on run argv
  set t to item 1 of argv
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with tb in tabs of w
        if tty of tb is t then
          set selected of tb to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

/** Walks up from pi to the first process that owns a window, then raises it (Alt tap unlocks SetForegroundWindow). */
export function windowsScript(pid: number): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class PiSessionsWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
$id = ${Math.trunc(pid)}; $h = [IntPtr]::Zero
for ($i = 0; $i -lt 10 -and $id; $i++) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
}
if ($h -eq [IntPtr]::Zero) { $h = [PiSessionsWin]::GetConsoleWindow() }
if ($h -eq [IntPtr]::Zero) { exit 2 }
if ([PiSessionsWin]::IsIconic($h)) { [PiSessionsWin]::ShowWindow($h, 9) | Out-Null }
[PiSessionsWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[PiSessionsWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
if ([PiSessionsWin]::SetForegroundWindow($h)) { 'ok' } else { exit 3 }`;
}

type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
const run: Run = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
});

/** Executes steps in order until one fully succeeds. Returns the step that worked, or undefined. */
export async function runFocus(steps: FocusStep[], exec: Run = run): Promise<FocusStep["kind"] | undefined> {
  for (const step of steps) {
    try {
      switch (step.kind) {
        case "tmux":
          // Select pi's pane inside tmux, then keep going to raise the terminal itself.
          await exec("tmux", ["select-window", "-t", step.pane], 3000);
          await exec("tmux", ["select-pane", "-t", step.pane], 3000);
          continue;
        case "iterm":
          if (await exec("osascript", ["-e", ITERM, step.tty], 5000) === "ok") return step.kind;
          continue;
        case "terminal-app":
          if (await exec("osascript", ["-e", TERMINAL_APP, step.tty], 5000) === "ok") return step.kind;
          continue;
        case "open-bundle":
          await exec("open", ["-b", step.bundleId], 5000);
          return step.kind;
        case "open-app":
          await exec("open", ["-a", step.path], 5000);
          return step.kind;
        case "windows": {
          const encoded = Buffer.from(windowsScript(step.pid), "utf16le").toString("base64");
          if (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], 10000) === "ok") return step.kind;
          continue;
        }
      }
    } catch {
      // Denied automation permission, missing tool, timeout: try the next, coarser step.
    }
  }
  return undefined;
}

/** Controlling tty of a process on macOS ("/dev/ttys004"), or of the tmux client when inside tmux. */
async function ttyOf(pid: number, env: NodeJS.ProcessEnv, exec: Run): Promise<string | undefined> {
  try {
    if (env.TMUX) { const t = await exec("tmux", ["display-message", "-p", "#{client_tty}"], 3000); if (t.startsWith("/dev/")) return t; }
    const t = (await exec("ps", ["-o", "tty=", "-p", String(pid)], 3000)).trim();
    return t && t !== "??" ? `/dev/${t}` : undefined;
  } catch { return undefined; }
}
async function ancestorsOf(pid: number, exec: Run): Promise<string[]> {
  const out: string[] = [];
  try {
    let cur = pid;
    for (let i = 0; i < 12; i++) {
      const [ppid, ...comm] = (await exec("ps", ["-o", "ppid=,comm=", "-p", String(cur)], 3000)).trim().split(/\s+/);
      if (!comm.length) break;
      out.push(comm.join(" "));
      cur = Number(ppid);
      if (!cur || cur <= 1) break;
    }
  } catch {}
  return out;
}

export async function focusTerminal(exec: Run = run): Promise<FocusStep["kind"] | undefined> {
  const base = { platform: process.platform, env: process.env, pid: process.pid };
  if (base.platform !== "darwin") return runFocus(planFocus(base), exec);
  const [tty, ancestors] = await Promise.all([ttyOf(process.pid, process.env, exec), ancestorsOf(process.pid, exec)]);
  return runFocus(planFocus({ ...base, tty, ancestors }), exec);
}
