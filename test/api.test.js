// -----------------------------------------------------------------------------
// One GET of the 511 API, on a real local HTTP server (loopback) and with a
// scripted fetch: the byte order mark 511 sometimes sends, the statuses of the
// specification, bounded bodies, and the token never in what comes back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { alertsUrl, getJson, readRetryAfter, stopMonitoringUrl, stripBom } from '../src/api.js';
import { MAX_BODY_BYTES, USER_AGENT } from '../src/constants.js';
import { testClock } from './kit/clock.mjs';
import { KEY } from './helpers/setup.js';

/** A loopback server answering with `handler(req, res)`; closed by `t.after`. */
async function serve(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}/transit`, requests };
}

const DATE = 'Fri, 27 Nov 2026 18:00:00 GMT';

test('the URLs: api_key, agency, stopCode, format=json; nothing else', () => {
  const url = new URL(stopMonitoringUrl(KEY, { agency: 'SF', code: '15553' }));
  assert.equal(url.origin + url.pathname, 'https://api.511.org/transit/StopMonitoring');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    api_key: KEY,
    agency: 'SF',
    stopCode: '15553',
    format: 'json',
  });
  const alerts = new URL(alertsUrl(KEY, 'BA'));
  assert.equal(alerts.pathname, '/transit/servicealerts');
  assert.deepEqual(Object.fromEntries(alerts.searchParams), {
    api_key: KEY,
    agency: 'BA',
    format: 'json',
  });
});

test('a JSON answer with a UTF-8 byte order mark is read; the User-Agent is the module', async (t) => {
  const { base, requests } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', date: DATE });
    res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":"é"}')]));
  });
  const answer = await getJson(`${base}/StopMonitoring?api_key=${KEY}`);
  assert.deepEqual(answer, { ok: true, json: { a: 'é' }, serverDate: Date.parse(DATE) });
  assert.equal(requests[0].headers['user-agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-sf-bay-transit\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-sf-bay-transit\)$/,
  );
  assert.equal(stripBom('﻿{}'), '{}');
  assert.equal(stripBom('{}'), '{}');
});

test('401, 404, 429 with Retry-After, 500: the kinds; the token never in the answer', async (t) => {
  let status = 401;
  const { base } = await serve(t, (req, res) => {
    const headers = { 'content-type': 'text/plain', date: DATE };
    if (status === 429) headers['retry-after'] = '120';
    res.writeHead(status, headers);
    res.end(status === 401 ? 'This API key provided is invalid.' : 'x');
  });
  const url = `${base}/StopMonitoring?api_key=${KEY}`;
  const auth = await getJson(url);
  assert.deepEqual(auth, { ok: false, kind: 'auth', status: 401, serverDate: Date.parse(DATE) });
  status = 404;
  assert.equal((await getJson(url)).kind, 'http');
  status = 429;
  const rate = await getJson(url);
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAfter, 120_000);
  status = 500;
  assert.equal((await getJson(url)).kind, 'server');
  for (const answer of [auth, rate]) assert.ok(!JSON.stringify(answer).includes(KEY));
});

test('a body over the bound is cut (declared or streamed); HTML is a format error', async (t) => {
  let mode = 'declared';
  const { base } = await serve(t, (req, res) => {
    if (mode === 'declared') {
      res.writeHead(200, { 'content-length': String(MAX_BODY_BYTES + 1), date: DATE });
      res.end();
    } else if (mode === 'stream') {
      res.writeHead(200, { 'content-type': 'application/json', date: DATE });
      const chunk = Buffer.alloc(256 * 1024, 32);
      let sent = 0;
      const push = () => {
        while (sent <= MAX_BODY_BYTES + chunk.length) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', push);
        }
        res.end();
      };
      push();
    } else {
      res.writeHead(200, { 'content-type': 'text/html', date: DATE });
      res.end('<html>maintenance</html>');
    }
  });
  assert.equal((await getJson(`${base}/x`)).kind, 'too_big');
  mode = 'stream';
  assert.equal((await getJson(`${base}/x`)).kind, 'too_big');
  mode = 'html';
  assert.equal((await getJson(`${base}/x`)).kind, 'format');
});

test('a request that never answers ends at 20 s (virtual clock); a refused one is a network error', async () => {
  const clock = testClock();
  const hanging = (url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  const pending = getJson('https://api.511.org/transit/x', {
    fetchImpl: hanging,
    timers: clock.timers,
  });
  await clock.advance(19_999);
  let done = false;
  pending.then(() => (done = true));
  await clock.advance(0);
  assert.equal(done, false);
  await clock.advance(2);
  assert.deepEqual(await pending, { ok: false, kind: 'timeout', serverDate: null });
  assert.equal(clock.pending, 0, 'no timer left');
  const refused = await getJson('https://x', {
    fetchImpl: () => Promise.reject(new TypeError(`fetch failed ${KEY}`)),
    timers: clock.timers,
  });
  assert.deepEqual(refused, { ok: false, kind: 'network', serverDate: null });
});

test('Retry-After: seconds or a date, bounded to 6 h', () => {
  const at = Date.parse(DATE);
  assert.equal(readRetryAfter('30', at), 30_000);
  assert.equal(readRetryAfter('99999999999999999999', at), 6 * 3600_000);
  assert.equal(readRetryAfter('Fri, 27 Nov 2026 18:05:00 GMT', at), 300_000);
  assert.equal(readRetryAfter('Sat, 28 Nov 2026 18:05:00 GMT', at), 6 * 3600_000);
  assert.equal(readRetryAfter('soon', at), null);
  assert.equal(readRetryAfter(null, at), null);
});

test('a redirect is never followed (the token is in the URL)', async (t) => {
  const target = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const { base } = await serve(t, (req, res) => {
    res.writeHead(302, { location: `${target.base}/StopMonitoring?${req.url.split('?')[1]}` });
    res.end();
  });
  const answer = await getJson(`${base}/StopMonitoring?api_key=${KEY}`);
  assert.equal(answer.ok, false);
  assert.equal(target.requests.length, 0, 'the second server never sees the token');
});
