import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeSession } from "../src/adapters.ts";
import { SessionScanner, parseSession, readSession } from "../src/scan.ts";
import { buildTranscript, findImage } from "../src/transcript.ts";
import { buildReview } from "../src/review.ts";
import { SessionsServer } from "../src/server.ts";
import { exportImages } from "../src/export.ts";
import { localPaths, externalRoots, configuredPiDir } from "../src/local.ts";
import { parseOptions } from "../src/cli.ts";
import { resumeArgs, resumeCommand, launchSession } from "../src/launch.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const TIME = "2026-10-13T19:00:00.000Z";
const PNG = "iVBORw0KGgo=";
const jsonl = (all: object[]) => all.map(e => JSON.stringify(e)).join("\n") + "\n";
const claudeEntry = (type: string, uuid: string, parentUuid: string | null, message: object, extra = {}) =>
  ({ type, uuid, parentUuid, message, sessionId: ID, cwd: "/work/demo", timestamp: TIME, ...extra });
const claudeLog = () => jsonl([
  { type: "permission-mode", sessionId: ID, permissionMode: "default" },
  claudeEntry("user", "u", null, { content: [{ type: "text", text: "修复缓存 cache" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }),
  claudeEntry("assistant", "a", "u", { model: "claude-sonnet", content: [{ type: "thinking", thinking: "检查缓存" }, { type: "tool_use", id: "call", name: "Bash", input: { command: "npm test" } }] }),
  claudeEntry("user", "r", "a", { content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "Tests: 1 failed" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }], is_error: true }] }),
  claudeEntry("assistant", "abandoned", "r", { content: [{ type: "text", text: "旧的分支" }] }),
  claudeEntry("assistant", "done", "r", { content: [{ type: "text", text: "修复完成" }] }),
  claudeEntry("assistant", "sub", "done", { content: [{ type: "text", text: "子代理" }] }, { isSidechain: true }),
  { type: "custom-title", sessionId: ID, customTitle: "缓存修复" },
]);
const codexLog = () => jsonl([
  { type: "session_meta", payload: { id: ID, cwd: "/work/demo", timestamp: TIME } },
  { type: "response_item", timestamp: TIME, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/demo\nContext" }] } },
  { type: "response_item", timestamp: TIME, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复缓存 cache" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] } },
  { type: "event_msg", timestamp: TIME, payload: { type: "user_message", message: "修复缓存 cache" } },
  { type: "turn_context", timestamp: TIME, payload: { model: "codex-model" } },
  { type: "response_item", timestamp: TIME, payload: { type: "function_call", name: "functions.exec_command", call_id: "call", arguments: JSON.stringify({ cmd: "npm test" }) } },
  { type: "response_item", timestamp: TIME, payload: { type: "function_call_output", call_id: "call", output: JSON.stringify({ output: "Tests: 1 failed", exit_code: 1 }) } },
  { type: "response_item", timestamp: TIME, payload: { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: "*** Begin Patch\n*** Update File: src/cache.ts\n@@\n-old\n+new\n*** End Patch" } },
  { type: "response_item", timestamp: TIME, payload: { type: "custom_tool_call_output", call_id: "patch", output: "Success. Updated src/cache.ts" } },
  { type: "response_item", timestamp: TIME, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "修复完成" }] } },
  { type: "event_msg", timestamp: TIME, payload: { type: "agent_message", message: "修复完成" } },
]);
const piLog = () => jsonl([
  { type: "session", id: ID, cwd: "/work/demo", timestamp: TIME },
  { type: "message", id: "u", parentId: null, timestamp: TIME, message: { role: "user", content: "修复缓存 cache" } },
]);
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "local-sessions-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths({ PI_CODING_AGENT_DIR: join(root, "pi"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") });
  const files = [join(paths.pi, "--demo--", "s.jsonl"), join(paths.claude, "-work-demo", "s.jsonl"), join(paths.codex, "2026", "10", "13", "s.jsonl")];
  for (const file of files) await mkdir(join(file, ".."), { recursive: true });
  await Promise.all(files.map((file, n) => writeFile(file, [piLog(), claudeLog(), codexLog()][n])));
  return { root, paths, files, scanner: new SessionScanner(async () => [paths.pi], async () => externalRoots(paths)) };
}

test("Claude keeps the active main branch, pairs tool results, and retains images", () => {
  const raw = normalizeSession(claudeLog(), "claude"), record = parseSession("/s", raw, new Date())!;
  assert.equal(record.id, ID); assert.equal(record.name, "缓存修复"); assert.equal(record.model, "claude-sonnet");
  assert.equal(record.firstUser, "修复缓存 cache"); assert.equal(record.images, 2);
  const items = buildTranscript(raw);
  assert.equal(items.filter(i => i.kind === "user").length, 1, "tool results are not user prompts");
  assert.ok(!items.some(i => i.text.includes("旧的分支") || i.text.includes("子代理")));
  const assistant = items.find(i => i.kind === "assistant" && i.tools.length)!;
  assert.equal(assistant.kind, "assistant");
  if (assistant.kind === "assistant") {
    assert.equal(assistant.thinking, "检查缓存"); assert.equal(assistant.tools[0].name, "bash");
    assert.equal(assistant.tools[0].isError, true); assert.equal(assistant.tools[0].images?.length, 1);
  }
  assert.deepEqual(findImage(raw, "u", 0)?.data, Buffer.from(PNG, "base64"));
  const review = buildReview(raw);
  assert.equal(review.tasks.length, 1); assert.equal(review.tasks[0].checks.failed, 1);
});

test("Claude summary survives compaction, and late titles do not shift image references", () => {
  const base = claudeLog().split("\n").filter(l => !l.includes('"custom-title"')).join("\n");
  const before = findImage(normalizeSession(base, "claude"), "u", 0);
  assert.deepEqual(findImage(normalizeSession(claudeLog(), "claude"), "u", 0), before);
  const compact = base + jsonl([
    claudeEntry("system", "boundary", null, {}, { subtype: "compact_boundary" }),
    claudeEntry("user", "summary", "boundary", { content: "前面的摘要" }, { isCompactSummary: true, isMeta: true }),
    claudeEntry("user", "next", "summary", { content: "继续" }),
  ]);
  const items = buildTranscript(normalizeSession(compact, "claude"));
  assert.ok(items.some(i => i.kind === "note" && i.text === "前面的摘要"));
  assert.deepEqual(items.filter(i => i.kind === "user").map(i => i.text), ["继续"]);
});

test("Codex de-duplicates event mirrors, separates injected context, and reviews commands/patches", () => {
  const raw = normalizeSession(codexLog(), "codex"), record = parseSession("/s", raw, new Date())!;
  assert.equal(record.firstUser, "修复缓存 cache"); assert.equal(record.model, "codex-model");
  const items = buildTranscript(raw);
  assert.equal(items.filter(i => i.kind === "user").length, 1);
  assert.equal(items.filter(i => i.kind === "assistant" && i.text === "修复完成").length, 1);
  assert.ok(items.some(i => i.kind === "note" && i.text.startsWith("# AGENTS.md")));
  assert.equal(record.images, 1);
  const task = buildReview(raw).tasks[0];
  assert.equal(task.checks.failed, 1); assert.equal(task.commands[0].command, "npm test");
  assert.equal(task.files[0].path, "src/cache.ts"); assert.equal(task.files[0].added, 1); assert.equal(task.files[0].removed, 1);
});

test("Codex older event-only logs remain readable and encrypted reasoning is not fabricated", () => {
  const raw = jsonl([
    { type: "session_meta", payload: { id: ID, cwd: "/work", timestamp: TIME } },
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "secret", summary: [] } },
    { type: "event_msg", payload: { type: "agent_message", message: "world" } },
    { type: "compacted", payload: { message: "Summary" } },
  ]);
  const items = buildTranscript(normalizeSession(raw, "codex"));
  assert.deepEqual(items.map(i => i.text), ["hello", "world", "Summary"]);
  assert.equal(normalizeSession("bad json\n", "codex"), "");
});

test("multi-source scanner handles native directory depths, collisions, changes and symlinks", async t => {
  const { paths, files, root, scanner } = await fixture(t);
  const first = await scanner.scan();
  assert.deepEqual(first.map(r => r.id).sort(), [ID, `claude:${ID}`, `codex:${ID}`].sort());
  assert.equal(first.find(r => r.source === "codex")?.nativeId, ID);
  assert.equal((await scanner.scan())[0], first[0], "unchanged logs use the cache");
  assert.equal(await scanner.owns(files[1]), false, "pi switching cannot target another source");
  await appendFile(files[1], jsonl([{ type: "custom-title", sessionId: ID, customTitle: "新标题" }]));
  assert.equal((await scanner.scan()).find(r => r.source === "claude")?.name, "新标题");
  await mkdir(paths.codexArchive, { recursive: true });
  await writeFile(join(paths.codexArchive, "archived.jsonl"), codexLog());
  assert.equal((await scanner.scan()).filter(r => r.source === "codex").length, 1, "duplicates are not separate sessions");
  await mkdir(join(paths.claude, "project", "subagents"), { recursive: true });
  await writeFile(join(paths.claude, "project", "subagents", "sub.jsonl"), claudeLog());
  await symlink(join(root, "missing"), join(paths.pi, "link"));
  assert.equal((await scanner.scan()).length, 3);
});

test("independent HTTP manager reads/organizes all sources without touching original logs", async t => {
  const { root, paths, files } = await fixture(t);
  const originals = await Promise.all(files.map(p => readFile(p, "utf8")));
  const web = join(root, "index.html"); await writeFile(web, "local sessions");
  const opened: string[] = [];
  const server = new SessionsServer({ root: paths.pi, sources: externalRoots(paths), standalone: true,
    metaFile: join(root, "meta.json"), webFile: web, token: "c".repeat(32), port: 0,
    openSession: async r => { opened.push(r.source!); return { ok: true, message: "opened" }; },
  });
  const url = await server.start(); t.after(() => server.close());
  const base = new URL(url).origin;
  const call = (p: string, body?: object) => fetch(base + "/api/sessions/" + p, { headers: { "x-token": "c".repeat(32), "x-lang": "en", "content-type": "application/json" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const list = await (await call("sessions")).json();
  assert.equal(list.connected, true); assert.equal(list.capabilities.ai, false); assert.equal(list.sessions.length, 3);
  assert.ok(list.sessions.every((s: any) => !s.capabilities.delete && !s.capabilities.nativeRename));
  assert.equal((await fetch(base + "/api/sessions/sessions")).status, 401);
  assert.equal((await call("open", { id: "../other" })).status, 404);
  for (const s of list.sessions) {
    await call("meta", { id: s.id, title: s.source, pinned: true, archived: true, tags: [s.source] });
    const tx = await (await call("transcript?id=" + encodeURIComponent(s.id))).json(); assert.ok(tx.items.length);
    const review = await (await call("review?id=" + encodeURIComponent(s.id))).json(); assert.equal(review.tasks.length, 1);
    assert.equal((await call("open", { id: s.id })).status, 200);
    assert.ok((await (await call("resume-command?id=" + encodeURIComponent(s.id))).json()).command.includes(s.source === "claude" ? "--resume" : s.source === "codex" ? "resume" : "--session"));
  }
  assert.deepEqual(opened.sort(), ["claude", "codex", "pi"]);
  const after = await (await call("sessions")).json();
  assert.ok(after.sessions.every((s: any) => s.meta.title === s.source && s.meta.pinned && s.meta.archived));
  assert.equal((await (await call("search?q=cache")).json()).hits.length, 3);
  const img = buildTranscript(normalizeSession(claudeLog(), "claude")).find(i => i.kind === "user")!;
  if (img.kind === "user") {
    const result = await call(`image?id=claude%3A${ID}&entry=${encodeURIComponent(img.images[0].entry)}&n=0`);
    assert.equal(result.headers.get("content-type"), "image/png"); assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from(PNG, "base64"));
  }
  const deleted = await (await call("delete", { ids: list.sessions.map((s: any) => s.id) })).json();
  assert.deepEqual(deleted.deleted, []); assert.equal(deleted.skipped.length, 3);
  assert.equal((await call("ask", { query: "cache" })).status, 503);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, "utf8"))), originals);
});

test("foreign records never reach the pi rename/switch binding; pi records retain their binding", async t => {
  const { root, paths, files } = await fixture(t);
  const renamed: string[] = [], opened: string[] = [];
  const server = new SessionsServer({ root: paths.pi, sources: externalRoots(paths), metaFile: join(root, "meta.json"), webFile: "",
    token: "d".repeat(32), openSession: async r => { opened.push(r.source!); return { ok: true, message: "new terminal" }; } });
  server.binding = { currentSessionFile: () => undefined, model: () => undefined, rename: async p => { renamed.push(p); }, open: async p => { opened.push(p); return { ok: true, message: "pi" }; } };
  await server.start(); t.after(() => server.close());
  const call = (path: string, body: object) => server.handle({ method: "POST", path, query: new URLSearchParams(), headers: {}, signal: new AbortController().signal, json: async () => body } as any);
  await call("/meta", { id: `claude:${ID}`, title: "local" });
  await call("/meta", { id: ID, title: "native" });
  assert.deepEqual(renamed, [files[0]]);
  await call("/open", { id: `codex:${ID}` }); await call("/open", { id: ID });
  assert.deepEqual(opened, ["codex", files[0]]);
});

test("exported image folders separate providers even when native IDs match", async t => {
  const { root, scanner } = await fixture(t);
  const records = await scanner.scan(), dir = join(root, "images");
  const one = await exportImages(records.map(record => ({ record, title: "cache" })), dir);
  assert.equal(one.sessions, 2); assert.equal(one.written, 3);
  const two = await exportImages(records.map(record => ({ record, title: "renamed" })), dir, "en");
  assert.equal(two.written, 0);
});

test("local roots honor home overrides and pi settings without reading credentials", async t => {
  const { root } = await fixture(t), settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ sessionDir: ".pi/sessions" }));
  assert.equal(await configuredPiDir(settings, {}, root), join(root, ".pi/sessions"));
  assert.equal(await configuredPiDir(settings, { PI_CODING_AGENT_SESSION_DIR: join(root, "override") }, root), join(root, "override"));
  assert.equal(await configuredPiDir(join(root, "missing"), {}), undefined);
});

test("resume arguments are source-specific and hostile paths are shell-quoted", async () => {
  const record = parseSession("/tmp/a'b $(touch nope).jsonl", piLog(), new Date())!;
  record.cwd = "/tmp/project's `echo nope`";
  assert.deepEqual(resumeArgs(record), { command: "pi", args: ["--session", record.path] });
  assert.match(resumeCommand(record), /'\\''/);
  const claude = { ...record, source: "claude" as const, nativeId: ID };
  assert.deepEqual(resumeArgs(claude), { command: "claude", args: ["--resume", ID] });
  assert.match(resumeCommand(claude, undefined, "win32"), /Set-Location -LiteralPath '.*project''s/);
  assert.throws(() => resumeArgs({ ...claude, nativeId: "--dangerously-skip-permissions" }), /Invalid stored/);
  const result = await launchSession(record, "en");
  assert.equal(result.ok, false); assert.match(result.message, /folder is missing/);
});

test("standalone CLI validates options and the webpage script parses", async () => {
  assert.deepEqual(parseOptions(["--port", "0", "--no-open", "--data-dir", "/tmp/meta"]), { open: false, port: 0, data: "/tmp/meta" });
  assert.throws(() => parseOptions(["--port", "65536"]));
  assert.throws(() => parseOptions(["--claude-dir"]));
  assert.throws(() => parseOptions(["--remote", "example.com"]));
  assert.throws(() => parseOptions(["--data-dir", "relative"]));
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
});

test("standalone process stays alive, serves history, and shuts down on SIGTERM", async t => {
  const { root, paths } = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/agent-sessions.mjs", import.meta.url)), "--no-open", "--port", "0", "--data-dir", join(root, "metadata")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: paths.agent, CLAUDE_CONFIG_DIR: join(paths.claude, ".."), CODEX_HOME: join(paths.codex, "..") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("CLI did not start")), 5000);
    child.once("error", e => { clearTimeout(timeout); reject(e); });
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const hit = output.match(/http:\/\/\S+/);
      if (hit) { clearTimeout(timeout); resolve(hit[0]); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`CLI exited before startup: ${code}`)); });
  });
  const parsed = new URL(url), token = parsed.hash.slice("#token=".length);
  const list = await (await fetch(parsed.origin + "/api/sessions/sessions", { headers: { "x-token": token } })).json();
  assert.equal(list.sessions.length, 3);
  const closed = once(child, "exit"); child.kill("SIGTERM");
  const [code] = await closed; assert.equal(code, 0);
});

test("resume command passes hostile filenames as literals without command substitution", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "project's folder"); await mkdir(cwd);
  const record = parseSession("/tmp/$(touch injected-marker)'x.jsonl", piLog(), new Date())!;
  record.cwd = cwd;
  const { stdout } = await promisify(execFile)("sh", ["-c", resumeCommand(record, "/bin/echo", "linux")]);
  assert.equal(stdout.trim(), `--session ${record.path}`);
  await assert.rejects(readFile(join(cwd, "injected-marker")), /ENOENT/);
});
