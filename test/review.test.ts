import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReview, commandKind, commandOk, patchStats } from "../src/review.ts";

let id = 0;
const entry = (o: object) => { const e = { id: `e${++id}`, parentId: id > 1 ? `e${id - 1}` : null, timestamp: `2026-10-02T10:00:${String(id).padStart(2, "0")}Z`, ...o }; return JSON.stringify(e); };
const user = (text: string) => entry({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const call = (callId: string, name: string, args: object, text = "") => entry({ type: "message", message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: callId, name, arguments: args }] } });
const result = (callId: string, name: string, text: string, isError = false, details?: object) => entry({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, details } });
const say = (text: string) => entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

const session = [
  JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-02T10:00:00Z", cwd: "/work/shop" }),
  user("npm test fails, fix cart.js"),
  call("c1", "bash", { command: "npm test 2>&1 | head -40" }),
  result("c1", "bash", "not ok 1 - total with a 10% discount\nℹ fail 1"),
  call("c2", "edit", { path: "/work/shop/cart.js", edits: [{ oldText: "return sum - d;", newText: "return sum * (1 - d / 100);" }] }),
  result("c2", "edit", "Successfully replaced 1 block", false, { patch: "--- /work/shop/cart.js\n+++ /work/shop/cart.js\n@@ -3,1 +3,1 @@\n-  return sum - d;\n+  return sum * (1 - d / 100);\n" }),
  call("c3", "write", { path: "/work/shop/NOTES.md", content: "# Notes\nfixed the discount" }),
  result("c3", "write", "Wrote 2 lines"),
  call("c4", "edit", { path: "/Users/x/.espressif/esp-idf/components/nvs/nvs.c", edits: [{ oldText: "a", newText: "b" }] }),
  result("c4", "edit", "ok"),
  call("c5", "bash", { command: "npm test 2>&1 | tail -5" }),
  result("c5", "bash", "ℹ pass 2\nℹ fail 0"),
  say("Fixed: the discount was subtracted as an amount instead of a percentage."),
  user("now flash the board"),
  entry({ type: "custom", customType: "pi-lab.ledger", data: { target: "M5StickS3", facts: [{ id: "F1", text: "reads zeros", evidence: "accel x=0.000", verified: true }], hypotheses: [{ id: "H1", text: "config upload order", status: "confirmed", evidence: "INTERNAL_STATUS=0x01" }] } }),
  call("c6", "board_flash", {}),
  result("c6", "board_flash", "Flashed /dev/cu.usbmodem101."),
  entry({ type: "custom", customType: "pi-lab.flash", data: { at: 1790846067651, command: "board_flash", fingerprint: "f8b6", source: "81b0ca5" } }),
  call("c7", "board_serial", { seconds: 6 }),
  result("c7", "board_serial", "accel x=-0.03 y=-0.01 z=0.99 |a|=0.99"),
  entry({ type: "message", message: { role: "bashExecution", command: "idf.py -p /dev/cu.usbmodem101 flash", output: "A fatal error occurred: Failed to connect", exitCode: 0 } }),
  say("Flashed and verified."),
].join("\n");

test("one task per question, with its changes, commands and checks", () => {
  const { cwd, tasks } = buildReview(session);
  assert.equal(cwd, "/work/shop");
  assert.equal(tasks.length, 2);
  const [fix, flash] = tasks;
  assert.equal(fix!.prompt, "npm test fails, fix cart.js");
  assert.equal(fix!.reply, "Fixed: the discount was subtracted as an amount instead of a percentage.");
  assert.deepEqual(fix!.files.map(f => [f.path, f.added, f.removed, f.written, f.outside]), [
    ["cart.js", 1, 1, false, false],
    ["NOTES.md", 2, 0, true, false],
    ["/Users/x/.espressif/esp-idf/components/nvs/nvs.c", 1, 1, false, true],
  ]);
  assert.deepEqual(fix!.commands.map(c => [c.kind, c.ok]), [["test", false], ["test", true]]);
  assert.deepEqual(fix!.checks, { passed: 1, failed: 1 });
  assert.equal(fix!.ledger, undefined);

  assert.equal(flash!.ledger?.hypotheses[0]?.status, "confirmed");
  assert.deepEqual(flash!.flashes, [{ at: 1790846067651, source: "81b0ca5" }]);
  assert.deepEqual(flash!.commands.map(c => [c.kind, c.tool, c.ok]), [["flash", "board_flash", true], ["serial", "board_serial", true], ["flash", "user", false]]);
});

test("command kinds", () => {
  assert.equal(commandKind("bash", "source ~/esp/export.sh && idf.py build 2>&1 | tail"), "build");
  assert.equal(commandKind("bash", "idf.py -p /dev/x flash monitor"), "flash");
  assert.equal(commandKind("bash", "pytest -q"), "test");
  assert.equal(commandKind("bash", "git commit -m x"), "git");
  assert.equal(commandKind("bash", "pip install pypdf"), "install");
  assert.equal(commandKind("bash", "ls -la"), "run");
});

test("checks fail on their output even with exit code 0", () => {
  assert.equal(commandOk("test", false, "Tests: 1 failed, 3 passed"), false);
  assert.equal(commandOk("test", false, "===== 2 failed, 10 passed in 0.3s ====="), false);
  assert.equal(commandOk("test", false, "ℹ pass 3\nℹ fail 0"), true);
  assert.equal(commandOk("build", false, "main.c:12:5: error: 'x' undeclared"), false);
  assert.equal(commandOk("build", false, "Project build complete."), true);
  assert.equal(commandOk("run", false, "error: whatever"), true, "only checks are judged by their output");
});

test("patch stats leave headers out", () => {
  assert.deepEqual(patchStats("--- a\n+++ b\n@@\n-x\n+y\n+z\n"), { added: 2, removed: 1 });
});

test("explanations are read from the model's JSON and kept in bounds", async () => {
  const { parseExplanation, explainPrompt } = await import("../src/explain.ts");
  const ex = parseExplanation('Sure!\n{"summary":"fixed the discount","cause":["subtracted as an amount"],"changes":[{"file":"cart.js","what":"multiply","why":"it is a percent"},{"why":"no file"}],"verified":["npm test failed","npm test passed"],"learn":[{"concept":"percent","plain":"x","here":"y"},{"concept":"a","plain":"b"},{"concept":"c","plain":"d"},{"concept":"e","plain":"f"}],"terms":[{"term":"LSB","meaning":"one unit of a reading"},{"term":"no meaning"}]}');
  assert.equal(ex.summary, "fixed the discount");
  assert.deepEqual(ex.cause, ["subtracted as an amount"]);
  assert.deepEqual(ex.changes, [{ file: "cart.js", what: "multiply", why: "it is a percent" }]);
  assert.deepEqual(ex.verified, ["npm test failed", "npm test passed"]);
  assert.equal(ex.learn.length, 3);
  assert.deepEqual(ex.terms, [{ term: "LSB", meaning: "one unit of a reading" }]);
  assert.throws(() => parseExplanation("no json here"));
  const { tasks } = buildReview(session);
  const prompt = JSON.parse(explainPrompt(tasks[0]!, "/work/shop"));
  assert.equal(prompt.question, "npm test fails, fix cart.js");
  assert.match(prompt.commands[0], /^FAILED \[test\]/);
  assert.equal(prompt.files[0].file, "cart.js");
});

test("a model that answers in the old shape still reads", async () => {
  const { parseExplanation } = await import("../src/explain.ts");
  const ex = parseExplanation('{"summary":"s","cause":"one long paragraph","changes":[{"file":"a.c","why":"w"}],"verified":"tests passed","learn":[{"concept":"c","explain":"old field"}]}');
  assert.deepEqual(ex.cause, ["one long paragraph"]);
  assert.deepEqual(ex.verified, ["tests passed"]);
  assert.equal(ex.learn[0]!.plain, "old field");
});
