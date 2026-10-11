#!/usr/bin/env node
import { boundedInteger, event, isMainModule, parseArgs, requestJson, requiredToken, runCli } from './_shared.mjs';

const API = 'https://slack.com/api/conversations.history';

export function isRelevantSlackMessage(message, { type, userId }) {
  if (!message.ts || message.user === userId || message.subtype === 'message_changed' || message.subtype === 'message_deleted') return false;
  if (type === 'dm') return true;
  const text = message.text ?? '';
  return text.includes(`<@${userId}>`) || /<!channel>|<!here>|<!everyone>/.test(text);
}

export function toSlackEvent(message, conversation, type) {
  const label = conversation || (type === 'dm' ? 'DM' : 'channel');
  return event(`Slack ${type === 'dm' ? 'DM' : 'mention'} · ${label}`, message.text ?? '(message has no text)', 'slack', `slack:${conversation}:${message.ts}`);
}

async function pollConversation({ token, conversation, type, userId, lookbackMinutes, limit, fetchImpl }) {
  const oldest = (Date.now() / 1000 - lookbackMinutes * 60).toFixed(6);
  const form = new URLSearchParams({ channel: conversation, oldest, inclusive: 'false', limit: String(limit) });
  const page = await requestJson(API, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  }, fetchImpl);
  return (page.messages ?? [])
    .filter((message) => isRelevantSlackMessage(message, { type, userId }))
    .sort((left, right) => Number(left.ts) - Number(right.ts))
    .map((message) => toSlackEvent(message, conversation, type));
}

export async function pollSlack({ token, userId, channels = [], dms = [], lookbackMinutes = 10, limit = 15, fetchImpl = fetch }) {
  if (!userId) throw new Error('Pass --user-id with your Slack member ID so channel mentions can be matched');
  if (channels.length + dms.length === 0) throw new Error('Pass at least one --channel or --dm conversation ID');
  const events = [];
  for (const conversation of channels) events.push(...await pollConversation({ token, conversation, type: 'channel', userId, lookbackMinutes, limit, fetchImpl }));
  for (const conversation of dms) events.push(...await pollConversation({ token, conversation, type: 'dm', userId, lookbackMinutes, limit, fetchImpl }));
  return events;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2));
    return pollSlack({
      token: requiredToken('SLACK_ACCESS_TOKEN'),
      userId: args.get('--user-id'),
      channels: args.getAll('--channel'),
      dms: args.getAll('--dm'),
      lookbackMinutes: boundedInteger(args.get('--lookback'), '--lookback', 10, { min: 1, max: 1440 }),
      limit: boundedInteger(args.get('--limit'), '--limit', 15, { min: 1, max: 15 }),
    });
  });
}
