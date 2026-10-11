# Provider command integrations

Relay command rules can run the dependency-free Node 20 examples in [`integrations/`](../integrations/). Each poller reads an OAuth access token from the environment, calls a read-only provider API, and writes a JSON array to stdout. No matches means `[]`. Errors go to stderr and return a nonzero exit code. The rules backend can route each emitted event to its own assistant conversation; these examples do not send mail, Slack messages, or calendar changes.

Provider text is untrusted data. The scripts include it as ordinary JSON strings; render it as plain text and do not interpret it as markup or instructions. A stable `dedupeKey` lets Relay suppress repeats when an unread message or upcoming event appears in multiple polling runs.

## Credentials

These examples use bring-your-own OAuth credentials. They do not provide OAuth sign-in or credential storage. Obtain tokens through an OAuth client you control, grant only the read scope needed below, and inject credentials into Relay's environment before starting it. Do not paste credentials into rule arguments, this repository, or rule JSON. Access tokens may be supplied directly, or Google pollers can refresh one at run time using a user-provided refresh token and OAuth client credentials. Slack access tokens are used directly and must be replaced when they expire.

PowerShell example for a development run:

```powershell
$env:GOOGLE_REFRESH_TOKEN = '<refresh token granted the Gmail and/or Calendar read scopes>'
$env:GOOGLE_CLIENT_ID = '<OAuth client ID>'
$env:GOOGLE_CLIENT_SECRET = '<OAuth client secret>'
$env:SLACK_ACCESS_TOKEN = '<user token with conversation history scopes>'
npm run tauri dev
```

For a direct Google access token, set `GOOGLE_ACCESS_TOKEN` with the needed Gmail or Calendar read scope; it takes precedence over refresh credentials. The refresh token must already have the required scope grants. Google OAuth access tokens are refreshed for each poller invocation, so scheduled polling makes one token request per run. On macOS or Linux, export only the variables needed for that run in the same shell that launches Relay. Environment values are credentials; provider options such as calendar ID and Slack conversation IDs belong in command arguments.

## Pollers

**Gmail unread messages** uses the Gmail API search query `is:unread`, then fetches each matching message's headers and snippet. Grant `https://www.googleapis.com/auth/gmail.readonly`. It emits a `gmail:<message-id>` dedupe key and caps a run at 25 messages by default (adjust with `--max`). Example command rule:

```text
node integrations/gmail-unread.mjs --max 25
```

**Slack mentions and direct messages** reads recent history only for conversation IDs you explicitly pass. Supply `--channel <id>` once per channel to emit direct user mentions plus `@here`, `@channel`, and `@everyone`; supply `--dm <id>` once per DM to emit incoming messages. Pass your Slack member ID with `--user-id <id>`. Grant the matching history scopes: `channels:history`, `groups:history`, and/or `im:history`. Bot tokens only see conversations the bot belongs to; a user token can see the user's conversations according to its scopes. `--lookback` defaults to 10 minutes and `--limit` to 15 messages per API request. The poller makes one history request per supplied conversation and does not mark messages read.

```text
node integrations/slack-mentions.mjs --user-id U12345 --channel C12345 --dm D12345 --lookback 10
```

The history API is limited to one request per minute for newer non-Marketplace Slack apps, with a 15-message page size. For those apps, run one conversation per rule at intervals of at least a minute. A busy channel with more than 15 messages during the lookback can omit older entries in that run; keep the lookback short and let Relay's stable dedupe keys absorb repeated matches.

**Upcoming Google Calendar events** checks the selected calendar (default `primary`) for timed events starting in the next 30 minutes. Grant `https://www.googleapis.com/auth/calendar.events.readonly`. The dedupe key includes the event ID and occurrence start time, so recurring events remain distinct.

```text
node integrations/calendar-upcoming.mjs --calendar primary --minutes 30
```

All provider pollers use only read methods. Their output is an array of `{event,title,body,source,dedupeKey}` records, where `event` is `notification`. Without a `sessionId`, Relay creates a separate assistant notification conversation. Nothing here marks provider messages read.

## Publish one local notification

`notify.mjs` sends a notification envelope to Relay's loopback hook endpoint. It supports inherited `RELAY_ENDPOINT` and `RELAY_TOKEN` variables or an explicit private `connection.json` file. The connection token grants local event publishing only.

```powershell
node integrations/notify.mjs --connection "<Relay data directory>\connection.json" `
  --title 'Build finished' --body 'Review the local changes' --source build --dedupe-key 'build:run-42'
```

```sh
node integrations/notify.mjs --connection "<Relay data directory>/connection.json" \
  --title 'Build finished' --body 'Review the local changes' --source build --dedupe-key 'build:run-42'
```

For development or tests, set `RELAY_ENDPOINT` and `RELAY_TOKEN` directly in the process environment instead of using `--connection`. The utility writes `[]` to stdout after publishing, which is a valid empty command-rule result; delivery errors are reported on stderr with a nonzero exit code.

## MCP tools

[`relay-mcp.mjs`](../integrations/relay-mcp.mjs) is a dependency-free MCP stdio server that exposes two tools: `relay_notify` publishes a local notification, and `relay_status` reports `prompt`, `working`, `ready`, or `settings` for the current Relay session. The status tool is limited to session status fields; this server has no local command execution and makes no provider API calls. It reads `RELAY_ENDPOINT`, `RELAY_TOKEN`, and (for status updates) `RELAY_SESSION_ID` inherited from Relay, or reads endpoint and token from `--connection <connection.json>`.

Example Claude MCP config file (replace paths with the local Node executable and Relay data directory):

```json
{
  "mcpServers": {
    "relay": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\you\\source\\relay\\integrations\\relay-mcp.mjs",
        "--connection",
        "<Relay data directory>\\connection.json"
      ]
    }
  }
}
```

Pass `--mcp-config <path-to-that-file>` in Claude's custom arguments in Relay. Relay currently supplies its own per-invocation `--settings`; keep that managed argument in place and add `--mcp-config` as a separate argument. You can keep the MCP JSON file outside the repository, or use an optional project-level Claude config. This example does not ask you to edit Claude's global config or place the local bearer token in JSON.

The Claude process inherits the Relay session ID when launched by Relay, so `relay_status` updates the attached session. If Claude is launched outside Relay, `relay_notify` still creates a separate assistant notification, while `relay_status` needs `RELAY_SESSION_ID` supplied in that process environment. Agent-defined assistants can add Slack or Gmail MCP servers separately for provider access, then use Relay MCP to send a local notification; Relay MCP itself never contacts Slack or Gmail.

## Agent and MCP hooks

Provider pollers are useful for read-only reminders. For the coding-agent lifecycle, use Relay's per-invocation Claude/Codex hook adapters or an MCP server when the provider supports those hooks. They deliver prompt/working/ready events closer to real time and can attach status to the exact local session ID. Keep credentials and the local Relay connection token out of source files and command-rule JSON.

## API references

- [Gmail `users.messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) and [listing messages guide](https://developers.google.com/workspace/gmail/api/guides/list-messages)
- [Slack `conversations.history`](https://api.slack.com/methods/conversations.history) and [Conversations API scopes](https://api.slack.com/docs/conversations-api)
- [Google Calendar `events.list`](https://developers.google.com/calendar/api/v3/reference/events/list)
