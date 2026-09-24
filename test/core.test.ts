import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "node:http";
import { parseSession, SessionScanner, searchSnippet, displayLine } from "../src/scan.ts";
import { MetaStore } from "../src/meta.ts";
import { Organizer, parseOrganized, organizeOne } from "../src/organize.ts";
import { appendSessionName } from "../src/rename.ts";
import { SessionsServer, type Binding } from "../src/server.ts";
import { askSessions, candidateLines, parseAsk } from "../src/ask.ts";
import { activeBranch, buildTranscript, findImage, firstMatch, toolSummary } from "../src/transcript.ts";
import { planFocus, runFocus, windowsScript } from "../src/focus.ts";
import { DataLocation, expandDir } from "../src/storage.ts";
import { folderName, sessionImages } from "../src/export.ts";

async function temp(t: any): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "pi-sessions-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
/** Sessions API routes are mounted under /api/sessions/ on the pi-web hub. */
const api = (p: string) => p.replace(/^\/api\//, "/api/sessions/");

export function sessionFile(id: string, cwd: string, messages: [string, string][], extra: object[] = []): string {
  const lines: object[] = [{ type: "session", version: 3, id, timestamp: "2026-09-01T08:00:00.000Z", cwd }, { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-01T08:00:00.100Z", provider: "p", modelId: "gpt-x" }];
  messages.forEach(([role, text], i) => lines.push({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : "m1", timestamp: `2026-09-01T08:0${Math.min(i + 1, 9)}:00.000Z`, message: { role, content: role === "user" ? [{ type: "text", text }] : [{ type: "thinking", thinking: "hmm" }, { type: "text", text }] } }));
  return [...lines, ...extra].map(l => JSON.stringify(l)).join("\n") + "\n";
}

test("parseSession extracts header, name, model, counts, preview and search text", () => {
  const raw = sessionFile("abc", "/work/pi", [["user", "Why is SCROLL broken?\nsecond line"], ["assistant", "Because handleInput eats arrows"]],
    [{ type: "session_info", id: "n1", parentId: "e1", timestamp: "2026-09-02T09:00:00.000Z", name: " Scroll fix " }]);
  const r = parseSession("/x.jsonl", raw + "not json\n", new Date(0))!;
  assert.equal(r.id, "abc"); assert.equal(r.cwd, "/work/pi"); assert.equal(r.name, "Scroll fix"); assert.equal(r.model, "gpt-x");
  assert.equal(r.count, 2); assert.equal(r.firstUser, "Why is SCROLL broken?");
  assert.equal(r.modified, "2026-09-02T09:00:00.000Z");
  assert.deepEqual(r.messages.map(m => m.role), ["user", "assistant"]);
  assert.ok(r.text.includes("why is scroll broken?") && r.text.includes("handleinput eats arrows"), "search text is lower-cased");
  assert.equal(parseSession("/y.jsonl", '{"type":"message"}\n', new Date(0)), undefined);
});

test("scanner walks project folders and only re-parses changed files", async t => {
  const root = await temp(t), dir = join(root, "--work-pi--");
  await mkdir(dir);
  const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
  await writeFile(a, sessionFile("a", "/work/pi", [["user", "hello"]]));
  await writeFile(b, sessionFile("b", "/work/pi", [["user", "world"], ["assistant", "ok"]]));
  await writeFile(join(dir, "notes.txt"), "ignored");
  const scanner = new SessionScanner(async () => [root]);
  assert.deepEqual((await scanner.scan()).map(r => r.id).sort(), ["a", "b"]);
  const first = (await scanner.scan()).find(r => r.id === "a");
  assert.equal((await scanner.scan()).find(r => r.id === "a"), first, "unchanged file is served from cache");
  await appendFile(a, JSON.stringify({ type: "message", id: "z", parentId: "e0", timestamp: "2026-09-05T00:00:00.000Z", message: { role: "assistant", content: "again" } }) + "\n");
  await utimes(a, new Date(), new Date(Date.now() + 5000));
  const updated = (await scanner.scan()).find(r => r.id === "a")!;
  assert.equal(updated.count, 2); assert.equal(updated.modified, "2026-09-05T00:00:00.000Z");
  await rm(b);
  assert.deepEqual((await scanner.scan()).map(r => r.id), ["a"]);
  assert.deepEqual(await new SessionScanner(async () => [join(root, "missing")]).scan(), []);
});

test("searchSnippet requires every word and centers on the first hit", () => {
  const r = parseSession("/x", sessionFile("s", "/w", [["user", "开始"], ["assistant", "我们把缓存目录挂到 CI 上，构建快了很多"]]), new Date(0))!;
  assert.match(searchSnippet(r, ["缓存", "ci"])!, /缓存目录挂到 CI/);
  assert.equal(searchSnippet(r, ["缓存", "redis"]), undefined);
  assert.equal(searchSnippet(r, []), undefined);
});

test("meta store patches, keeps manual titles over AI results and persists atomically", async t => {
  const dir = await temp(t), file = join(dir, "sub", "meta.json"), store = new MetaStore(file);
  await store.patch("a", { pinned: true, title: "  My   title " });
  await store.organized("a", { title: "AI title", summary: "sum", tags: ["#Bug", "bug", "tui"] }, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(await store.get("a"), { pinned: true, title: "My title", titleSource: "manual", summary: "sum", tags: ["bug", "tui"], organizedAt: "2026-09-01T00:00:00.000Z" });
  await store.organized("b", { title: "AI title", summary: "", tags: [] }, "t");
  assert.equal((await store.get("b")).titleSource, "ai");
  await store.patch("a", { pinned: false, title: "" });
  assert.equal((await store.get("a")).pinned, undefined); assert.equal((await store.get("a")).title, undefined);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 1); assert.deepEqual(Object.keys(saved.sessions).sort(), ["a", "b"]);
  assert.deepEqual(await new MetaStore(file).get("b"), saved.sessions.b);
  await Promise.all([store.patch("c", { pinned: true }), store.patch("d", { archived: true })]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).sessions).sort(), ["a", "b", "c", "d"]);
});

test("parseOrganized tolerates fences and cleans fields", () => {
  assert.deepEqual(parseOrganized('```json\n{"title":"「滚动修复」","summary":" ok ","tags":["#TUI","tui","x"]}\n```'), { title: "滚动修复", summary: "ok", tags: ["tui", "x"] });
  assert.throws(() => parseOrganized("no json"), /JSON/);
  assert.throws(() => parseOrganized('{"title":""}'), /标题/);
});

test("organizeOne sends the conversation to the current model", async () => {
  const r = parseSession("/x", sessionFile("s", "/w", [["user", "fix scroll"], ["assistant", "done"]]), new Date(0))!;
  let seen: any;
  const ctx = { model: { id: "m" }, modelRegistry: { complete: async (_m: unknown, req: any) => { seen = req; return { stopReason: "stop", content: [{ type: "text", text: '{"title":"修复滚动","summary":"s","tags":["bug"]}' }] }; } } } as any;
  assert.deepEqual(await organizeOne(ctx, r, ["bug"], new AbortController().signal), { title: "修复滚动", summary: "s", tags: ["bug"] });
  assert.match(seen.messages[0].content[0].text, /fix scroll/);
  await assert.rejects(organizeOne({ model: undefined } as any, r, [], new AbortController().signal), /没有选择模型/);
});

test("organizer runs jobs in order, counts failures and cancels", async () => {
  const ran: string[] = [];
  const org = new Organizer(async id => { await delay(5); ran.push(id); if (id === "bad") throw new Error("boom"); });
  org.enqueue(["a", "bad"]); org.enqueue(["a", "c"]);
  while (org.status.running) await delay(5);
  assert.deepEqual(ran, ["a", "bad", "c"]);
  assert.deepEqual({ ...org.status }, { running: false, total: 3, done: 2, failed: 1, lastError: "boom" });
  const slow = new Organizer(async (_id, signal) => { await delay(30); if (signal.aborted) throw new Error("aborted"); ran.push("slow"); });
  slow.enqueue(["x", "y"]); await delay(5); slow.cancel();
  slow.enqueue(["z"]);
  while (slow.status.running) await delay(5);
  await delay(40);
  assert.deepEqual(ran.slice(3), ["slow"], "only the job queued after cancel completes");
});

test("appendSessionName appends a session_info entry chained to the last entry", async t => {
  const dir = await temp(t), file = join(dir, "s.jsonl");
  await writeFile(file, sessionFile("s", "/w", [["user", "hi"], ["assistant", "yo"]]));
  await appendSessionName(file, "New\nname");
  const r = parseSession(file, await readFile(file, "utf8"), new Date())!;
  assert.equal(r.name, "New name");
  const last = JSON.parse((await readFile(file, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(last.type, "session_info"); assert.equal(last.parentId, "e1");
});

test("server serves the page, guards the API and routes actions to the binding", async t => {
  const root = await temp(t), dir = join(root, "sessions", "--w--");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "a.jsonl");
  await writeFile(path, sessionFile("a", "/w", [["user", "讨论缓存失效"], ["assistant", "用互斥锁重建"]]));
  await writeFile(join(dir, "b.jsonl"), sessionFile("b", "/w", [["user", "别的事"]]));
  const web = join(root, "index.html"); await writeFile(web, "<p>page</p>");
  const server = new SessionsServer({ root: join(root, "sessions"), metaFile: join(root, "meta.json"), webFile: web, token: "f".repeat(32) });
  const opened: string[] = [], renamed: string[] = [];
  const binding: Binding = {
    currentSessionFile: () => join(dir, "b.jsonl"),
    model: () => ({ model: { id: "m" }, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"title":"缓存重建","summary":"加锁","tags":["cache"]}' }] }) } }) as any,
    open: async p => { opened.push(p); return { ok: true, message: "ok" }; },
    rename: async (p, title) => { renamed.push(`${p}:${title}`); },
  };
  server.binding = binding;
  const url = await server.start();
  t.after(() => server.close());
  const base = new URL(url).origin;
  const call = (p: string, body?: object, token = "f".repeat(32)) => fetch(base + api(p), body ? { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { "x-token": token } });

  assert.match(url, /\/sessions\/#token=f{32}$/);
  assert.equal(await (await fetch(base + "/sessions/")).text(), "<p>page</p>");
  assert.equal(await (await fetch(base + "/")).text(), "<p>page</p>", "old links to / land on the sessions page");
  assert.match(await (await fetch(base + "/hub.js")).text(), /window\.piWeb/);
  const hubApps = await (await fetch(base + "/api/hub/apps", { headers: { "x-token": "f".repeat(32) } })).json();
  assert.deepEqual(hubApps.apps.map((a: any) => a.id), ["sessions"]);
  assert.equal((await call("/api/sessions", undefined, "wrong")).status, 401);
  const list = await (await call("/api/sessions")).json();
  assert.equal(list.current, join(dir, "b.jsonl")); assert.equal(list.model, "m");
  assert.deepEqual(list.sessions.map((s: any) => s.id).sort(), ["a", "b"]);
  assert.equal(list.sessions[0].text, undefined, "full text is not shipped to the page");
  assert.equal(list.home, homedir());
  const first = await call("/api/sessions"), etag = first.headers.get("etag")!;
  assert.ok(etag);
  const again = await fetch(base + "/api/sessions/sessions", { headers: { "x-token": "f".repeat(32), "if-none-match": etag } });
  assert.equal(again.status, 304, "unchanged list is not re-sent");
  await appendFile(path, JSON.stringify({ type: "message", id: "late", parentId: "e1", timestamp: "2026-09-09T00:00:00.000Z", message: { role: "user", content: "新消息" } }) + "\n");
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  const changed = await fetch(base + "/api/sessions/sessions", { headers: { "x-token": "f".repeat(32), "if-none-match": etag } });
  assert.equal(changed.status, 200, "a changed session invalidates the etag");
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.deepEqual((await (await call("/api/search?q=缓存")).json()).hits.map((h: any) => h.id), ["a"]);
  const tx = await (await call("/api/transcript?id=a&limit=2&q=缓存")).json();
  assert.equal(tx.total, 3, "includes the message appended above"); assert.equal(tx.items.length, 2); assert.equal(tx.firstMatch, 0);
  const page2 = await (await call("/api/transcript?id=a&offset=2&limit=2")).json();
  assert.deepEqual(page2.items.map((i: any) => i.text), ["新消息"]); assert.equal(page2.firstMatch, undefined);
  assert.equal((await call("/api/transcript?id=zzz")).status, 404);

  const meta = await (await call("/api/meta", { id: "a", title: "缓存方案", pinned: true })).json();
  assert.deepEqual(meta.meta, { title: "缓存方案", titleSource: "manual", pinned: true });
  assert.deepEqual(renamed, [`${path}:缓存方案`]);
  assert.deepEqual(await (await call("/api/open", { id: "a" })).json(), { ok: true, message: "ok" });
  assert.deepEqual(opened, [path]);

  await call("/api/organize", { ids: ["a", "b"] });
  while (server.organizer.status.running) await delay(5);
  const after = await (await call("/api/sessions")).json(), metaOf = (id: string) => after.sessions.find((s: any) => s.id === id).meta;
  assert.equal(metaOf("a").title, "缓存方案", "manual title survives AI organize");
  assert.equal(metaOf("a").summary, "加锁");
  assert.equal(metaOf("b").title, "缓存重建");

  const png = Buffer.from("89504e470d0a1a0a", "hex");
  await appendFile(path, JSON.stringify({ type: "message", id: "pic", parentId: "late", timestamp: "2026-09-09T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] } }) + "\n");
  const picTx = await (await call("/api/transcript?id=a&offset=3")).json();
  assert.deepEqual(picTx.items[0].images, [{ entry: "pic", n: 0, mimeType: "image/svg+xml" }, { entry: "pic", n: 1, mimeType: "image/png" }]);
  const img = await call("/api/image?id=a&entry=pic&n=1");
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await call("/api/image?id=a&entry=pic&n=0")).headers.get("content-type"), "application/octet-stream", "SVG is never served as an image");
  assert.equal((await call("/api/image?id=a&entry=pic&n=5")).status, 404);
  assert.equal((await call("/api/image?id=a&entry=pic&n=1", undefined, "wrong")).status, 401);

  server.binding = undefined;
  assert.equal((await call("/api/open", { id: "a" })).status, 503);
  const port = Number(new URL(base).port);
  const status = await new Promise<number>((resolve, reject) => request({ host: "127.0.0.1", port, path: "/api/sessions/sessions", headers: { "x-token": "f".repeat(32), host: `evil.example:${port}` } }, res => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end());
  assert.equal(status, 403, "DNS-rebinding host is rejected");
  assert.equal((await fetch(base + "/api/sessions/meta", { method: "POST", headers: { "x-token": "f".repeat(32), "content-type": "text/plain" }, body: "{}" })).status, 415);
});

test("ask: candidate lines are compact, newest first, and count unorganized sessions", () => {
  const a = parseSession("/a", sessionFile("a", "/w/pi", [["user", "终端里|滚动\n失效"]]), new Date(0))!;
  const b = { ...parseSession("/b", sessionFile("b", "/w/blog", [["user", "构建慢"]]), new Date(0))!, modified: "2026-09-10T00:00:00.000Z" };
  const empty = { ...a, id: "e", count: 0 };
  const { lines, ids, unorganized } = candidateLines([a, b, empty], { b: { title: "构建加速", summary: "缓存 CI", tags: ["ci"] } });
  assert.deepEqual(ids, ["b", "a"], "newest first, empty sessions skipped");
  assert.equal(lines[0], "1|blog|" + lines[0].split("|")[2] + "|构建加速|缓存 CI|ci|构建慢");
  assert.match(lines[1], /^2\|pi\|.*\|\|\|\|终端里 滚动$/, "pipes and newlines inside fields are flattened");
  assert.equal(unorganized, 1);
});

test("ask: parseAsk keeps only real, unique candidate numbers", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(parseAsk('```json\n{"results":[{"n":2,"reason":"讲滚动"},{"n":9,"reason":"编造"},{"n":2,"reason":"重复"},{"n":"1"}]}\n```', ids),
    [{ id: "b", reason: "讲滚动" }, { id: "a", reason: "" }]);
  assert.deepEqual(parseAsk('{"results":[]}', ids), []);
  assert.throws(() => parseAsk("抱歉", ids), /JSON/);
});

test("ask: askSessions sends query, today and candidates to the current model", async () => {
  const r = parseSession("/a", sessionFile("a", "/w/pi", [["user", "arrow keys do not scroll"]]), new Date(0))!;
  let seen: any;
  const ctx = { model: { id: "m" }, modelRegistry: { complete: async (_m: unknown, req: any) => { seen = JSON.parse(req.messages[0].content[0].text); return { stopReason: "stop", usage: { input: 120, output: 30 }, content: [{ type: "text", text: '{"results":[{"n":1,"reason":"方向键滚动"}]}' }] }; } } } as any;
  const out = await askSessions(ctx, "上周那个滚动 bug", [r], {}, new AbortController().signal, new Date(2026, 8, 23));
  assert.deepEqual(out, { results: [{ id: "a", reason: "方向键滚动" }], candidates: 1, unorganized: 1, usage: { input: 120, output: 30 } });
  assert.equal(seen.today, "2026-09-23"); assert.equal(seen.query, "上周那个滚动 bug"); assert.match(seen.sessions, /arrow keys do not scroll/);
  assert.deepEqual(await askSessions(ctx, "x", [], {}, new AbortController().signal), { results: [], candidates: 0, unorganized: 0 });
});

test("server /api/ask validates input and returns ranked hits", async t => {
  const root = await temp(t), dir = join(root, "sessions", "--w--");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.jsonl"), sessionFile("a", "/w", [["user", "滚动坏了"]]));
  await writeFile(join(root, "index.html"), "");
  const server = new SessionsServer({ root: join(root, "sessions"), metaFile: join(root, "meta.json"), webFile: join(root, "index.html"), token: "e".repeat(32) });
  let model: any = { id: "m" };
  server.binding = { currentSessionFile: () => undefined, open: async () => ({ ok: true, message: "" }), rename: async () => {},
    model: () => ({ model, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"results":[{"n":1,"reason":"滚动"}]}' }] }) } }) as any };
  const base = new URL(await server.start()).origin;
  t.after(() => server.close());
  const ask = (body: object) => fetch(base + "/api/sessions/ask", { method: "POST", headers: { "x-token": "e".repeat(32), "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await ask({ query: "  " })).status, 400);
  assert.deepEqual(await (await ask({ query: "滚动" })).json(), { results: [{ id: "a", reason: "滚动" }], candidates: 1, unorganized: 1, model: "m" });
  model = undefined;
  assert.equal((await ask({ query: "滚动" })).status, 409);
});

test("displayLine turns skill invocations into a readable first line", () => {
  const skill = '<skill name="find-skills" location="/x/SKILL.md">\n# Find Skills\nlots of text\n</skill>';
  assert.equal(displayLine(skill), "[find-skills]");
  assert.equal(displayLine(skill + "\n\n帮我找个 PDF 技能\n第二行"), "[find-skills] 帮我找个 PDF 技能");
  assert.equal(displayLine("普通问题\n第二行"), "普通问题");
  assert.equal(parseSession("/x", sessionFile("s", "/w", [["user", skill]]), new Date(0))!.firstUser, "[find-skills]");
});

test("scanner reads flat custom session dirs and validates switch targets", async t => {
  const base = await temp(t), root = join(base, "sessions"), custom = join(base, "proj", ".pi", "sessions");
  await mkdir(join(root, "--w--"), { recursive: true }); await mkdir(custom, { recursive: true });
  await writeFile(join(root, "--w--", "a.jsonl"), sessionFile("a", "/w", [["user", "hi"]]));
  await writeFile(join(custom, "b.jsonl"), sessionFile("b", "/proj", [["user", "flat"]]));
  await writeFile(join(custom, "dup.jsonl"), sessionFile("a", "/w", [["user", "same id"]]));
  const scanner = new SessionScanner(async () => [root, custom, custom + "/"]);
  assert.deepEqual((await scanner.scan()).map(r => r.id).sort(), ["a", "b"], "flat dir is read, duplicate dirs and ids collapse");
  assert.equal(await scanner.owns(join(custom, "b.jsonl")), true);
  assert.equal(await scanner.owns(join(root, "--w--", "a.jsonl")), true);
  assert.equal(await scanner.owns(join(base, "elsewhere", "x.jsonl")), false);
  assert.equal(await scanner.owns(join(root, "--w--", "a.txt")), false);
  assert.equal(await scanner.owns(join(root, "--w--", "..", "..", "etc.jsonl")), false, "path traversal resolves outside");
});

test("meta store: two pi processes editing at once keep both changes", async t => {
  const dir = await temp(t), file = join(dir, "meta.json");
  const a = new MetaStore(file), b = new MetaStore(file);
  await a.get("x"); await b.get("y");
  await a.patch("x", { pinned: true });
  await b.patch("y", { pinned: true });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).sessions).sort(), ["x", "y"]);
  assert.equal((await b.get("x")).pinned, true, "b sees a's write without restarting");
  await Promise.all([...Array(10)].map((_, i) => (i % 2 ? a : b).patch("k" + i, { archived: true })));
  assert.equal(Object.keys(await new MetaStore(file).all()).length, 12, "concurrent writers from both stores all land");
  await a.addSessionDir("/custom"); await b.addSessionDir("/custom");
  assert.deepEqual(await new MetaStore(file).sessionDirs(), ["/custom"]);
  await writeFile(file + ".lock", ""); await utimes(file + ".lock", new Date(0), new Date(0));
  await a.patch("z", { pinned: true });
  assert.equal((await b.get("z")).pinned, true, "a stale lock from a crashed process is taken over");
});

test("search text is capped per session to bound memory", () => {
  const big = "x".repeat(60_000);
  const r = parseSession("/x", sessionFile("s", "/w", [["user", big], ["assistant", big], ["user", big]]), new Date(0))!;
  assert.ok(r.text.length <= 100_000);
});

test("page path helpers handle macOS, Linux and Windows home dirs", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const code = html.split("\n").filter(l => /^(const norm|function projName|function tilde)/.test(l)).join("\n");
  const make = (home: string) => new Function("state", code + "\nreturn { projName, tilde };")({ home }) as { projName(p: string): string; tilde(p: string): string };
  const mac = make("/Users/alex");
  assert.equal(mac.projName("/Users/alex"), "~ (home)"); assert.equal(mac.projName("/Users/alex/code/blog"), "blog");
  assert.equal(mac.tilde("/Users/alex/code/blog"), "~/code/blog"); assert.equal(mac.tilde("/Users/alexander/x"), "/Users/alexander/x");
  const win = make("C:\\Users\\Alex");
  assert.equal(win.projName("c:\\users\\alex\\"), "~ (home)"); assert.equal(win.projName("C:\\Users\\Alex\\code\\blog"), "blog");
  assert.equal(win.tilde("C:\\Users\\Alex\\code"), "~\\code");
  assert.equal(make("").projName("/home/bob"), "bob");
});

const jsonl = (entries: object[]) => [{ type: "session", version: 3, id: "s", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/w" }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n";
const msg = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, timestamp: "2026-09-01T00:00:00.000Z", message });

test("transcript follows the active branch (last entry back to root)", () => {
  const raw = jsonl([
    msg("u1", null, { role: "user", content: "问题" }),
    msg("a1", "u1", { role: "assistant", content: [{ type: "text", text: "旧回答" }] }),
    msg("a2", "u1", { role: "assistant", content: [{ type: "text", text: "新回答" }] }),
    { type: "session_info", id: "n", parentId: "a2", timestamp: "t", name: "x" },
  ]);
  assert.deepEqual(activeBranch(raw).map(e => e.id), ["u1", "a2", "n"]);
  assert.deepEqual(buildTranscript(raw).map((i: any) => i.text), ["问题", "新回答"]);
});

test("transcript attaches tool results, keeps thinking, notes and bash, and truncates huge output", () => {
  const raw = jsonl([
    msg("u", null, { role: "user", content: [{ type: "text", text: "跑测试" }, { type: "image", data: "x", mimeType: "image/png" }] }),
    msg("a", "u", { role: "assistant", content: [{ type: "thinking", thinking: "先跑一下" }, { type: "text", text: "我来运行" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm   test" } }, { type: "toolCall", id: "c2", name: "read", arguments: { path: "/a.ts" } }] }),
    msg("r1", "a", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(30_000) }], isError: true }),
    msg("r2", "r1", { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "image", data: "eA==", mimeType: "image/jpeg" }], isError: false }),
    { type: "compaction", id: "c", parentId: "r2", timestamp: "t", summary: "之前讨论了测试", tokensBefore: 1 },
    msg("b", "c", { role: "bashExecution", command: "ls", output: "a b", exitCode: 1, cancelled: false, truncated: false }),
    msg("e", "b", { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }),
  ]);
  const items: any[] = buildTranscript(raw);
  assert.deepEqual(items.map(i => i.kind), ["user", "assistant", "note", "assistant", "assistant"]);
  assert.deepEqual(items[0].images, [{ entry: "u", n: 0, mimeType: "image/png" }]);
  assert.deepEqual([items[1].tools[1].output, items[1].tools[1].images], ["", [{ entry: "r2", n: 0, mimeType: "image/jpeg" }]]);
  assert.deepEqual(findImage(raw, "r2", 0), { data: Buffer.from("x"), mimeType: "image/jpeg" });
  assert.equal(findImage(raw, "r2", 1), undefined);
  assert.equal(items[1].thinking, "先跑一下");
  assert.deepEqual(items[1].tools.map((t: any) => [t.name, t.summary, t.isError]), [["bash", "npm test", true], ["read", "/a.ts", false]]);
  assert.ok(items[1].tools[0].output.length < 21_000 && items[1].tools[0].output.includes("已截断"));
  assert.equal(items[2].title, "上下文已压缩");
  assert.deepEqual([items[3].tools[0].summary, items[3].tools[0].isError], ["! ls", true]);
  assert.equal(items[4].error, "rate limited");
  assert.equal(firstMatch(items, ["npm"]), 1); assert.equal(firstMatch(items, ["npm", "不存在"]), -1); assert.equal(firstMatch(items, []), -1);
  assert.equal(toolSummary("custom", { foo: 1, bar: "line one\nline two" }), "line one line two");
  assert.equal(toolSummary("noop", {}), "noop");
});

test("planFocus picks the most precise way to raise each terminal", () => {
  const mac = (env: NodeJS.ProcessEnv, extra: object = {}) => planFocus({ platform: "darwin", env, pid: 1, tty: "/dev/ttys004", ...extra });
  assert.deepEqual(mac({ TERM_PROGRAM: "iTerm.app" }), [{ kind: "iterm", tty: "/dev/ttys004" }, { kind: "open-bundle", bundleId: "com.googlecode.iterm2" }]);
  assert.deepEqual(mac({ TERM_PROGRAM: "Apple_Terminal" }).map(s => s.kind), ["terminal-app", "open-bundle"]);
  assert.deepEqual(mac({ __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92", TERM_PROGRAM: "vscode" }), [{ kind: "open-bundle", bundleId: "com.todesktop.230313mzl4w4u92" }], "Cursor reports vscode; the bundle id wins");
  assert.deepEqual(mac({ TERM: "xterm-kitty" }), [{ kind: "open-bundle", bundleId: "net.kovidgoyal.kitty" }]);
  assert.deepEqual(mac({}, { ancestors: ["-zsh", "/Applications/Alacritty.app/Contents/MacOS/alacritty"] }), [{ kind: "open-app", path: "/Applications/Alacritty.app" }]);
  assert.deepEqual(mac({ TERM_PROGRAM: "iTerm.app" }, { tty: undefined }).map(s => s.kind), ["open-bundle"], "no tty: app-level only");
  assert.deepEqual(mac({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux", TMUX_PANE: "%3" }).map(s => s.kind), ["tmux", "iterm", "open-bundle"]);
  assert.deepEqual(mac({}), []);
  assert.deepEqual(planFocus({ platform: "win32", env: {}, pid: 42 }), [{ kind: "windows", pid: 42 }]);
  assert.deepEqual(planFocus({ platform: "linux", env: { TERM_PROGRAM: "iTerm.app" }, pid: 1 }), []);
});

test("runFocus falls back step by step and never throws", async () => {
  const calls: string[] = [];
  const exec = (answers: Record<string, string | Error>) => async (cmd: string, args: string[]) => {
    calls.push(cmd + (cmd === "osascript" ? " " + args.at(-1) : cmd === "open" ? " " + args.join(" ") : ""));
    const a = answers[cmd]; if (a instanceof Error) throw a; return a ?? "";
  };
  const iterm = [{ kind: "iterm", tty: "/dev/ttys004" }, { kind: "open-bundle", bundleId: "com.googlecode.iterm2" }] as const;
  assert.equal(await runFocus([...iterm], exec({ osascript: "ok" })), "iterm");
  assert.deepEqual(calls.splice(0), ["osascript /dev/ttys004"], "exact tab found: no app-level fallback");
  assert.equal(await runFocus([...iterm], exec({ osascript: "missing" })), "open-bundle");
  assert.equal(await runFocus([...iterm], exec({ osascript: new Error("Not authorized to send Apple events") })), "open-bundle", "denied automation falls back");
  calls.length = 0;
  assert.equal(await runFocus([{ kind: "tmux", pane: "%3" }, { kind: "open-bundle", bundleId: "x" }], exec({})), "open-bundle");
  assert.deepEqual(calls, ["tmux", "tmux", "open -b x"], "tmux pane is selected, then the app raised");
  assert.equal(await runFocus([{ kind: "windows", pid: 7 }], exec({ "powershell.exe": new Error("exit 3") })), undefined);
  assert.equal(await runFocus([{ kind: "windows", pid: 7 }], exec({ "powershell.exe": "ok" })), "windows");
  assert.equal(await runFocus([], exec({})), undefined);
});

test("windows focus script targets the given pid and only uses the documented user32 calls", () => {
  const s = windowsScript(1234.9);
  assert.match(s, /\$id = 1234;/);
  for (const fn of ["SetForegroundWindow", "ShowWindow", "IsIconic", "keybd_event", "GetConsoleWindow"]) assert.ok(s.includes(fn), fn);
  assert.equal(Buffer.from(Buffer.from(s, "utf16le").toString("base64"), "base64").toString("utf16le"), s, "round-trips through -EncodedCommand");
});

test("data location: env beats the page setting, which beats the default", async t => {
  const dir = await temp(t), env: NodeJS.ProcessEnv = {}, loc = new DataLocation(join(dir, "pi-sessions"), env);
  assert.deepEqual(await loc.resolve(), { dir: join(dir, "pi-sessions"), source: "default" });
  await loc.set(join(dir, "sync"));
  assert.deepEqual(await loc.resolve(), { dir: join(dir, "sync"), source: "config" });
  env.PI_SESSIONS_DATA_DIR = "~/env-dir";
  assert.deepEqual(await loc.resolve(), { dir: join(homedir(), "env-dir"), source: "env" });
  env.PI_SESSIONS_DATA_DIR = "relative/dir";
  await assert.rejects(loc.resolve(), /PI_SESSIONS_DATA_DIR 需要完整路径/);
  delete env.PI_SESSIONS_DATA_DIR;
  await loc.set(undefined);
  assert.equal((await loc.resolve()).source, "default");
  await writeFile(loc.configFile, '{"dataDir":"not/absolute"}');
  assert.equal((await loc.resolve()).source, "default", "a bad setting falls back instead of breaking the page");
  assert.throws(() => expandDir("  "), /完整路径/);
});

test("server storage: lists locations and moves plugin data with a merge", async t => {
  const root = await temp(t), sessions = join(root, "sessions"), custom = join(root, "proj", ".pi", "sessions"), home = join(root, "pi-sessions");
  await mkdir(join(sessions, "--w--"), { recursive: true }); await mkdir(custom, { recursive: true });
  await writeFile(join(sessions, "--w--", "a.jsonl"), sessionFile("a", "/w", [["user", "hi"]]));
  await writeFile(join(custom, "b.jsonl"), sessionFile("b", "/proj", [["user", "flat"]]));
  await writeFile(join(root, "index.html"), "");
  const env: NodeJS.ProcessEnv = {}, location = new DataLocation(home, env), token = "d".repeat(32);
  const make = () => new SessionsServer({ root: sessions, metaFile: join(home, "meta.json"), location, settingsFile: join(root, "settings.json"), webFile: join(root, "index.html"), token });
  const server = make(), other = make();
  server.binding = { currentSessionFile: () => undefined, sessionDir: () => join(sessions, "--w--"), model: () => undefined, open: async () => ({ ok: true, message: "" }), rename: async () => {} };
  const base = new URL(await server.start()).origin;
  t.after(() => server.close());
  const call = (path: string, body?: object) => fetch(base + api(path), body ? { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { "x-token": token } });

  await server.meta.addSessionDir(custom);
  await server.meta.patch("a", { title: "当前标题", pinned: true });
  let st = await (await call("/api/storage")).json();
  assert.deepEqual(st.sessions.dirs.map((d: any) => [d.path, d.isDefault, d.current, d.count]), [[sessions, true, true, 1], [custom, false, false, 1]]);
  assert.deepEqual(st.data, { dir: home, source: "default", defaultDir: home, movable: true });

  // The new folder already holds data (e.g. synced from another machine): both survive, the data in use wins on conflicts.
  const sync = join(root, "Dropbox", "pi");
  await new MetaStore(join(sync, "meta.json")).patch("a", { title: "旧的同步标题" });
  await new MetaStore(join(sync, "meta.json")).patch("z", { archived: true });
  assert.equal((await call("/api/storage/data", { dir: "relative" })).status, 400);
  await writeFile(join(root, "a-file"), "");
  assert.equal((await call("/api/storage/data", { dir: join(root, "a-file", "sub") })).status, 400, "unwritable target is refused");
  st = await (await call("/api/storage/data", { dir: sync })).json();
  assert.deepEqual(st.data.source, "config"); assert.equal(st.data.dir, sync);
  const moved = JSON.parse(await readFile(join(sync, "meta.json"), "utf8"));
  assert.equal(moved.sessions.a.title, "当前标题"); assert.equal(moved.sessions.z.archived, true); assert.deepEqual(moved.sessionDirs, [custom]);
  assert.equal(JSON.parse(await readFile(join(home, "meta.json"), "utf8")).sessions.a.title, "当前标题", "old file is left in place");

  // Writes after the move go to the new folder, and another pi window follows the change.
  await call("/api/meta", { id: "b", pinned: true });
  assert.equal((await new MetaStore(join(sync, "meta.json")).get("b")).pinned, true);
  assert.equal((await (await other.currentMeta()).get("b")).pinned, true);

  // Back to the default folder: the stale copy there is refreshed from the data in use.
  await call("/api/meta", { id: "a", title: "改过的标题" });
  st = await (await call("/api/storage/data", {})).json();
  assert.equal(st.data.source, "default");
  assert.equal((await new MetaStore(join(home, "meta.json")).get("a")).title, "改过的标题");

  assert.equal((await call("/api/storage/open", { path: "/etc" })).status, 400, "only listed folders can be opened");
  env.PI_SESSIONS_DATA_DIR = sync;
  assert.equal((await call("/api/storage/data", { dir: join(root, "x") })).status, 409, "env var locks the location");
  assert.equal((await (await call("/api/storage")).json()).data.source, "env");
});

test("export: images from every branch, safe folder names", () => {
  const raw = sessionFile("abcdef123456", "/w", [["user", "hi"]], [
    { type: "message", id: "u", parentId: "e0", timestamp: "t", message: { role: "user", content: [{ type: "image", data: "YQ==", mimeType: "image/png" }] } },
    { type: "message", id: "r", parentId: "e0", timestamp: "t", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "x" }, { type: "image", data: "Yg==", mimeType: "image/jpeg" }] } },
  ]);
  assert.deepEqual(sessionImages(raw).map(i => [i.data.toString(), i.mimeType, i.role]), [["a", "image/png", "用户"], ["b", "image/jpeg", "工具"]]);
  assert.equal(parseSession("/x", raw, new Date(0))!.images, 2);
  const name = folderName({ id: "abcdef123456", created: "2026-09-23T08:00:00.000Z" }, '修复 a/b: "滚动"?.. ');
  assert.match(name, /^2026-09-2\d_修复 a b 滚动_abcdef12$/, "unsafe characters and trailing dots are removed");
});

test("server exports images to the chosen folder, keeps the folder after a rename, and only writes new files", async t => {
  const root = await temp(t), sessions = join(root, "sessions"), home = join(root, "data"), token = "e".repeat(32);
  await mkdir(join(sessions, "p"), { recursive: true });
  const file = join(sessions, "p", "a.jsonl"), pic = (id: string, parent: string, data: string) => ({ type: "message", id, parentId: parent, timestamp: "2026-09-23T08:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data, mimeType: "image/png" }] } });
  await writeFile(file, sessionFile("sess1234abcd", "/w", [["user", "截图问题"]], [pic("u1", "e0", "YQ==")]));
  await writeFile(join(sessions, "p", "b.jsonl"), sessionFile("noimages", "/w", [["user", "纯文字"]]));
  await writeFile(join(root, "index.html"), "");
  const location = new DataLocation(home, {});
  const server = new SessionsServer({ root: sessions, metaFile: join(home, "meta.json"), location, webFile: join(root, "index.html"), token });
  const base = new URL(await server.start()).origin;
  t.after(() => server.close());
  const call = (path: string, body?: object) => fetch(base + api(path), body ? { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { "x-token": token } });

  const list = await (await call("/api/sessions")).json();
  assert.deepEqual(Object.fromEntries(list.sessions.map((s: any) => [s.id, s.images])), { sess1234abcd: 1, noimages: 0 });
  assert.equal((await call("/api/storage/images", { dir: "relative" })).status, 400);
  const out = join(root, "我的图片");
  let st = await (await call("/api/storage/images", { dir: out })).json();
  assert.deepEqual([st.images.dir, st.images.isDefault, st.images.count, st.images.sessions], [out, false, 1, 1]);
  assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).imageDir, out, "remembered in config.json");

  let r = await (await call("/api/images/export", { ids: ["sess1234abcd"] })).json();
  const folder = r.folder as string;
  assert.match(folder, /截图问题_sess1234$/);
  assert.deepEqual([r.dir, r.sessions, r.images, r.written], [out, 1, 1, 1]);
  assert.equal(await readFile(join(folder, "001-用户.png"), "utf8"), "a");

  // Renamed and one more image: same folder, only the new file is written.
  await server.meta.patch("sess1234abcd", { title: "新标题" });
  await appendFile(file, JSON.stringify(pic("u2", "u1", "Yg==")) + "\n");
  r = await (await call("/api/images/export", {})).json();
  assert.deepEqual([r.sessions, r.images, r.written, r.folder], [1, 2, 1, folder]);
  assert.equal(await readFile(join(folder, "002-用户.png"), "utf8"), "b");

  st = await (await call("/api/storage/images", { dir: "" })).json();
  assert.equal(st.images.isDefault, true);
  assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).imageDir, undefined);
});

test("english pages: errors, transcript notes, ask reasons and exported file names follow x-lang", async t => {
  const root = await temp(t), sessions = join(root, "sessions"), token = "d".repeat(32);
  await mkdir(join(sessions, "p"), { recursive: true });
  const file = join(sessions, "p", "a.jsonl");
  const pic = { type: "message", id: "u1", parentId: "e0", timestamp: "2026-09-23T08:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "YQ==", mimeType: "image/png" }] } };
  const compacted = { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-23T08:06:00.000Z", summary: "earlier work" };
  await writeFile(file, sessionFile("sessEN12abcd", "/w", [["user", "scroll bug"]], [pic, compacted]));
  await writeFile(join(root, "index.html"), "");
  const location = new DataLocation(join(root, "data"), {});
  const server = new SessionsServer({ root: sessions, metaFile: join(root, "data", "meta.json"), location, webFile: join(root, "index.html"), token });
  const base = new URL(await server.start()).origin;
  t.after(() => server.close());
  const call = (path: string, lang: string, body?: object) => fetch(base + api(path), body
    ? { method: "POST", headers: { "x-token": token, "x-lang": lang, "content-type": "application/json" }, body: JSON.stringify(body) }
    : { headers: { "x-token": token, "x-lang": lang } });

  assert.equal((await (await call("/api/transcript?id=nope", "en")).json()).error, "Session not found; it may have been deleted");
  assert.equal((await (await call("/api/transcript?id=nope", "zh")).json()).error, "找不到这个会话，可能已被删除");
  assert.equal((await (await call("/api/storage/images", "en", { dir: "relative" })).json()).error, "Enter a full path, e.g. ~/Dropbox/pi-sessions");
  assert.equal((await (await call("/api/ask", "en", { query: "x" })).json()).error, "pi is switching sessions; try again in a moment");

  const en = await (await call("/api/transcript?id=sessEN12abcd", "en")).json();
  assert.equal(en.items.at(-1).title, "Context compacted");
  const zh = await (await call("/api/transcript?id=sessEN12abcd", "zh")).json();
  assert.equal(zh.items.at(-1).title, "上下文已压缩", "the cache keeps each language apart");

  const out = join(root, "images");
  await call("/api/storage/images", "en", { dir: out });
  const r = await (await call("/api/images/export", "en", { ids: ["sessEN12abcd"] })).json();
  assert.equal(await readFile(join(r.folder, "001-user.png"), "utf8"), "a");
  const again = await (await call("/api/images/export", "zh", { ids: ["sessEN12abcd"] })).json();
  assert.equal(again.written, 0, "exporting in the other language does not duplicate images");

  let prompt = "";
  const ctx = { model: { id: "m" }, modelRegistry: { complete: async (_m: unknown, req: any) => { prompt = req.systemPrompt; return { stopReason: "stop", content: [{ type: "text", text: '{"results":[]}' }] }; } } } as any;
  const records = [parseSession(file, await readFile(file, "utf8"), new Date())!];
  await askSessions(ctx, "scroll", records, {}, new AbortController().signal, new Date(), "en");
  assert.match(prompt, /reason 用英文写/);
  await askSessions(ctx, "scroll", records, {}, new AbortController().signal, new Date(), "zh");
  assert.doesNotMatch(prompt, /用英文写/);
});
