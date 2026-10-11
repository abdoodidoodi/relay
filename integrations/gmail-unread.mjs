#!/usr/bin/env node
import { boundedInteger, event, googleAccessToken, isMainModule, parseArgs, requestJson, runCli } from './_shared.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

export function toGmailEvent(message, details) {
  const headers = new Map((details.payload?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
  const from = headers.get('from') || 'Unknown sender';
  const subject = headers.get('subject') || 'Unread email';
  const snippet = (details.snippet ?? '').trim();
  const body = [`From: ${from}`, snippet].filter(Boolean).join('\n');
  return event(subject, body, 'gmail', `gmail:${message.id}`);
}

export async function pollGmail({ token, maxMessages = 25, fetchImpl = fetch }) {
  const output = [];
  let pageToken;
  do {
    const url = new URL(API);
    url.searchParams.set('q', 'is:unread');
    url.searchParams.set('maxResults', String(Math.min(100, maxMessages - output.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await requestJson(url, token, {}, fetchImpl);
    for (const message of page.messages ?? []) {
      const detailUrl = `${API}/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
      const details = await requestJson(detailUrl, token, {}, fetchImpl);
      output.push(toGmailEvent(message, details));
      if (output.length >= maxMessages) break;
    }
    pageToken = output.length < maxMessages ? page.nextPageToken : undefined;
  } while (pageToken);
  return output;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2));
    const maxMessages = boundedInteger(args.get('--max'), '--max', 25, { max: 100 });
    return pollGmail({ token: await googleAccessToken(), maxMessages });
  });
}
