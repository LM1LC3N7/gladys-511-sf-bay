// -----------------------------------------------------------------------------
// On the real clock (sped up): the departures are read at their interval,
// measured on the decision (never faster, never a cycle late), the requests
// 2 s apart at least, and nothing runs after stop().
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SfBayApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { createApi, createdDevices, TWO } from './helpers/setup.js';

test('the departures every 3 minutes on the real clock (x600): 2 stops at 2 min lengthened', async (t) => {
  const config = { ...TWO, refresh_minutes: '2', alerts: 'off' };
  const clock = realClock({ speed: 600 });
  const api = createApi();
  api.clock = { ...clock, elapsed: 0, wall: clock.now };
  Object.defineProperty(api.clock, 'elapsed', { get: () => clock.monotonic() });
  const gladys = createFakeGladys({ selector: 'sfbay', config, devices: createdDevices(config) });
  await gladys.connect();
  const app = new SfBayApp({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: api.fetch,
  });
  t.after(async () => {
    await app.stop();
    clock.close();
  });
  const spy = spyOn(app, 'readDepartures', clock);
  await app.start(config);
  assert.equal(app.plan.depEvery, 3, '2 stops every 2 min would be 60 requests an hour');
  const gaps = await measurePeriod(spy, { count: 4, period: 180_000, timeoutMs: 10_000 });
  assert.equal(gaps.length, 3);
  const starts = api.calls.map((c) => c.at);
  const between = starts.slice(1).map((v, i) => v - starts[i]);
  assert.ok(Math.min(...between) >= 2000 - 50, `requests ${between.join(', ')} ms apart`);
  await app.stop();
  const before = api.calls.length;
  await clock.sleep(10 * 60_000);
  assert.equal(api.calls.length, before, 'nothing after stop()');
});
