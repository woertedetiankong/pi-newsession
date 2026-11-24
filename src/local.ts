import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionRoot } from "./adapters.ts";

export interface LocalPaths { agent: string; pi: string; claude: string; codex: string; codexArchive: string; data: string; settings: string; }
const directory = (p: string) => resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
/** Only local filesystem locations, honoring each CLI's home override. */
export function localPaths(env: NodeJS.ProcessEnv = process.env): LocalPaths {
  const agent = directory(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const codexHome = directory(env.CODEX_HOME || join(homedir(), ".codex"));
  return {
    agent, pi: join(agent, "sessions"), settings: join(agent, "settings.json"),
    claude: join(directory(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")), "projects"),
    codex: join(codexHome, "sessions"), codexArchive: join(codexHome, "archived_sessions"),
    data: join(agent, "pi-sessions"),
  };
}
export function externalRoots(paths: LocalPaths): SessionRoot[] {
  return [
    { source: "claude", path: paths.claude, maxDepth: 1 },
    { source: "codex", path: paths.codex, maxDepth: 3 },
    { source: "codex", path: paths.codexArchive, maxDepth: 3 },
  ];
}
/** Standalone mode also discovers pi's configured session directory. Relative settings
 * are relative to the manager's cwd; project-specific overrides can be passed explicitly. */
export async function configuredPiDir(settings: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<string | undefined> {
  let dir: unknown = env.PI_CODING_AGENT_SESSION_DIR;
  if (!dir) { try { dir = JSON.parse(await readFile(settings, "utf8")).sessionDir; } catch {} }
  if (typeof dir !== "string" || !dir.trim()) return undefined;
  const expanded = dir.replace(/^~(?=$|[\\/])/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
