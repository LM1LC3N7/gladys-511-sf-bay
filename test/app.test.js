// -----------------------------------------------------------------------------
// The app on the virtual clock, against the SDK's fake Gladys and a scripted
// 511: what is published, the quota (counted, kept across a restart), the
// pauses, the refused token, and never a value without proof.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  D,
  F,
  HOME,
  HOUR,
  KEY,
  MINUTE,
  SECOND,
  START,
  TWO,
  alertEntity,
  alertsFeed,
  createApi,
  defaultWorld,
  errorAnswer,
  json,
  setup,
  stopMonitoring,
  until,
  visit,
} from './helpers/setup.js';

/** Every sliding hour of the requests holds at most `max`. */
function maxPerHour(calls) {
  let worst = 0;
  for (let i = 0; i < calls.length; i += 1) {
    const inHour = calls.filter((c) => c.at > calls[i].at - HOUR && c.at <= calls[i].at).length;
    worst = Math.max(worst, inHour);
  }
  return worst;
}

test('the first round publishes the departures and the count; the alerts after a departure', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(env.api.count('dep'), 1);
  assert.equal(env.api.count('alerts'), 1, 'the lines are known once the departures came');
  assert.equal(env.text(F(1, 'next')), '14 MISSION → Downtown: 3 min (10:03)');
  assert.match(env.text(F(1, 'second')), /^49 VAN NESS → Downtown: 12 min \(10:12\)$/);
  assert.equal(env.text(F(1, 'departures')), 2);
  assert.equal(env.text(F(1, 'alerts')), 0);
  assert.match(env.text(F(1, 'alert_text')), /^No alert \(read 10:0\d\)$/);
  assert.equal(env.status().connected, true);
  assert.match(env.status().message.en, /Data provided by 511\.org\./);
  assert.match(env.status().message.fr, /Données fournies par 511\.org\./);
  const [call] = env.api.calls;
  assert.equal(call.agency, 'SF');
  assert.equal(call.stop, '15553');
  assert.equal(call.format, 'json');
  assert.equal(call.key, KEY);
});

test('nothing is published for a device not created; the next read publishes once created', async (t) => {
  const env = await setup({ created: false });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(env.fake.states.length, 0);
  assert.equal(env.fake.discoveredDevices.length, 1);
  assert.equal(env.fake.discoveredDevices[0].external_id, D(1));
});

test('the quota: five stops, five agencies, 2 min asked: never more than 54 in any sliding hour', async (t) => {
  const config = { ...HOME, refresh_minutes: '2' };
  for (const [slot, agency] of [
    [2, 'BA'],
    [3, 'CT'],
    [4, 'AC'],
    [5, 'GG'],
  ]) {
    config[`stop${slot}_agency`] = agency;
    config[`stop${slot}_code`] = `${slot}0000`;
  }
  const env = await setup({ config });
  t.after(() => env.app.stop());
  await env.begin();
  await env.wait(4 * HOUR);
  const plan = env.app.plan;
  assert.equal(plan.budget, 54);
  assert.ok(plan.depEvery > 2, 'lengthened');
  assert.ok(
    maxPerHour(env.api.calls) <= plan.perHour,
    `${maxPerHour(env.api.calls)} > ${plan.perHour}`,
  );
  assert.ok(env.api.count('dep') >= 4 * 5 * Math.floor(60 / plan.depEvery));
  assert.ok(!env.lines.some((l) => /quota/.test(l)), 'the plan never needs the guard');
  assert.match(env.status().message.en, /interval lengthened for the quota/);
  assert.equal(env.api.peak, 1, 'one request at a time');
  const gaps = env.api.calls.slice(1).map((c, i) => c.at - env.api.calls[i].at);
  assert.ok(Math.min(...gaps) >= 2 * SECOND - 1, 'two seconds apart');
});

test('the guard holds when the plan is wrong: never more than the budget in an hour', async (t) => {
  const env = await setup({ config: { ...HOME, hourly_limit: '20', refresh_minutes: '2' } });
  t.after(() => env.app.stop());
  await env.app.start(env.gladys.config);
  // A plan forced faster than the budget allows: the guard alone decides.
  env.app.plan = { ...env.app.plan, depEvery: 0.05 };
  await env.wait(0);
  await env.wait(2 * HOUR);
  assert.equal(env.app.quota.budget, 18);
  assert.ok(maxPerHour(env.api.calls) <= 18, String(maxPerHour(env.api.calls)));
  assert.ok(env.api.calls.length >= 30);
  assert.ok(
    env.lines.some((l) => /quota/.test(l)),
    'skipped requests are said',
  );
});

test('a restart knows the requests of the last hour and the last read (/data)', async (t) => {
  const store = createMemoryStore();
  const first = await setup({ store });
  await first.begin();
  await first.wait(2 * MINUTE);
  await first.app.stop();
  const sent = first.api.calls.length;
  assert.ok(store.data.quota.length === sent, 'every request in /data');
  assert.ok(!JSON.stringify(store.data).includes('15553'), 'the stop never in clear');
  // Restarted 1 minute later: the departures wait for the rest of the 5 minutes.
  const second = await setup({ store, start: START + 3 * MINUTE });
  t.after(() => second.app.stop());
  await second.app.start(second.gladys.config);
  await second.wait(1 * MINUTE);
  assert.equal(second.api.count('dep'), 0, 'never sooner than the interval');
  await until(second, () => second.api.count('dep') === 1, { max: 3 * MINUTE });
  assert.equal(second.app.quota.used(second.clock.monotonic()), sent + 1);
});

test('a restart with a full hour in /data sends nothing until a slot frees', async (t) => {
  const quota = Array.from({ length: 54 }, (_, i) => START - 30 * MINUTE + i * 1000);
  const store = createMemoryStore({ quota, depAt: START - HOUR });
  const env = await setup({ store });
  t.after(() => env.app.stop());
  await env.app.start(env.gladys.config);
  await env.wait(29 * MINUTE);
  assert.equal(env.api.calls.length, 0);
  await until(env, () => env.api.calls.length > 0, { max: 40 * MINUTE });
  assert.ok(env.clock.elapsed >= 30 * MINUTE - SECOND);
});

test('/data unreadable: the first read waits one interval and the status says why', async (t) => {
  const env = await setup({ store: createMemoryStore(undefined, { status: 'unreadable' }) });
  t.after(() => env.app.stop());
  await env.app.start(env.gladys.config);
  await env.wait(4 * MINUTE);
  assert.equal(env.api.calls.length, 0);
  assert.match(env.status().message.en, /\/data cannot tell/);
  await until(env, () => env.api.count('dep') === 1, { max: 2 * MINUTE });
});

test('a 401 of the departures: token refused, kept, never sent again until a new one is saved', async (t) => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.key === KEY ? errorAnswer(a, 401) : defaultWorld(call, a),
  );
  const env = await setup({ store, api });
  await env.begin();
  assert.equal(api.calls.length, 1);
  assert.equal(env.status().connected, false);
  assert.match(env.status().message.en, /refused the token/);
  await env.wait(2 * HOUR);
  assert.equal(api.calls.length, 1, 'never sent again');
  assert.match(store.data.refused.print, /^[0-9a-f]{2}$/);
  // A reconnection reads the same token: still refused.
  await env.app.connected();
  await env.wait(HOUR);
  assert.equal(api.calls.length, 1);
  // Saved again unchanged in this process: still refused.
  await env.app.start(env.gladys.config, { saved: true });
  await env.wait(HOUR);
  assert.equal(api.calls.length, 1);
  await env.app.stop();

  // A restart reads /data: refused without a request.
  const again = await setup({ store, api });
  t.after(() => again.app.stop());
  await again.app.connected();
  await again.wait(HOUR);
  assert.equal(api.calls.length, 1);
  // A new token saved: read at once.
  const fresh = { ...HOME, api_key: 'another-token-9876543210' };
  await again.app.start(fresh, { saved: true });
  await again.wait(30 * SECOND);
  assert.equal(api.calls.length, 3, 'departures and alerts with the new token');
  assert.equal(store.data.refused, null);
  assert.equal(again.status().connected, true);
});

test('a 401 of the alerts is never a refused token; the departures go on', async (t) => {
  const api = createApi((call, a) =>
    call.kind === 'alerts' ? errorAnswer(a, 401) : defaultWorld(call, a),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  await env.begin();
  await env.wait(HOUR);
  assert.ok(api.count('dep') >= 12);
  assert.equal(env.app.refused, false);
  assert.match(env.status().message.en, /alerts token refused \(401\)/);
  assert.equal(env.text(F(1, 'alerts')), undefined, 'no count without a read');
  // Spaced out: 15, 30, 60 min...
  assert.ok(api.count('alerts') <= 3, String(api.count('alerts')));
});

test('a 429 pauses every read (Retry-After), kept in /data across a restart', async (t) => {
  const store = createMemoryStore();
  let limited = true;
  const api = createApi((call, a) =>
    limited ? errorAnswer(a, 429, { 'retry-after': '1800' }) : defaultWorld(call, a),
  );
  const env = await setup({ store, api });
  await env.begin();
  assert.equal(api.calls.length, 1);
  assert.match(env.status().message.en, /paused until/);
  await env.app.stop();
  limited = false;
  const again = await setup({ store, api, start: START + 10 * MINUTE });
  t.after(() => again.app.stop());
  await again.app.connected();
  await again.wait(19 * MINUTE);
  assert.equal(api.calls.length, 1, 'still paused after the restart');
  await until(again, () => api.count('dep') === 2, { max: 5 * MINUTE });
});

test('a 5xx of the departures pauses every read; a 5xx of the alerts only spaces the alerts', async (t) => {
  let depDown = true;
  const api = createApi((call, a) =>
    (call.kind === 'dep' && depDown) || call.kind === 'alerts'
      ? errorAnswer(a, 503)
      : defaultWorld(call, a),
  );
  const env = await setup({ config: TWO, api });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(api.calls.length, 1, 'the second stop is paused too');
  assert.ok(env.app.pausedFor() > MINUTE);
  depDown = false;
  await until(env, () => api.count('dep') >= 3, { max: 10 * MINUTE });
  await env.wait(HOUR);
  assert.ok(api.count('alerts') >= 1);
  assert.equal(env.app.pausedFor(), 0, 'an alerts 503 never pauses the departures');
  assert.ok(api.count('dep') >= 20);
});

test('404 of one stop: tried again after 30 min; the other stop goes on', async (t) => {
  const api = createApi((call, a) =>
    call.stop === '15553' ? errorAnswer(a, 404) : defaultWorld(call, a),
  );
  const env = await setup({ config: TWO, api });
  t.after(() => env.app.stop());
  await env.begin();
  await env.wait(29 * MINUTE);
  assert.equal(api.calls.filter((c) => c.stop === '15553').length, 1);
  assert.ok(api.calls.filter((c) => c.stop === '901801').length >= 6);
  assert.match(env.status().message.en, /unknown to 511 404/);
  await env.wait(6 * MINUTE);
  assert.equal(api.calls.filter((c) => c.stop === '15553').length, 2);
});

test('never a value without proof: unreadable, refused, unconfirmed, clock skew', async (t) => {
  const bad = visit(START, 3);
  bad.MonitoredVehicleJourney.MonitoredCall.ExpectedDepartureTime = 'soon';
  const cases = [
    ['unreadable', (now) => stopMonitoring(now, [visit(now, 1), bad])],
    ['format', () => '<html>busy</html>'],
    ['unconfirmed', (now) => stopMonitoring(now, [])],
    ['clock', (now) => stopMonitoring(now - 10 * MINUTE, [visit(now - 10 * MINUTE, 12)])],
  ];
  for (const [label, body] of cases) {
    const api = createApi((call, a) =>
      call.kind === 'dep'
        ? json(body(a.clock.wall()), { date: a.clock.wall() })
        : defaultWorld(call, a),
    );
    const env = await setup({ api });
    t.after(() => env.app.stop());
    await env.begin();
    assert.equal(env.fake.states.length, 0, label);
    assert.equal(api.count('alerts'), 0, `${label}: no alerts while the lines are unknown`);
    assert.equal(env.status().connected, false, label);
  }
});

test('a confirmed stop with no departure says so as text; the counter is 0 then', async (t) => {
  let empty = false;
  const api = createApi((call, a) =>
    call.kind === 'dep' && empty ? stopMonitoring(a.clock.wall(), []) : defaultWorld(call, a),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  await env.begin();
  empty = true;
  await env.wait(5 * MINUTE);
  assert.match(env.text(F(1, 'next')), /^No predicted departure \(read 10:05\)$/);
  assert.match(env.text(F(1, 'second')), /^No following departure/);
  assert.equal(env.text(F(1, 'departures')), 0);
});

test('the line filter keeps its lines; alerts of the stop, its lines, its agency', async (t) => {
  const api = createApi((call, a) => {
    const now = a.clock.wall();
    if (call.kind === 'alerts') {
      return alertsFeed(now, [
        alertEntity(1, { route: '49', text: 'Line 49 detour.' }),
        alertEntity(2, { route: '22' }),
        alertEntity(3, { stop: '15553', text: 'Stop moved.' }),
        alertEntity(4, { agency: 'BA' }),
        alertEntity(5, { route: '49', start: Math.floor(now / 1000) + 3600 }),
      ]);
    }
    return defaultWorld(call, a);
  });
  const env = await setup({ config: { ...HOME, stop1_lines: '49' }, api });
  t.after(() => env.app.stop());
  await env.begin();
  assert.match(env.text(F(1, 'next')), /^49 VAN NESS → Downtown: 12 min/);
  assert.match(env.text(F(1, 'second')), /^No following departure/);
  assert.equal(env.text(F(1, 'departures')), 1);
  assert.equal(env.text(F(1, 'alerts')), 2);
  assert.equal(env.text(F(1, 'alert_text')), 'Line 49 detour. (+1 more)');
});

test('the alerts of an agency: one request for its stops, every 15 min', async (t) => {
  const config = { ...TWO, stop3_agency: 'SF', stop3_code: '15554' };
  const env = await setup({ config });
  t.after(() => env.app.stop());
  await env.begin();
  await env.wait(HOUR - 31 * SECOND);
  const sf = env.api.calls.filter((c) => c.kind === 'alerts' && c.agency === 'SF');
  assert.equal(sf.length, 4);
  assert.ok(sf.every((c, i) => i === 0 || c.at - sf[i - 1].at >= 15 * MINUTE - SECOND));
});

test('getConfig failing on a connection: retried, the status says so, then reads', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let fails = 2;
  env.gladys.getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('Gladys busy');
    }
    return real();
  };
  const connecting = env.app.connected();
  await env.wait(0);
  assert.match(env.status().message.en, /could not be read from Gladys; new try in 5 s/);
  await env.wait(5 * SECOND);
  assert.match(env.status().message.en, /new try in 10 s/);
  await env.wait(10 * SECOND);
  await connecting;
  await env.wait(30 * SECOND);
  assert.equal(env.api.count('dep'), 1);
});

test('no timer after stop; no timer armed on an infinite or negative delay', async () => {
  const env = await setup({ config: TWO });
  await env.begin();
  await env.wait(HOUR);
  await env.app.stop();
  const before = env.api.calls.length;
  await env.wait(3 * HOUR);
  assert.equal(env.api.calls.length, before);
  assert.equal(env.clock.pending, 0, 'nothing left armed');
  assert.ok(
    env.delays.every((d) => Number.isFinite(d) && d >= 0 && d <= HOUR),
    env.delays.join(),
  );
});

test('the token is never in the logs, the statuses nor /data', async (t) => {
  const store = createMemoryStore();
  const api = createApi((call, a) => (call.kind === 'alerts' ? 'network' : errorAnswer(a, 401)));
  const env = await setup({ store, api, config: { ...HOME, stop1_lines: 'not,valid,line,!' } });
  t.after(() => env.app.stop());
  await env.begin();
  await env.app.start({ ...HOME, api_key: 'bad key\r\nX: 1' }, { saved: true });
  await env.wait(SECOND);
  const all = [
    env.lines.join('\n'),
    JSON.stringify(env.fake.connectionStatuses),
    JSON.stringify(store.data),
    env.app.testConnection().en,
  ].join('\n');
  assert.ok(!all.includes(KEY));
  assert.ok(!all.includes('bad key'));
  assert.match(env.status().message.en, /api_key \(not a 511 token\)/);
});

test('the test button and Discovery never read', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  await env.begin();
  const before = env.api.calls.length;
  for (let i = 0; i < 5; i += 1) {
    await env.fake.action('test', {});
    await env.fake.scanRequest?.();
    await env.app.scan();
  }
  await env.app.start(env.gladys.config, { saved: true });
  await env.wait(SECOND);
  assert.equal(env.api.calls.length, before, 'an unchanged configuration saved never reads sooner');
  assert.match(env.app.testConnection().en, /Requests in the last hour: 2 \(54 at most\)/);
});

test('the French texts', async (t) => {
  const env = await setup({ config: { ...HOME, language: 'fr' } });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(env.text(F(1, 'next')), '14 MISSION → Downtown: 3 min (10:03)');
  assert.match(env.text(F(1, 'alert_text')), /^Aucune alerte \(lu à 10:0\d\)$/);
  assert.match(
    env.status().message.fr,
    /Plan : 16 requêtes par heure au plus pour une limite de 60/,
  );
});

test('a BOM before the JSON (as 511 sometimes sends) is read', async (t) => {
  const api = createApi((call, a) =>
    json(defaultWorld(call, a), { date: a.clock.wall(), bom: true }),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(env.text(F(1, 'departures')), 2);
  assert.equal(env.text(F(1, 'alerts')), 0);
});

test('a last read in the future in /data is not believed: one interval from now', async (t) => {
  const store = createMemoryStore({ depAt: START + 10 * HOUR });
  const env = await setup({ store });
  t.after(() => env.app.stop());
  await env.app.start(env.gladys.config);
  await env.wait(4 * MINUTE);
  assert.equal(env.api.count('dep'), 0);
  await until(env, () => env.api.count('dep') === 1, { max: 2 * MINUTE });
});

test('an alerts feed whose header is 7 h old is stale: no alert count', async (t) => {
  const api = createApi((call, a) =>
    call.kind === 'alerts'
      ? alertsFeed(a.clock.wall() - 7 * HOUR, [alertEntity(1)])
      : defaultWorld(call, a),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(api.count('alerts'), 1);
  assert.equal(env.text(F(1, 'alerts')), undefined);
  assert.match(env.status().message.en, /alerts feed not updated/);
  assert.equal(env.text(F(1, 'departures')), 2);
});

test('/data holds every request before it leaves (a crash right after still counts it)', async (t) => {
  const store = createMemoryStore();
  const seen = [];
  const api = createApi((call, a) => {
    seen.push([store.data?.quota?.length ?? 0, a.calls.length]);
    return defaultWorld(call, a);
  });
  const env = await setup({ store, api, config: TWO });
  t.after(() => env.app.stop());
  await env.begin();
  // Within the first hour: nothing has left the window yet.
  await env.wait(50 * MINUTE);
  assert.ok(seen.length > 10);
  for (const [saved, sent] of seen) assert.equal(saved, sent);
});

test('timers: never infinite, never negative, an hour at most; rounds a second apart at least', async (t) => {
  const { SfBayApp } = await import('../src/app.js');
  assert.equal(SfBayApp.delay(Infinity), HOUR);
  assert.equal(SfBayApp.delay(NaN), HOUR);
  assert.equal(SfBayApp.delay(-5), 0);
  assert.equal(SfBayApp.delay(3 * HOUR), HOUR);
  assert.equal(SfBayApp.delay(1500), 1500);
  const env = await setup();
  t.after(() => env.app.stop());
  await env.begin();
  let ticks = 0;
  const tick = env.app.tick.bind(env.app);
  env.app.tick = (gen) => {
    ticks += 1;
    return tick(gen);
  };
  // A planner bug that always says "due now" must not spin.
  env.app.nextDelay = () => 0;
  env.app.arm(0, env.app.gen);
  await env.wait(MINUTE);
  assert.ok(ticks >= 30 && ticks <= 62, String(ticks));
});

test('an unconfirmed stop (lines unknown) never spins the rounds', async (t) => {
  const api = createApi((call, a) =>
    call.kind === 'dep' ? stopMonitoring(a.clock.wall(), []) : defaultWorld(call, a),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  let ticks = 0;
  const tick = env.app.tick.bind(env.app);
  env.app.tick = (gen) => {
    ticks += 1;
    return tick(gen);
  };
  await env.begin();
  await env.wait(HOUR);
  assert.equal(api.count('alerts'), 0);
  assert.ok(ticks <= 30, String(ticks));
});

test('alerts in 500 and a restart loop: one alerts request per interval, back-off kept in /data', async () => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.kind === 'alerts' ? errorAnswer(a, 500) : defaultWorld(call, a),
  );
  for (let i = 0; i < 10; i += 1) {
    const env = await setup({ store, api, start: START + i * 40 * SECOND });
    await env.app.connected();
    await env.wait(30 * SECOND);
    await env.app.stop();
  }
  assert.equal(api.count('alerts'), 1, 'never sooner than the interval after a restart');
  assert.ok(store.data.alertsAt.SF >= START);
  assert.equal(store.data.alertsLevel.SF, 1);
  // The next one after 15 min (level 1), then 30 min (level 2), kept across restarts too.
  const later = await setup({ store, api, start: START + 16 * MINUTE });
  await later.app.connected();
  await later.wait(30 * SECOND);
  await later.app.stop();
  assert.equal(api.count('alerts'), 2);
  assert.equal(store.data.alertsLevel.SF, 2);
  const again = await setup({ store, api, start: START + 30 * MINUTE });
  await again.app.connected();
  await again.wait(10 * MINUTE);
  await again.app.stop();
  assert.equal(api.count('alerts'), 2, 'level 2: 30 min after the last attempt');
});

test('an alerts feed without a header time is never "no alert"', async (t) => {
  const api = createApi((call, a) =>
    call.kind === 'alerts'
      ? { Header: { GtfsRealtimeVersion: '1.0' }, Entities: [] }
      : defaultWorld(call, a),
  );
  const env = await setup({ api });
  t.after(() => env.app.stop());
  await env.begin();
  assert.equal(api.count('alerts'), 1);
  assert.equal(env.text(F(1, 'alerts')), undefined);
  assert.match(env.status().message.en, /alerts feed without a time/);
});

test('a line filter that matches no visit, read after read, is said in the status', async (t) => {
  const env = await setup({ config: { ...HOME, stop1_lines: '99' } });
  t.after(() => env.app.stop());
  await env.begin();
  assert.doesNotMatch(env.status().message.en, /check the line filter/);
  await env.wait(11 * MINUTE);
  assert.match(env.status().message.en, /none of the filtered lines in the last 3 reads/);
  assert.match(env.status().message.fr, /vérifiez le filtre de lignes/);
});

test('a new token saved is used at once, not at the next interval', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  await env.begin();
  const before = env.api.count('dep');
  await env.app.start({ ...HOME, api_key: 'another-token-9876543210' }, { saved: true });
  await env.wait(10 * SECOND);
  assert.equal(env.api.count('dep'), before + 1);
  assert.equal(env.api.calls.at(-1).key, 'another-token-9876543210');
});
