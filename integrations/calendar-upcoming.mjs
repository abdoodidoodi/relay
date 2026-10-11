#!/usr/bin/env node
import { boundedInteger, event, googleAccessToken, isMainModule, parseArgs, requestJson, runCli } from './_shared.mjs';

const API = 'https://www.googleapis.com/calendar/v3/calendars';

export function toCalendarEvent(item) {
  const start = item.start?.dateTime;
  const end = item.end?.dateTime;
  const when = start ? new Date(start).toLocaleString() : item.start?.date ?? 'Unknown time';
  const body = [
    `Starts: ${when}`,
    end ? `Ends: ${new Date(end).toLocaleString()}` : '',
    item.location ? `Location: ${item.location}` : '',
    item.htmlLink ? `Calendar link: ${item.htmlLink}` : '',
    item.description ? item.description.slice(0, 1200) : '',
  ].filter(Boolean).join('\n');
  return event(item.summary || 'Upcoming meeting', body, 'google-calendar', `gcal:${item.id}:${start ?? item.start?.date}`);
}

export async function pollCalendar({ token, calendarId = 'primary', minutes = 30, now = new Date(), fetchImpl = fetch }) {
  const output = [];
  let pageToken;
  let pageCount = 0;
  do {
    if (pageCount >= 10) throw new Error('Calendar query exceeded 10 pages; narrow the time window');
    const url = new URL(`${API}/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('timeMin', now.toISOString());
    url.searchParams.set('timeMax', new Date(now.getTime() + minutes * 60_000).toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await requestJson(url, token, {}, fetchImpl);
    pageCount += 1;
    for (const item of page.items ?? []) {
      const start = item.start?.dateTime;
      if (start && new Date(start) > now && item.status !== 'cancelled') output.push(toCalendarEvent(item));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return output;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2));
    return pollCalendar({
      token: await googleAccessToken(),
      calendarId: args.get('--calendar', 'primary'),
      minutes: boundedInteger(args.get('--minutes'), '--minutes', 30, { max: 1440 }),
    });
  });
}
