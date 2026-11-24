import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SessionsServer } from "./server.ts";
import { localPaths, externalRoots, configuredPiDir } from "./local.ts";
import { launchSession } from "./launch.ts";
import { DataLocation, expandDir, openPath } from "./storage.ts";

export interface CliOptions { open: boolean; port?: number; pi?: string; claude?: string; codex?: string; data?: string; help?: boolean; }
export function parseOptions(args: string[]): CliOptions {
  const out: CliOptions = { open: true };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") { out.help = true; continue; }
    if (flag === "--no-open") { out.open = false; continue; }
    if (!["--port", "--pi-dir", "--claude-dir", "--codex-dir", "--data-dir"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--port") {
      if (!/^\d+$/.test(value) || +value > 65535) throw new Error("--port must be an integer from 0 to 65535");
      out.port = +value;
    } else {
      const key = flag.slice(2, -4) as "pi" | "claude" | "codex" | "data";
      out[key] = expandDir(value);
    }
  }
  return out;
}
export const HELP = `agent-sessions — local pi / Claude Code / Codex session manager

Usage: agent-sessions [options]
  --no-open             Print the URL without opening a browser
  --port <0-65535>       Preferred local port (default: 47291; 0: random)
  --pi-dir <directory>  pi session root
  --claude-dir <dir>    Claude Code projects root
  --codex-dir <dir>     Codex sessions root
  --data-dir <dir>      Manager metadata directory
  -h, --help            Show help

Paths must be absolute or start with ~. Only 127.0.0.1 is served.
Press Ctrl+C to stop. AI tools are available through the pi /sessions entry.
`;

export async function run(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  const paths = localPaths();
  if (options.pi) paths.pi = options.pi;
  if (options.claude) paths.claude = options.claude;
  if (options.codex) { paths.codex = options.codex; paths.codexArchive = join(options.codex, "..", "archived_sessions"); }
  const env = options.data ? { ...process.env, PI_SESSIONS_DATA_DIR: options.data } : process.env;
  const location = new DataLocation(paths.data, env);
  const server = new SessionsServer({
    root: paths.pi, sources: externalRoots(paths), standalone: true, openSession: launchSession,
    metaFile: join((await location.resolve()).dir, "meta.json"), location, agentDir: paths.agent,
    webFile: fileURLToPath(new URL("../web/index.html", import.meta.url)), settingsFile: paths.settings, port: options.port,
  });
  const configured = !options.pi && await configuredPiDir(paths.settings);
  if (configured && configured !== paths.pi) await server.meta.addSessionDir(configured);
  const url = await server.start();
  // pi-web unrefs its listener because the host pi process owns its lifetime.
  // The standalone CLI must own a reference without changing the shared hub.
  const keepAlive = setInterval(() => {}, 60_000);
  process.stdout.write(`Local sessions: ${url}\nPress Ctrl+C to stop.\n`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; clearInterval(keepAlive); void server.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (options.open) openPath(url);
}
