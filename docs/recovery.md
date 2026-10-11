# Recovery and verification

Relay stores the workspace independently of the terminal processes. Closing the window to the tray keeps the Rust runtime, PTYs, hook listener and rule scheduler running. A full quit, crash or reboot ends the application process. On the next launch all saved tabs remain dormant, including the previously selected tab; selecting a tab starts only its shell or saved conversation.

## What is durable

`relay.sqlite3` in Relay's own application data directory contains groups, group collapse state, conversation order and membership, titles, selected tab, provider IDs, launch settings, notification bodies and dismissal state, rule configuration and schedule state. Metadata changes and authoritative conversation bindings are committed immediately. SQLite uses WAL mode and full synchronous writes; there is no 30-second layout-save window.

Tab IDs remain stable when their PTYs restart. Archiving prevents implicit selection and recovery. Startup never resumes background tabs. Old workspaces migrate without losing their IDs, groups, messages or settings; an existing workspace with conversations skips folder setup. An empty original Workspace group becomes Group 1, while custom group names remain unchanged.

On first use choose a working folder once. Relay opens a default shell in Group 1; new tabs open shells at that saved folder. Type `cd`, `claude`, `claude-code` or `codex` as usual. Scoped shell functions add Relay's provider hooks while preserving arguments and the provider's default model/effort on a fresh launch. PowerShell, Bash and Zsh are supported. Their profiles are loaded without modifying profile or global provider configuration files. Provider utilities such as help/version/login/update leave the saved conversation association intact.

Each shell-owned tab saves its current shell folder separately from its last agent launch folder. An agent exit returns to the same interactive shell. A later `cd` changes the shell folder without changing that conversation's saved resume folder. Selecting a dormant bound tab opens the shell and resumes the exact agent conversation; the shell remains available after the agent exits. Starting a fresh agent command replaces the tab's prior conversation association, rather than inheriting its old ID, model or effort.

Provider transcripts remain in Claude's or Codex's normal storage. Relay's database references their IDs; it is not a substitute for those transcripts. Back up provider history along with Relay's data directory. Quit Relay before copying the directory, or use a consistent SQLite backup that includes its WAL state. `RELAY_DATA_DIR` selects a separate data directory for development and isolated testing.

Terminal screen replay is bounded to 2 MiB per tab and lives in process memory. It survives frontend reloads while the native process remains alive. It is not a durable recording of every terminal byte across a reboot.

## Conversation recovery

**Claude Code:** Relay assigns a UUID before the first launch and passes `--session-id`. Subsequent launches use `--resume=<saved-id>` once a prompt, provider hook or matching transcript establishes the conversation. A tab created without a conversation can remain stopped after restart until explicitly started. Per-invocation hooks and a status-line command capture the provider's session ID, name, model and effort when the installed Claude CLI reports those fields. `/clear` can change the provider ID; authoritative hooks update the stored binding. Relay does not change global Claude settings.

**Codex:** Relay binds the full `thread-id` from Codex's turn-complete notification after verifying the matching turn in its durable root transcript, then resumes with `codex resume <saved-id>`. Internal title-generator notifications cannot replace that binding. The notification command receives a private per-tab connection-file path and stable tab ID, so delivery does not depend on a shared Codex daemon inheriting Relay's environment. For a bound conversation, exact-ID transcript metadata supplies model and effort updates, and the provider's session index supplies its generated title when available.

**Codex's first-turn limit:** until the first completed-turn notification arrives, Relay has no authoritative Codex thread ID. A crash or reboot before that notification leaves the tab unbound. The provider may still have saved its transcript, but Relay will not choose one by directory or modification time. Supply its exact ID to recover it. Relay never substitutes `--last` or `--continue`.

Saved model and effort are passed explicitly when restoring a bound conversation; a fresh shell command initially uses provider defaults unless the command supplies its own flags. Live values are retained when authoritative provider hooks or the bound transcript report them. Claude status-line metadata captures `/model` and `/effort` changes. Codex records the effective settings in its next turn; a selection changed without another turn may not yet be visible to Relay. These settings describe the next exact restore and do not checkpoint the provider's runtime.

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

Rust changes require rebuilding and restarting the native process. Saved tabs then remain dormant until selected; they cannot attach to the old operating-system process. Use a separate `RELAY_DATA_DIR` for development. Overrides use a separate single-instance key, so isolated QA can run beside the default workspace; two running versions should not share the same database.

## Verification status

The following checks passed on Windows during development of Relay 0.1.0:

| Check | Result |
| --- | --- |
| Rust unit and integration tests | 22 passed for the shell-first runtime, including setup migration, lazy restore, separate shell/provider folders, stale transcript protection and hidden Codex title-thread exclusion |
| Frontend tests | 18 passed |
| Source startup tests | 2 passed |
| Connector tests using fake endpoints | 12 passed |
| Native Rust compilation and debug build | Passed |
| Real Windows ConPTY output and bounded replay | Passed; the startup cursor handshake works without a mounted frontend terminal |
| Frontend reload attachment to a native PTY | Passed in the native application |
| Window close and reopen | Passed: the OS close event hid to tray, the PTY stayed alive, and a second launch reopened the same instance |
| Notification creation and deduplication across forced application restarts | Passed |
| Reminder persistence and one-time delivery across restart | Passed |
| Selected conversation and notification dismissal after force-kill | Passed |
| Windows release packaging | Produced an unsigned NSIS development installer |
| Shell-first Windows lifecycle | Passed 13 checks: folder setup, inline rename, immediate shell tabs, saved shell folder, HMR attachment, tray behavior, durable inbox/rules and lazy restore |
| Live Claude Code 2.1.296 conversation recovery | Passed 13 checks after typing `claude-code` in PowerShell with provider defaults: actual response, exact ID, model/effort, title and group survived a forced app restart; clicking the saved tab resumed it, and a second turn recalled the earlier test phrase |
| Live Codex 0.162.1 conversation recovery | Passed 13 checks after typing `codex` in PowerShell with provider defaults: exact ID/model/effort/title/group survived a forced app restart, clicking the saved tab resumed it, and a second turn recalled a unique test phrase; background title notifications left its identity intact |

Rust tests also cover database reopen, transaction rollback, durable event deduplication, exact resume arguments, provider payload mapping, hook authentication, conversation-binding uniqueness, assistant notification context, repeated-rule scheduling, and timeout enforcement when a command closes stdout before exiting.

The live Claude and Codex checks used the installed, authenticated CLIs in isolated working folders with harmless two-turn memory checks and no agent tool actions. macOS is configured as a build target but has not yet been built or tested in this workspace. Windows results should not be treated as macOS verification. A forced process restart was tested; the laptop itself was not rebooted.

Re-run the Windows application smoke check with `node scripts/smoke-native.mjs` (debug build plus the Vite server), or set `RELAY_QA_BINARY=src-tauri/target/release/relay.exe` to test the packaged application. `node scripts/smoke-claude.mjs` and `node scripts/smoke-codex.mjs` are opt-in live provider checks: each requires its authenticated CLI and uses two short model turns. All three use fresh Windows temporary directories outside the source repository, so a folder-trust decision cannot apply to the source repository. They leave your normal Relay workspace untouched.
