import test from 'node:test';
import assert from 'node:assert/strict';
import { pollGmail, toGmailEvent } from './gmail-unread.mjs';
import { pollSlack, isRelevantSlackMessage } from './slack-mentions.mjs';
import { pollCalendar, toCalendarEvent } from './calendar-upcoming.mjs';
import { googleAccessToken, requestJson } from './_shared.mjs';

test('Gmail follows page tokens, reads only metadata and maps message IDs to stable keys', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith('/messages')) {
      if (url.searchParams.has('pageToken')) return Response.json({ messages: [{ id: 'm-2' }] });
      return Response.json({ messages: [{ id: 'm-1' }], nextPageToken: 'next' });
    }
    assert.equal(url.searchParams.get('format'), 'metadata');
    return Response.json({ snippet: 'Please review this.', payload: { headers: [
      { name: 'From', value: 'person@example.test' }, { name: 'Subject', value: 'Review request' },
    ] } });
  };
  const events = await pollGmail({ token: 'test-token', maxMessages: 2, fetchImpl });
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'notification');
  assert.equal(events[0].title, 'Review request');
  assert.equal(events[0].body, 'From: person@example.test\nPlease review this.');
  assert.equal(events[0].dedupeKey, 'gmail:m-1');
  assert.equal(calls.filter((url) => url.pathname.endsWith('/messages')).length, 2);
  assert.equal(calls.filter((url) => /\/messages\/m-/.test(url.pathname)).length, 2);
  assert.equal(toGmailEvent({ id: 'x' }, {}).dedupeKey, 'gmail:x');
});

test('Slack includes only matching mentions or incoming DMs and builds stable event keys', async () => {
  assert.equal(isRelevantSlackMessage({ ts: '1', user: 'U2', text: 'hi <@U1>' }, { type: 'channel', userId: 'U1' }), true);
  assert.equal(isRelevantSlackMessage({ ts: '2', user: 'U2', text: 'hi there' }, { type: 'channel', userId: 'U1' }), false);
  assert.equal(isRelevantSlackMessage({ ts: '3', user: 'U1', text: '<@U1> self' }, { type: 'dm', userId: 'U1' }), false);

  let call = 0;
  const fetchImpl = async (_input, options) => {
    assert.equal(options.method, 'POST');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('channel'), 'C-one');
    assert.equal(form.get('limit'), '15');
    call += 1;
    return Response.json({ messages: [
      { ts: '4.0', user: 'U2', text: '<@U1> newer' },
      { ts: '3.0', user: 'U2', text: '<@U1> older' },
    ], has_more: true });
  };
  const events = await pollSlack({ token: 'test-token', userId: 'U1', channels: ['C-one'], lookbackMinutes: 10, fetchImpl });
  assert.equal(events.length, 2);
  assert.equal(events[0].dedupeKey, 'slack:C-one:3.0');
  assert.equal(events[1].dedupeKey, 'slack:C-one:4.0');
  assert.equal(call, 1, 'one run makes one history request per conversation');
  assert.match(events[1].title, /Slack mention/);
});

test('Calendar follows page tokens and emits only future timed events within the window', async () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const seen = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    seen.push(url);
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('timeMin'), now.toISOString());
    if (url.searchParams.has('pageToken')) return Response.json({ items: [
      { id: 'later', summary: 'Planning', start: { dateTime: '2026-10-10T12:25:00Z' }, end: { dateTime: '2026-10-10T12:45:00Z' } },
      { id: 'cancelled', summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-10-10T12:20:00Z' } },
    ] });
    return Response.json({ items: [
      { id: 'past', summary: 'Past', start: { dateTime: '2026-10-10T11:59:00Z' } },
      { id: 'all-day', summary: 'All day', start: { date: '2026-10-10' } },
    ], nextPageToken: 'next' });
  };
  const events = await pollCalendar({ token: 'test-token', minutes: 30, now, fetchImpl });
  assert.equal(seen.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Planning');
  assert.equal(events[0].dedupeKey, 'gcal:later:2026-10-10T12:25:00Z');
  assert.match(toCalendarEvent({ id: 'a', start: { date: '2026-10-10' } }).dedupeKey, /2026-10-10$/);
});

test('Calendar pagination stops with a safe error after ten pages', async () => {
  let calls = 0;
  await assert.rejects(pollCalendar({
    token: 'sensitive-token',
    now: new Date('2026-10-10T12:00:00.000Z'),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ items: [], nextPageToken: `p${calls}` });
    },
  }), /exceeded 10 pages/);
  assert.equal(calls, 10);
});

test('Provider HTTP and Slack error responses never echo credentials or provider bodies', async () => {
  const secret = 'private-access-token';
  await assert.rejects(requestJson('https://provider.example/api', secret, {}, async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return new Response(JSON.stringify({ error: secret }), { status: 401 });
  }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(requestJson('https://slack.example/api', secret, {}, async () => Response.json({ ok: false, error: secret })), (error) => {
    assert.match(error.message, /Slack API returned an error/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(requestJson('https://provider.example/api', secret, {}, async () => { throw new Error(secret); }), (error) => {
    assert.match(error.message, /network request failed/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('Google refresh exchanges credentials without exposing them in failures', async () => {
  const env = {
    GOOGLE_REFRESH_TOKEN: 'refresh-secret',
    GOOGLE_CLIENT_ID: 'client-secret-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
  };
  let form;
  const accessToken = await googleAccessToken(env, async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    form = new URLSearchParams(options.body);
    return Response.json({ access_token: 'fresh-access-token' });
  });
  assert.equal(accessToken, 'fresh-access-token');
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), env.GOOGLE_REFRESH_TOKEN);
  await assert.rejects(googleAccessToken(env, async () => new Response(JSON.stringify({ error: env.GOOGLE_CLIENT_SECRET }), { status: 400 })), (error) => {
    assert.match(error.message, /HTTP 400/);
    assert.equal(error.message.includes(env.GOOGLE_CLIENT_SECRET), false);
    return true;
  });
});

test('Slack 429 response fails once without retrying and without echoing the token', async () => {
  let calls = 0;
  const secret = 'slack-access-token';
  await assert.rejects(pollSlack({
    token: secret, userId: 'U1', channels: ['C1'],
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: secret }), { status: 429, headers: { 'Retry-After': '60' } });
    },
  }), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 1);
});
