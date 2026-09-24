import { appendFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Appends a `session_info` entry so pi's own /resume shows the new name.
 * Only for sessions that are not open in this pi process (use pi.setSessionName for the current one).
 */
export async function appendSessionName(path: string, name: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  let parentId: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.type !== "session" && typeof e.id === "string") parentId = e.id; } catch {}
  }
  const entry = { type: "session_info", id: randomBytes(4).toString("hex"), parentId, timestamp: new Date().toISOString(), name: name.replace(/[\r\n]+/g, " ").trim() };
  await appendFile(path, (raw.endsWith("\n") || !raw ? "" : "\n") + JSON.stringify(entry) + "\n");
}
