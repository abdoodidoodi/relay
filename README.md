# Relay

A local terminal workspace for Claude Code, Codex, shells and side agents. Groups and conversations stay where you left them. Notifications have a durable inbox and their own conversations.

Relay is an MIT-licensed, focused fork of [Agentrium](https://github.com/talayash/agentrium), based on commit `f6586d866d64980484d03e649b25fa1ed827a3ba`. It uses Tauri, Rust, SQLite and xterm.js. It uses the operating system's webview rather than bundling Chromium. The active application has no Relay account, telemetry, sync server, or subscription. Your agent CLIs use their own existing authentication.

## Run from a clone

Install Node.js 22 LTS, the stable Rust toolchain, and the platform prerequisites from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/). Windows needs Visual Studio 2022 C++ Build Tools with **Desktop development with C++**, plus the WebView2 Runtime. macOS needs Xcode Command Line Tools. Install and authenticate the agent CLI you plan to use separately.

Clone the Relay repository once, then start it from that folder:

```sh
git clone https://github.com/abdoodidoodi/relay.git
cd relay
npm start
```

The first `npm start` installs the locked JavaScript dependencies when needed and builds/opens Relay in desktop development mode. Later runs reuse them; after a `git pull` changes the package manifest or lockfile, `npm start` refreshes dependencies with `npm ci`. Relay does not install Rust, C++ build tools, or other system compilers for you. Run `npm run doctor` for Node, Rust, and macOS Command Line Tools checks; on Windows, the doctor command also points to the full Tauri prerequisite list.

The first launch asks for your working folder once. Relay then opens **Group 1** with a shell. Click the group name to rename it; click **+** beside the group to open another shell. In a shell, change to a project folder and run `claude`, `claude-code`, or `codex`. Relay's scoped command wrappers bind those agent launches and their lifecycle hooks to the current tab automatically. Install and authenticate the CLI you want to use separately; its own trust and permission prompts still apply.

To make a local production bundle yourself, run `npm run desktop:build`. This creates a Windows NSIS installer or macOS DMG for the current host under `src-tauri/target/release/bundle/`. The repository's CI validates source on Windows and macOS but does not publish downloadable installers.

## What it does

- One sidebar, groups, titled conversation tabs, drag between groups, rename and archive.
- Real interactive terminal input, ANSI rendering, resizing, search, live activity and readiness indicators.
- SQLite-backed groups, ordering, selected tab, session IDs, model/effort, rules and notification state.
- Closing the window can leave the application and agents running in the tray. Reopening brings the same window back.
- After a full quit or machine restart, resume identified Claude/Codex conversations by exact saved ID when you click a tab.
- A notification stays in the inbox until you dismiss it. External notifications create assistant conversations containing their source context.
- Background reminders, interval rules, webhook events and command pollers. Rules run locally while Relay is running, including with its window closed to the tray.
- Per-session Claude hooks and a Codex turn-complete hook, a local event endpoint, provider poller examples and an optional MCP bridge.

## Recovery behavior

A reboot terminates running processes, so Relay cannot checkpoint an operating-system process or continue an interrupted tool action automatically. After Relay reopens, saved tabs appear without starting every agent. Click a tab to lazily resume that exact saved conversation with its working folder and provider state; Relay does not guess with `--last` or `--continue`.

Relay saves metadata on committed changes, rather than waiting for a periodic layout snapshot. Claude sessions are assigned an ID before launch. Claude's status-line integration captures live model, effort and session name when the installed CLI reports those fields. Relay does not modify your global Claude settings. Codex's notification adapter captures its authoritative thread ID on a completed turn. An unbound or missing conversation is surfaced instead of guessing with `--last` or `--continue`.

Provider transcripts remain in the provider's normal local storage. Keep those files along with Relay's database when backing up. Deleting provider history can make a stored ID impossible to resume. Ordinary shell tabs reopen as shells; their in-memory state cannot survive a reboot.

See [the recovery and validation notes](docs/recovery.md) for practical limits and the test matrix.

## Notifications and side agents

[Integration guide](docs/integrations.md) includes Gmail unread, Slack mention/DM and Google Calendar examples, local notification publishing, and an MCP bridge. Providers need credentials you supply; Relay does not silently connect your accounts. Google examples support refresh credentials. Nothing in the bundled pollers sends mail or messages.

A command rule runs an explicit program and argument array without a shell. Pollers return JSON notifications. Credentials belong in the launch environment, never in rule arguments. The loopback endpoint uses a private bearer token stored in `connection.json` in Relay's data directory. Rules can report failures without losing their configuration.

## Develop inside Relay

Run `npm start` from the cloned source folder. In the development window, open a project shell, `cd` to this source directory, then launch an agent with `claude`, `claude-code`, or `codex`. Vite hot-reloads changes to `src/relay/`. Terminals are owned by Rust, so a frontend reload reattaches to the existing processes. Native Rust changes require a process rebuild/restart, after which saved conversations resume lazily when clicked. Relay allows one running instance; quit another Relay instance first so its single-instance lock does not redirect the development launch. Use a separate development data directory to keep test tabs out of your production workspace.

```powershell
# Optional isolated development data on Windows
$env:RELAY_DATA_DIR = "$PWD\.relay-test\dev"
npm start
```

```sh
# macOS
RELAY_DATA_DIR="$PWD/.relay-test/dev" npm start
```

For a browser-only design preview, use `npm run dev` and open `http://127.0.0.1:5173/?demo=1`. Demo state is isolated and clearly labeled; it does not run agents or verify native recovery.

Active code:
- `src/relay/` — interface and terminal attachment
- `src-tauri/src/relay/` — runtime, ledger, PTYs, hooks and rules
- `integrations/` — optional local notification/provider adapters

Upstream history remains in Git for provenance and comparison; inactive account, cloud, editor and analytics code is excluded from the active tree and retained in a local archive. [Foundation comparison](docs/alternatives.md) explains the alternatives. [Original README](docs/UPSTREAM-README.md) documents upstream features, not Relay's product.

## Checks

```sh
npm run doctor
npm run check
npm test
npm run test:startup
npm run test:connectors
npm run test:native
npm run build
```

The native tests cover storage recovery, exact session launch arguments, event authentication/deduplication and rule behavior. Frontend tests cover terminal replay and interaction state. Connector tests use fake endpoints and never real accounts.

## License

[MIT](LICENSE). Original copyright notices are preserved. See [NOTICE](NOTICE) for derivation and third-party component attribution.
