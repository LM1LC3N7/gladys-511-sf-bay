// -----------------------------------------------------------------------------
// The 511 transit API: one GET with an honest User-Agent, a bounded time and a
// bounded body (cut before it is read in full), the UTF-8 byte order mark 511
// sometimes puts before its JSON removed. Nothing here retries, waits or keeps
// state: the app paces the requests and decides.
//
// The token travels in the query string (`api_key`, as 511 requires): a URL
// is therefore never logged, never put in a status nor an error.
//
// Documented answers (511 SF Bay Open Data Specification - Transit, 2022):
// 401 for an invalid key (checked on 2026-11-27: text/plain "This API key
// provided is invalid."), 404 when a resource cannot be located, 500 when 511
// has issues; the quota answer is a 429 (Retry-After read when present).
// -----------------------------------------------------------------------------

import { API_BASE, MAX_BODY_BYTES, PAUSE_MAX, REQUEST_TIMEOUT, USER_AGENT } from './constants.js';

const RETRY_AFTER_MAX_SECONDS = PAUSE_MAX / 1000;

/** The next visits at one stop of an agency (SIRI StopMonitoring, JSON). */
export function stopMonitoringUrl(key, stop, base = API_BASE) {
  const params = new URLSearchParams({
    api_key: key,
    agency: stop.agency,
    stopCode: stop.code,
    format: 'json',
  });
  return `${base}/StopMonitoring?${params}`;
}

/** The service alerts of one agency (GTFS-RT, JSON). */
export function alertsUrl(key, agency, base = API_BASE) {
  const params = new URLSearchParams({ api_key: key, agency, format: 'json' });
  return `${base}/servicealerts?${params}`;
}

/**
 * One GET. Resolves `{ ok: true, json, serverDate }` or `{ ok: false, kind,
 * status?, retryAfter?, serverDate }`, `kind` among `network`, `timeout`,
 * `rate` (429), `server` (5xx), `auth` (401), `http` (other status), `format`,
 * `too_big`. Never throws, never carries the URL.
 */
export async function getJson(target, { fetchImpl = fetch, timers = globalThis } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    timers.clearTimeout(timer);
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null };
  }
  const serverDate = readHttpDate(response.headers.get('date'));
  const base = { serverDate };
  try {
    if (response.status === 429) {
      const retryAfter = readRetryAfter(response.headers.get('retry-after'), serverDate);
      return { ok: false, kind: 'rate', status: 429, retryAfter, ...base };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        kind: 'server',
        status: response.status,
        retryAfter: readRetryAfter(response.headers.get('retry-after'), serverDate),
        ...base,
      };
    }
    if (response.status === 401) return { ok: false, kind: 'auth', status: 401, ...base };
    if (response.status !== 200) {
      return { ok: false, kind: 'http', status: response.status, ...base };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, kind: 'too_big', status: 200, ...base };
    }
    const text = await readBounded(response);
    if (text === null) return { ok: false, kind: 'too_big', status: 200, ...base };
    let json;
    try {
      json = JSON.parse(stripBom(text));
    } catch {
      return { ok: false, kind: 'format', status: 200, ...base };
    }
    return { ok: true, json, ...base };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'network', ...base };
  } finally {
    timers.clearTimeout(timer);
    // A body left unread is released, never kept open.
    response.body?.cancel?.().catch?.(() => {});
  }
}

/** The UTF-8 byte order mark 511 sometimes sends first (U+FEFF once decoded). */
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The body as text, or `null` past `max` bytes (the rest never read). */
async function readBounded(response, max = MAX_BODY_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** An HTTP date (`Fri, 27 Nov 2026 11:17:30 GMT`) in ms, or `null`. */
export function readHttpDate(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `Retry-After` in ms (seconds or an HTTP date read against the server's), bounded to 6 h. */
export function readRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text), RETRY_AFTER_MAX_SECONDS) * 1000;
  const at = readHttpDate(text);
  if (at !== null && serverDate !== null) return Math.min(Math.max(0, at - serverDate), PAUSE_MAX);
  return null;
}
