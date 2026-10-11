import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(resolve(argvPath)).href;
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${key}`);
    const current = values.get(key) ?? [];
    current.push(next);
    values.set(key, current);
    index += 1;
  }
  return {
    get(name, fallback) { return values.get(name)?.at(-1) ?? fallback; },
    getAll(name) { return values.get(name) ?? []; },
  };
}

export function requiredToken(name) {
  const token = process.env[name]?.trim();
  if (!token) throw new Error(`Set ${name} to an OAuth access token`);
  return token;
}

export async function googleAccessToken(env = process.env, fetchImpl = fetch) {
  const accessToken = env.GOOGLE_ACCESS_TOKEN?.trim();
  if (accessToken) return accessToken;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Set GOOGLE_ACCESS_TOKEN or all of GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET');
  }
  let response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: clientId, client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Google OAuth refresh request failed');
  }
  if (!response.ok) throw new Error(`Google OAuth token endpoint returned HTTP ${response.status}`);
  let data;
  try { data = await response.json(); } catch { throw new Error('Google OAuth token endpoint returned invalid JSON'); }
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google OAuth token response did not contain an access token');
  return data.access_token;
}

export async function requestJson(url, token, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'request timed out' : 'network request failed';
    throw new Error(reason);
  }
  if (!response.ok) throw new Error(`Provider API returned HTTP ${response.status}`);
  if (response.status === 204) return {};
  let data;
  try { data = await response.json(); } catch { throw new Error('Provider API returned invalid JSON'); }
  if (data?.ok === false) throw new Error('Slack API returned an error response');
  return data;
}

export function event(title, body, source, dedupeKey) {
  return { event: 'notification', title, body, source, dedupeKey };
}

export function writeEvents(events) {
  process.stdout.write(`${JSON.stringify(events)}\n`);
}

export async function runCli(main) {
  try {
    writeEvents(await main());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected provider error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function boundedInteger(value, name, fallback, { min = 1, max = 100 } = {}) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}
