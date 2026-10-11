# Recovery and verification

Relay stores the workspace independently of the terminal processes. Closing the window to the tray keeps the Rust runtime, PTYs, hook listener and rule scheduler running. A full quit, crash or reboot ends the application process; subsequent recovery starts new CLI processes using saved conversation identities.

## What is durable

`relay.sqlite3` in Relay's own application data directory contains groups, group collapse state, conversation order and membership, titles, selected tab, provider IDs, launch settings, notification bodies and dismissal state, rule configuration and schedule state. Metadata changes and authoritative conversation bindings are committed immediately. SQLite uses WAL mode and full synchronous writes; there is no 30-second layout-save window.

Tab IDs remain stable when their PTYs restart. A manual stop removes a tab from automatic startup; archiving also prevents automatic startup. The Auto resume setting controls recovery of previously running tabs.

Provider transcripts remain in Claude's or Codex's normal storage. Relay's database references their IDs; it is not a substitute for those transcripts. Back up provider history along with Relay's data directory. Quit Relay before copying the directory, or use a consistent SQLite backup that includes its WAL state. `RELAY_DATA_DIR` selects a separate data directory for development and isolated testing.

Terminal screen replay is bounded to 2 MiB per tab and lives in process memory. It survives frontend reloads while the native process remains alive. It is not a durable recording of every terminal byte across a reboot.

## Conversation recovery

**Claude Code:** Relay assigns a UUID before the first launch and passes `--session-id`. Subsequent launches use `--resume=<saved-id>` once a prompt, provider hook or matching transcript establishes the conversation. A tab created without a conversation can remain stopped after restart until explicitly started. Per-invocation hooks and a status-line command capture the provider's session ID, name, model and effort when the installed Claude CLI reports those fields. `/clear` can change the provider ID; authoritative hooks update the stored binding. Relay does not change global Claude settings.

**Codex:** Relay binds the full `thread-id` from Codex's turn-complete notification, then resumes with `codex resume <saved-id>`. The notification command receives a private per-tab connection-file path and stable tab ID, so delivery does not depend on a shared Codex daemon inheriting Relay's environment. For a bound conversation, exact-ID transcript metadata supplies model and effort updates when available.

**Codex's first-turn limit:** until the first completed-turn notification arrives, Relay has no authoritative Codex thread ID. A crash or reboot before that notification leaves the tab unbound. The provider may still have saved its transcript, but Relay will not choose one by directory or modification time. Supply its exact ID to recover it. Relay never substitutes `--last` or `--continue`.

Saved model and effort are passed explicitly when present; blank values initially use provider defaults. Live values are retained when authoritative provider hooks or the bound transcript report them. Stop a running session before editing its launch settings in Relay. These settings describe the next CLI launch and do not checkpoint the provider's runtime.

A missing or invalid saved conversation can fail to launch or resume. Relay preserves its identity and settings and reports the failure rather than silently replacing it with another conversation. A stored ID cannot restore history deleted from the provider's own storage.

**Shells and custom programs:** executable, arguments and working directory persist. Shell process memory, environment changes made inside the shell, foreground jobs and partially completed commands do not survive reboot. Shell tabs require a new process after restart. Custom agents need their own explicit resume integration; only Claude and Codex have built-in automatic conversation adapters.

## Notifications and rules

A notification stays in the inbox until explicit dismissal. Opening it selects its conversation and clears that conversation's unread indicator; opening is not dismissal. External notifications without a target tab create a dormant assistant conversation under Assistants, containing the notification's source, title and body. Starting that conversation passes its saved context to the agent.

Event deduplication and notification creation share a database transaction. Repeating a source's `dedupeKey` after restart does not create a second notification or assistant tab. Readiness and unread indicators follow hook events and user interaction; readiness alone does not establish that a task or its tests succeeded.

Rules run only while Relay's native process is running, including with its window hidden in the tray. An overdue reminder fires once on the next launch. Repeated rules catch up once and calculate the next run from the current time, avoiding a burst of every missed interval. Reminder notifications and schedule advancement commit together.

Command rules run an explicit program and argument array, with a 30-second timeout, a 1 MiB stdout limit and no overlapping runs of the same rule. Stdout must be a JSON event or event array. A crash during an external command does not preserve that process or guarantee a retry of that particular run; custom pollers should use stable notification deduplication keys. Rule failures retain the configuration and produce a local failure notification.

The event listener binds only to loopback, requires its random bearer token, rejects cross-site origins and non-local Host headers, and limits request bodies to 256 KiB. Publishing an event does not expose a command-execution endpoint. Hook mode runs before GUI initialization and does not open or focus a window.

## Reloading during development

Frontend changes under `src/relay/` use Vite hot reload. Terminal ownership stays in Rust. The frontend subscribes before requesting replay and discards already replayed output sequences, allowing it to reattach to existing PTYs without spawning duplicate agents.

Rust changes require rebuilding and restarting the native process. That is conversation recovery, rather than attachment to the old operating-system process. Use a separate `RELAY_DATA_DIR` for development; two running versions should not share the same database.

## Verification status

The following checks passed on Windows during development of Relay 0.1.0:

| Check | Result |
| --- | --- |
| Rust unit and integration tests | 13 passed |
| Frontend tests | 14 passed |
| Connector tests using fake endpoints | 12 passed |
| Native Rust compilation and debug build | Passed |
| Real Windows ConPTY output and bounded replay | Passed; the startup cursor handshake works without a mounted frontend terminal |
| Frontend reload attachment to a native PTY | Passed in the native application |
| Window close and reopen | Passed: the OS close event hid to tray, the PTY stayed alive, and a second launch reopened the same instance |
| Notification creation and deduplication across forced application restarts | Passed |
| Reminder persistence and one-time delivery across restart | Passed |
| Selected conversation and notification dismissal after force-kill | Passed |
| Windows release packaging | Produced an unsigned NSIS development installer |
| Live Claude Code 2.1.296 conversation recovery | Passed with Sonnet and low effort: actual response, exact ID, model/effort, title, group and selection survived a forced app restart; a second turn recalled the earlier test phrase |
| Live Codex 0.162.1 conversation recovery | Passed with gpt-6-astra and xhigh effort: native notify bound the full thread ID, exact ID/model/effort/group/selection survived a forced app restart, and a second turn recalled a unique test phrase and delivered another ready notification |

Rust tests also cover database reopen, transaction rollback, durable event deduplication, exact resume arguments, provider payload mapping, hook authentication, conversation-binding uniqueness, assistant notification context, repeated-rule scheduling, and timeout enforcement when a command closes stdout before exiting.

The live Claude and Codex checks used the installed, authenticated CLIs in isolated working folders with harmless two-turn memory checks and no agent tool actions. macOS is configured as a build target but has not yet been built or tested in this workspace. Windows results should not be treated as macOS verification. A forced process restart was tested; the laptop itself was not rebooted.

Re-run the Windows application smoke check with `node scripts/smoke-native.mjs` (debug build plus the Vite server), or set `RELAY_QA_BINARY=src-tauri/target/release/relay.exe` to test the packaged application. `node scripts/smoke-claude.mjs` and `node scripts/smoke-codex.mjs` are opt-in live provider checks: each requires its authenticated CLI and uses two short model turns. Native and Claude tests use separate directories under `.relay-test/`. The Codex test uses a fresh Windows temporary directory outside the source repository so a folder-trust decision cannot apply to the source repository. All leave your normal Relay workspace untouched.
