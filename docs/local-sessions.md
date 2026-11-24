# Local session adapters

## Entrypoints and boundaries

`bin/agent-sessions.mjs` registers the packaged tsx runtime, then calls `src/cli.ts`.
It runs without pi installed. `index.ts` remains the pi extension entrypoint.
Both use `SessionsServer` and the same local metadata and token locations.
No API for cloud or remote session history is used.

The standalone server owns a keepalive reference because the shared pi-web hub unrefs its HTTP listener.
SIGINT/SIGTERM close the server and release the reference. The shared `src/hub.ts` uses protocol version 3,
adding an optional static-asset handler for the bundled Markdown, sanitizer and code-highlighting libraries.
Vendor files are served locally; conversation APIs remain token protected. Older pi-web apps can still
mount without an asset handler. Keep shared hub copies synchronized when updating other packages.

## Data contract

- `SessionRecord.source`: `pi`, `claude`, or `codex`.
- `SessionRecord.nativeId`: original runtime ID, used only for resume.
- `SessionRecord.id`: original ID for pi, `claude:<nativeId>` or `codex:<nativeId>` otherwise.
- Keeping pi keys unchanged preserves existing metadata, explanations and pi-web deep links.
- `SessionScanner.locations()` describes source roots and directory depths; `owns()` still only accepts pi switch targets.
- Adapters normalize logs in memory into the internal pi event shape; source files are never converted on disk.
- Image entry keys derive from Claude UUIDs or Codex record ordinals/positions, so title changes do not shift references.

Claude Code roots are scanned one directory below projects, excluding nested subagent logs.
The last main-chain UUID selects the active branch; tool results are not new user questions.
Compaction summaries are notes, including summaries marked as metadata.

Codex sessions and archived_sessions are scanned three directories below the root.
`response_item` messages take precedence over mirrored `event_msg` messages; event-only older logs are supported.
Injected AGENTS/environment messages are displayed as context notes rather than used as session titles.
Only available reasoning summaries and inline data-URL images are shown; encrypted reasoning is not reconstructed,
and remote images are not downloaded. Logs in archived_sessions remain browsable; native archive status is independent of manager archive state.

## Actions and capabilities

`GET /api/sessions/sessions` includes global `capabilities.ai`/`standalone` and per-record
`capabilities.delete`/`nativeRename`. The webpage hides unsupported actions; the server also enforces source boundaries.
All routes remain protected by the local hub's token and loopback Host checks.

`GET /api/sessions/resume-command?id=<managerId>` returns a copyable command.
`POST /api/sessions/open` dispatches to the live pi binding for pi records when available,
otherwise to the local terminal launcher. Claude Code and Codex never reach the pi switch or rename binding.
External resume IDs must be UUIDs. Shell arguments and project paths are quoted; subprocess APIs carry AppleScript arguments,
and no saved permissions or approval settings are overridden.

Standalone metadata actions never modify logs and standalone deletion is disabled.
The pi entry retains native title writes and trash-based deletion for pi records, skipping its bound active session.
Claude Code/Codex support metadata rename/archive only, with deletion disabled.
AI actions remain explicit operations through the pi model binding; standalone mode exposes no model provider.

Review shares command classification and recorded edit evidence. Claude Bash/Edit/Write and Codex exec_command/apply_patch
are adapted; calls hidden inside scripts or code-mode orchestration remain generic tool calls.
Write records show written content, not a reconstructed diff against an unrecorded previous file.
Apply-patch deletions without recorded content cannot report removed-line counts.

## Validation

Run `npm run check` and `npm test`. Local tests cover formats, branches, compaction, duplicate events, collisions,
image exports, source-bound action dispatch, HTTP authorization, original-log preservation,
shell quoting and standalone process lifetime.
`npm pack --dry-run` checks published artifacts; a production-only install must be able to run `agent-sessions --help` without pi.

Browser QA uses synthetic local logs, never restores a user's live historical session.
macOS terminal launching depends on the operating system's automation permissions;
Linux launching is best effort and Windows offers a copied PowerShell command.
