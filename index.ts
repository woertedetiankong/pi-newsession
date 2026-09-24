import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionsServer, type Binding } from "./src/server.ts";
import { appendSessionName } from "./src/rename.ts";

const PREFERRED_PORT = 47291;
// The server outlives a single extension runtime (session switches rebuild the runtime), so it lives on globalThis.
const shared = globalThis as typeof globalThis & { __piSessionsServer?: SessionsServer };

function paths() {
  const agent = getAgentDir(), data = join(agent, "pi-sessions");
  return { root: join(agent, "sessions"), data, metaFile: join(data, "meta.json"), tokenFile: join(data, "token") };
}
async function loadToken(file: string, dir: string): Promise<string> {
  try { const t = (await readFile(file, "utf8")).trim(); if (/^[a-f0-9]{32,}$/.test(t)) return t; } catch {}
  const token = randomBytes(24).toString("hex");
  await mkdir(dir, { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = execFile(cmd, args as string[], () => {});
  child.unref();
}

export default function sessionsExtension(pi: ExtensionAPI): void {
  const bind = (ctx: ExtensionContext): Binding => ({
    currentSessionFile: () => ctx.sessionManager.getSessionFile(),
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

  pi.on("session_start", (_event, ctx) => {
    if (shared.__piSessionsServer) shared.__piSessionsServer.binding = bind(ctx);
  });
  pi.on("session_shutdown", async event => {
    const server = shared.__piSessionsServer;
    if (!server) return;
    server.binding = undefined;
    // Reload may bring new plugin code, so restart the server lazily on the next /sessions.
    if (event.reason === "quit" || event.reason === "reload") { shared.__piSessionsServer = undefined; await server.close(); }
  });

  async function start(ctx: ExtensionContext): Promise<string> {
    let server = shared.__piSessionsServer;
    if (!server) {
      const p = paths();
      server = new SessionsServer({
        root: p.root, metaFile: p.metaFile, token: await loadToken(p.tokenFile, p.data), port: PREFERRED_PORT,
        webFile: fileURLToPath(new URL("./web/index.html", import.meta.url)),
      });
      shared.__piSessionsServer = server;
    }
    server.binding = bind(ctx);
    return server.start();
  }

  pi.registerCommand("sessions", {
    description: "在浏览器中按项目和日期浏览、搜索、整理会话",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (command.startsWith("switch ")) {
          const target = resolve(command.slice("switch ".length).trim()), root = resolve(paths().root);
          if (!target.startsWith(root + sep) || !target.endsWith(".jsonl") || !(await stat(target).catch(() => undefined))?.isFile()) {
            ctx.ui.notify("找不到这个会话文件", "error");
            return;
          }
          const result = await ctx.switchSession(target);
          if (result.cancelled) ctx.ui.notify("已取消切换会话", "info");
          return;
        }
        if (command === "stop") {
          const server = shared.__piSessionsServer;
          shared.__piSessionsServer = undefined;
          await server?.close();
          ctx.ui.notify("会话管理页面已关闭", "info");
          return;
        }
        const url = await start(ctx);
        if (command === "url") { ctx.ui.notify(`会话管理地址（含访问令牌，勿分享）：${url}`, "info"); return; }
        openBrowser(url);
        ctx.ui.notify(`会话管理已在浏览器中打开：${url.replace(/#.*/, "")}（/sessions url 查看完整地址，/sessions stop 关闭）`, "info");
      } catch (e) {
        ctx.ui.notify(`会话管理出错：${(e as Error).message}`, "error");
      }
    },
  });
}
