// -----------------------------------------------------------------------------
// The quota of the token: the plan never puts more than 90 % of the limit in
// any sliding hour, and the guard counts what was sent, across a restart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOURLY_LIMIT_MAX, HOURLY_LIMIT_MIN, REFRESH_MAX, REFRESH_MIN } from '../src/constants.js';
import { Quota, plan, roundsPerHour } from '../src/quota.js';

const HOUR = 3600_000;

test('the plan fits 90 % of the limit for every configuration', () => {
  for (const hourlyLimit of [HOURLY_LIMIT_MIN, 21, 30, 45, 60, 61, 100, 500, HOURLY_LIMIT_MAX]) {
    for (let stops = 1; stops <= 5; stops += 1) {
      for (let agencies = 1; agencies <= stops; agencies += 1) {
        for (let refreshMinutes = REFRESH_MIN; refreshMinutes <= REFRESH_MAX; refreshMinutes += 1) {
          for (const alerts of [true, false]) {
            const p = plan({ stops, agencies, refreshMinutes, hourlyLimit, alerts });
            const label = JSON.stringify({
              hourlyLimit,
              stops,
              agencies,
              refreshMinutes,
              alerts,
              p,
            });
            assert.ok(p.perHour <= p.budget, label);
            assert.ok(p.budget <= hourlyLimit * 0.9, label);
            assert.ok(p.depEvery >= refreshMinutes, `never faster than asked ${label}`);
            assert.ok(p.depEvery <= 60, label);
            const worst =
              stops * roundsPerHour(p.depEvery) +
              (alerts ? agencies * roundsPerHour(p.alertsEvery) : 0);
            assert.equal(worst, p.perHour, label);
            if (alerts) {
              assert.ok(p.alertsEvery >= 15, label);
              assert.ok(agencies * roundsPerHour(p.alertsEvery) <= Math.floor(p.budget / 3), label);
            } else assert.equal(p.alertsEvery, null);
          }
        }
      }
    }
  }
});

test('the default token: one stop every 5 min with alerts; five stops are lengthened', () => {
  assert.deepEqual(
    plan({ stops: 1, agencies: 1, refreshMinutes: 5, hourlyLimit: 60, alerts: true }),
    {
      budget: 54,
      depEvery: 5,
      alertsEvery: 15,
      perHour: 16,
    },
  );
  const five = plan({ stops: 5, agencies: 3, refreshMinutes: 2, hourlyLimit: 60, alerts: true });
  assert.equal(five.budget, 54);
  assert.equal(five.alertsEvery, 15);
  assert.equal(five.depEvery, 8, '5 stops: 8 rounds of 5 within the 42 left');
  assert.equal(five.perHour, 52);
  assert.equal(roundsPerHour(7), 9, 'rounds 7 min apart: 9 in a sliding hour, not 8.6');
});

test('the guard: the budget in the last hour, then the wait until the oldest leaves', () => {
  const quota = new Quota(3);
  quota.take(0);
  quota.take(10);
  assert.equal(quota.waitFor(20), 0);
  quota.take(20);
  assert.equal(quota.waitFor(30), HOUR - 30);
  assert.equal(quota.used(HOUR - 1), 3);
  assert.equal(quota.waitFor(HOUR), 0, 'the first left the window');
  assert.equal(quota.used(HOUR + 20), 0);
});

test('the guard across a restart: wall times in /data, a future time counts as now', () => {
  const quota = new Quota(54);
  const wall = 1_800_000_000_000;
  for (let i = 0; i < 10; i += 1) quota.take(1000 + i);
  const times = quota.toWall(2000, wall);
  assert.equal(times.length, 10);
  const back = new Quota(54);
  back.loadWall([...times, wall + 10 * HOUR, wall - 2 * HOUR, 'x', null, -1], 50, wall);
  assert.equal(back.used(50), 11, 'ten of the hour, one of the future');
  assert.equal(back.used(50 + HOUR - 1), 1, 'the future one counted from the restart');
  assert.equal(back.used(50 + HOUR), 0);
  const full = new Quota(3);
  full.loadWall([wall - 10, wall - 20, wall - 30], 0, wall);
  assert.ok(full.waitFor(0) > HOUR - 100);
});
