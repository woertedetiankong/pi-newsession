import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LocalizedError } from "./i18n.ts";

export type DataSource = "default" | "config" | "env";
export interface DataDir { dir: string; source: DataSource; }

/** Expands a leading "~" and requires an absolute path, so the result never depends on where pi was started. */
export function expandDir(input: string): string {
  const p = input.trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!p || !isAbsolute(p)) throw new LocalizedError("needFullPath");
  return resolve(p);
}

/**
 * Where meta.json lives: PI_SESSIONS_DATA_DIR, else config.json (set from the page), else the default dir.
 * config.json itself always stays in the default dir, next to the token, on this machine.
 */
export class DataLocation {
  constructor(readonly defaultDir: string, private env: NodeJS.ProcessEnv = process.env) {}
  get configFile(): string { return join(this.defaultDir, "config.json"); }

  async resolve(): Promise<DataDir> {
    const fromEnv = this.env.PI_SESSIONS_DATA_DIR?.trim();
    if (fromEnv) {
      try { return { dir: expandDir(fromEnv), source: "env" }; }
      catch { throw new LocalizedError("envNeedsFullPath", [fromEnv]); }
    }
    // A missing, corrupt or relative setting falls back to the default dir.
    try {
      const { dataDir } = JSON.parse(await readFile(this.configFile, "utf8"));
      if (typeof dataDir === "string" && dataDir) return { dir: expandDir(dataDir), source: "config" };
    } catch {}
    return { dir: this.defaultDir, source: "default" };
  }
  /** undefined goes back to the default dir. */
  async set(dir: string | undefined): Promise<void> {
    await this.patchConfig({ dataDir: dir && resolve(dir) !== resolve(this.defaultDir) ? dir : undefined });
  }

  /** Where "export images" writes; a missing or bad setting falls back to the default. */
  async imageDir(): Promise<{ dir: string; isDefault: boolean }> {
    try {
      const { imageDir } = JSON.parse(await readFile(this.configFile, "utf8"));
      if (typeof imageDir === "string" && imageDir) return { dir: expandDir(imageDir), isDefault: false };
    } catch {}
    return { dir: DEFAULT_IMAGE_DIR, isDefault: true };
  }
  async setImageDir(dir: string | undefined): Promise<void> {
    await this.patchConfig({ imageDir: dir && resolve(dir) !== resolve(DEFAULT_IMAGE_DIR) ? dir : undefined });
  }

  private async patchConfig(patch: Record<string, string | undefined>): Promise<void> {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(await readFile(this.configFile, "utf8")) ?? {}; } catch {}
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete config[k]; else config[k] = v;
    await mkdir(this.defaultDir, { recursive: true });
    const tmp = `${this.configFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 1), { mode: 0o600 });
    await rename(tmp, this.configFile);
  }
}

export const DEFAULT_IMAGE_DIR = join(homedir(), "Pictures", "pi-sessions");

/** Fails with a readable message when the folder cannot be created or written. */
export async function checkWritable(dir: string): Promise<void> {
  const probe = join(dir, `.pi-sessions-${process.pid}.probe`);
  try { await mkdir(dir, { recursive: true }); await writeFile(probe, ""); await rm(probe, { force: true }); }
  catch (e) { throw new LocalizedError("notWritable", [(e as NodeJS.ErrnoException).code ?? (e as Error).message]); }
}

/** Opens a URL in the browser or a folder in Finder / Explorer / the file manager. */
export function openPath(target: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  const child = execFile(cmd, args as string[], () => {});
  child.unref();
}
