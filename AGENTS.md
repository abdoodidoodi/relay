# Working on Relay

Relay is a small Tauri desktop app. Read README.md and docs/relay-contract.md first.

- The active interface is src/relay/ and src/relay.css. The Rust backend is src-tauri/src/relay/.
- Keep agent processes in the Rust runtime. React teardown, tab switches and HMR must never stop a PTY.
- Persist every meaningful metadata change transactionally before reporting success. Keep stable tab IDs independent from provider conversation IDs.
- Never restore using a latest-session guess (--last/--continue). Do not silently replace a failed resume with a fresh conversation.
- Preserve full provider IDs, cwd, model and effort. Use authoritative provider hooks for binding.
- Notifications stay until explicitly dismissed. Viewing a notification must not remove it.
- Keep Relay local by default. No analytics, hosted auth or account requirements. Provider credentials stay with providers or in the runtime environment.
- Do not log bearer tokens or place them in source, argv or stored rule arguments. The hook API must stay authenticated and loopback-only.
- Configured command rules use explicit argv, bounded time/output and no shell interpolation.
- Keep new dependencies small. Do not reintroduce a code editor, browser panel or cloud service into the main UI.
- Use an isolated RELAY_DATA_DIR for tests. Never stop a user's other terminal processes or modify global agent settings for QA.
- Preserve upstream MIT notices and document which behavior is actually verified on each platform.

Checks: npm run check; npm test; npm run test:connectors; npm run test:native; npm run build. For native UI QA, use a test data directory and a separate debug port. Do not claim a simulated browser preview verifies native session recovery.
