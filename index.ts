import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { constants, copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionsServer, type Binding } from "./src/server.ts";
import { appendSessionName } from "./src/rename.ts";
import { MetaStore } from "./src/meta.ts";
import { SessionScanner } from "./src/scan.ts";
import { focusTerminal } from "./src/focus.ts";
import { DataLocation, openPath } from "./src/storage.ts";

// The server outlives a single extension runtime (session switches rebuild the runtime), so it lives on globalThis.
const shared = globalThis as typeof globalThis & { __piSessionsServer?: SessionsServer };

function paths() {
  const agent = getAgentDir(), data = join(agent, "pi-sessions");
  // meta.json may move (page setting or PI_SESSIONS_DATA_DIR); config.json always stays here, on this machine.
  // The page token is shared with other pi-web apps and lives in <agent>/pi-web/token.
  return { agent, root: join(agent, "sessions"), data, location: new DataLocation(data), settingsFile: join(agent, "settings.json") };
}
let metaCopied: Promise<void> | undefined;
/** PI_SESSIONS_DATA_DIR newly set: carry over the existing meta.json unless one is already there (e.g. synced from another machine). */
function copyMetaOnce(): Promise<void> {
  return metaCopied ??= (async () => {
    const p = paths(), { dir, source } = await p.location.resolve();
    if (source !== "env") return;
    await mkdir(dir, { recursive: true });
    await copyFile(join(p.data, "meta.json"), join(dir, "meta.json"), constants.COPYFILE_EXCL).catch(() => {});
  })();
}
async function metaStore(): Promise<MetaStore> {
  const server = shared.__piSessionsServer;
  if (server) return server.currentMeta();
  await copyMetaOnce();
  return new MetaStore(join((await paths().location.resolve()).dir, "meta.json"));
}
/** Remembers a session dir outside the default root (custom sessionDir / --session-dir / env) so the page lists it too. */
async function rememberSessionDir(ctx: ExtensionContext): Promise<void> {
  const dir = ctx.sessionManager.getSessionDir();
  if (!dir) return;
  const p = paths(), target = resolve(dir), root = resolve(p.root);
  if (target === root || target.startsWith(root + sep)) return;
  await (await metaStore()).addSessionDir(target);
}
async function ownsSessionFile(path: string): Promise<boolean> {
  const server = shared.__piSessionsServer, p = paths();
  const scanner = server?.scanner ?? new SessionScanner(async () => [p.root, ...(await (await metaStore()).sessionDirs())]);
  return scanner.owns(path);
}

export default function sessionsExtension(pi: ExtensionAPI): void {
  const bind = (ctx: ExtensionContext): Binding => ({
    currentSessionFile: () => ctx.sessionManager.getSessionFile(),
    sessionDir: () => ctx.sessionManager.getSessionDir(),
    model: () => ctx,
    open: async path => {
      if (path === ctx.sessionManager.getSessionFile()) return { ok: true, message: "已经是当前会话" };
      if (!ctx.isIdle()) return { ok: false, message: "pi 正在执行任务，完成后再切换" };
      pi.sendUserMessage(`/sessions switch ${path}`, { expandPromptTemplates: true });
      return { ok: true, message: "已在 pi 中切换会话" };
    },
    rename: async (path, title) => {
      if (path === ctx.sessionManager.getSessionFile()) pi.setSessionName(title);
      else await appendSessionName(path, title);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Mount early (no server yet) so other pi-web pages, such as the knowledge base, link here.
    try { (await ensureServer()).binding = bind(ctx); } catch {}
    rememberSessionDir(ctx).catch(() => {});
  });
  pi.on("session_shutdown", async event => {
    const server = shared.__piSessionsServer;
    if (!server) return;
    server.binding = undefined;
    // Reload may bring new plugin code: leave the shared hub (it stops once every app has left) and remount on the next session_start.
    if (event.reason === "quit" || event.reason === "reload") { shared.__piSessionsServer = undefined; await server.close(); }
  });

  async function ensureServer(): Promise<SessionsServer> {
    let server = shared.__piSessionsServer;
    if (!server) {
      const p = paths();
      await copyMetaOnce();
      server = new SessionsServer({
        root: p.root, metaFile: join((await p.location.resolve()).dir, "meta.json"), location: p.location, settingsFile: p.settingsFile,
        agentDir: p.agent, webFile: fileURLToPath(new URL("./web/index.html", import.meta.url)),
      });
      shared.__piSessionsServer = server;
    }
    server.mount();
    return server;
  }

  async function start(ctx: ExtensionContext): Promise<string> {
    const server = await ensureServer();
    server.binding = bind(ctx);
    await rememberSessionDir(ctx).catch(() => {});
    return server.start();
  }

  pi.registerCommand("sessions", {
    description: "在浏览器中按项目和日期浏览、搜索、整理会话",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (command.startsWith("switch ")) {
          const target = resolve(command.slice("switch ".length).trim());
          if (!(await ownsSessionFile(target)) || !(await stat(target).catch(() => undefined))?.isFile()) {
            ctx.ui.notify("找不到这个会话文件", "error");
            return;
          }
          // Read before switching: ctx is stale once the session is replaced.
          const interactive = ctx.hasUI && ctx.mode === "tui";
          const result = await ctx.switchSession(target);
          if (result.cancelled) ctx.ui.notify("已取消切换会话", "info");
          // Bring this terminal back in front of the browser; best effort, opt out with PI_SESSIONS_FOCUS=0.
          else if (interactive && process.env.PI_SESSIONS_FOCUS !== "0") void focusTerminal().catch(() => {});
          return;
        }
        if (command === "stop") {
          // The page is shared with other pi-web apps: stop listening, keep everything mounted for the next open.
          await shared.__piSessionsServer?.hub.close();
          ctx.ui.notify("网页已关闭（同一网页里的其他插件页面也一并关闭）", "info");
          return;
        }
        const url = await start(ctx);
        if (command === "url") { ctx.ui.notify(`会话管理地址（含访问令牌，勿分享）：${url}`, "info"); return; }
        openPath(url);
        ctx.ui.notify(`会话管理已在浏览器中打开：${url.replace(/#.*/, "")}（/sessions url 查看完整地址，/sessions stop 关闭）`, "info");
      } catch (e) {
        ctx.ui.notify(`会话管理出错：${(e as Error).message}`, "error");
      }
    },
  });
}
