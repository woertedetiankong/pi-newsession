import { parseLanguage, systemLanguage, type WebLanguage } from "./hub.ts";

export type Lang = WebLanguage;

/** Messages the server and terminal show to people. Model prompts stay as they are. */
const zh = {
  locationFixed: "这个位置不能在页面上修改",
  locationFromEnv: "位置由环境变量 PI_SESSIONS_DATA_DIR 指定，请先去掉它再在这里修改",
  organizingNoMove: "正在 AI 整理，完成或取消后再移动",
  missingId: "缺少会话 id",
  sessionNotFound: "找不到这个会话，可能已被删除",
  switching: "pi 正在切换会话，请稍后重试",
  noModel: "pi 当前没有选择模型",
  readFailed: "读取会话文件失败，可能已被删除",
  imageNotFound: "找不到这张图片",
  renameWriteFailed: (error: string) => `标题已保存，但写回会话文件失败：${error}`,
  emptyQuery: "请先输入要找的内容",
  cannotOpen: "不能打开这个位置",
  modelMissing: "找不到所选模型，可能已从 pi 中移除",
  modelNoAuth: (id: string) => `${id} 还没有配置登录或 API Key`,
  needFullPath: "请填写完整路径，例如 ~/Dropbox/pi-sessions",
  envNeedsFullPath: (value: string) => `PI_SESSIONS_DATA_DIR 需要完整路径（例如 ~/Dropbox/pi-sessions），现在是「${value}」`,
  notWritable: (code: string) => `无法写入这个目录（${code}）`,
  metaLocked: "会话管理数据正被另一个 pi 占用，请稍后重试",
  noJson: "模型没有返回 JSON",
  noTitle: "模型没有返回标题",
  cancelled: "已取消",
  modelFailed: "模型请求失败",
  // Transcript notes
  compacted: "上下文已压缩",
  branchReturn: "从其他分支返回",
  pluginMessage: "插件消息",
  aborted: "已中断",
  requestError: "请求出错",
  truncated: (chars: string) => `\n…（已截断，共 ${chars} 字）`,
  // Exported image file names
  roleUser: "用户",
  roleTool: "工具",
  roleAssistant: "AI",
  // Terminal and "open in pi"
  alreadyCurrent: "已经是当前会话",
  busy: "pi 正在执行任务，完成后再切换",
  switched: "已在 pi 中切换会话",
  noSessionFile: "找不到这个会话文件",
  switchCancelled: "已取消切换会话",
  stopped: "网页已关闭（同一网页里的其他插件页面也一并关闭）",
  url: (url: string) => `会话管理地址（含访问令牌，勿分享）：${url}`,
  opened: (url: string) => `会话管理已在浏览器中打开：${url}（/sessions url 查看完整地址，/sessions stop 关闭）`,
  failed: (error: string) => `会话管理出错：${error}`,
};

export type MessageKey = keyof typeof zh;
type Messages = { [K in MessageKey]: (typeof zh)[K] };

const en: Messages = {
  locationFixed: "This location cannot be changed on the page",
  locationFromEnv: "The location is set by the PI_SESSIONS_DATA_DIR environment variable; remove it to change the location here",
  organizingNoMove: "AI organizing is running; move the data after it finishes or is cancelled",
  missingId: "Missing session id",
  sessionNotFound: "Session not found; it may have been deleted",
  switching: "pi is switching sessions; try again in a moment",
  noModel: "pi has no model selected",
  readFailed: "Could not read the session file; it may have been deleted",
  imageNotFound: "Image not found",
  renameWriteFailed: (error) => `Title saved, but writing it back to the session file failed: ${error}`,
  emptyQuery: "Describe what you are looking for first",
  cannotOpen: "This location cannot be opened",
  modelMissing: "The selected model was not found; it may have been removed from pi",
  modelNoAuth: (id) => `${id} has no login or API key configured`,
  needFullPath: "Enter a full path, e.g. ~/Dropbox/pi-sessions",
  envNeedsFullPath: (value) => `PI_SESSIONS_DATA_DIR needs a full path (e.g. ~/Dropbox/pi-sessions); it is "${value}"`,
  notWritable: (code) => `Cannot write to this folder (${code})`,
  metaLocked: "Another pi is using the session data; try again in a moment",
  noJson: "The model did not return JSON",
  noTitle: "The model did not return a title",
  cancelled: "Cancelled",
  modelFailed: "The model request failed",
  compacted: "Context compacted",
  branchReturn: "Returned from another branch",
  pluginMessage: "Extension message",
  aborted: "Interrupted",
  requestError: "Request failed",
  truncated: (chars) => `\n… (truncated, ${chars} characters in total)`,
  roleUser: "user",
  roleTool: "tool",
  roleAssistant: "ai",
  alreadyCurrent: "This is already the current session",
  busy: "pi is busy; switch after the current task finishes",
  switched: "Switched sessions in pi",
  noSessionFile: "Session file not found",
  switchCancelled: "Session switch cancelled",
  stopped: "Web page closed (other pages in the same pi web app close too)",
  url: (url) => `Sessions page (includes the access token, do not share): ${url}`,
  opened: (url) => `Sessions opened in the browser: ${url} (/sessions url for the full link, /sessions stop to close)`,
  failed: (error) => `Sessions error: ${error}`,
};

const MESSAGES: Record<Lang, Messages> = { zh, en };

type Args<K extends MessageKey> = Messages[K] extends (...args: infer A) => string ? A : [];

export function text<K extends MessageKey>(lang: Lang, key: K, ...args: Args<K>): string {
  return format(lang, key, args);
}

function format(lang: Lang, key: MessageKey, args: unknown[]): string {
  const value = MESSAGES[lang][key] as string | ((...a: unknown[]) => string);
  return typeof value === "function" ? value(...args) : value;
}

/**
 * An error whose message can be shown in the page's language. `message` stays Chinese
 * (the original wording), and the server translates by `key` before answering.
 */
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly args: unknown[];
  status?: number;
  constructor(key: MessageKey, args: unknown[] = [], status?: number) {
    super(format("zh", key, args));
    this.key = key;
    this.args = args;
    this.status = status;
  }
}

export function localize(error: unknown, lang: Lang): string {
  if (error instanceof LocalizedError) return format(lang, error.key, error.args);
  return (error as Error).message;
}

/** The language the page asked for (x-lang header), Chinese by default. */
export function requestLang(value: unknown): Lang {
  return value === "en" ? "en" : "zh";
}

/** Terminal messages: PI_SESSIONS_LANG, else the system language. */
export function terminalLang(): Lang {
  return parseLanguage(process.env.PI_SESSIONS_LANG) ?? systemLanguage();
}
