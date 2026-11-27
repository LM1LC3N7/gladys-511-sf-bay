// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted 511 and a virtual clock
// (gladys-testkit `testClock`: each clock read moves 1 µs, timers fire only
// through `advance`). The answers follow the 511 specification (appendix
// B.1.10 and B.1.16) and the shape of the live API (`ServiceDelivery` at the
// top, lists): no real token was used. 511 answers through a
// `world(call, api)` function: a JSON body (200, dated by the virtual clock),
// a Response, 'timeout' (never answers), 'network' (refused), or a promise
// of one of them (a slow answer).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SfBayApp } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'sfbay';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** A token of the right shape, never a real one; searched for in logs, statuses and /data. */
export const KEY = 'test-token-0123456789abcdef';
export const START = Date.UTC(2026, 10, 27, 18, 0, 0);

export const HOME = { api_key: KEY, stop1_agency: 'SF', stop1_code: '15553' };
export const TWO = {
  ...HOME,
  stop2_agency: 'BA',
  stop2_code: '901801',
  stop2_name: 'BART home',
};

/** A feature id: the device is the slot, the agency and the code. */
export const F = (
  slot,
  key,
  agency = slot === 2 ? 'BA' : 'SF',
  code = slot === 2 ? '901801' : '15553',
) => `ext:${SELECTOR}:stop:${slot}-${agency}-${code}:${key}`;
export const D = (
  slot,
  agency = slot === 2 ? 'BA' : 'SF',
  code = slot === 2 ? '901801' : '15553',
) => `ext:${SELECTOR}:stop:${slot}-${agency}-${code}`;

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One SIRI visit (live shape): `minutes` from `now`. */
export function visit(now, minutes, over = {}) {
  const {
    line = '14',
    name = 'MISSION',
    destination = 'Downtown',
    stop = '15553',
    expected = true,
  } = over;
  const time = iso(now + minutes * MINUTE);
  return {
    RecordedAtTime: iso(now),
    MonitoringRef: stop,
    MonitoredVehicleJourney: {
      LineRef: line,
      DirectionRef: 'IB',
      FramedVehicleJourneyRef: {
        DataFrameRef: '2026-11-27',
        DatedVehicleJourneyRef: `t${minutes}`,
      },
      PublishedLineName: name,
      OperatorRef: 'SF',
      DestinationName: destination,
      Monitored: true,
      MonitoredCall: {
        StopPointRef: stop,
        StopPointName: 'Mission St & 16th St',
        DestinationDisplay: destination,
        AimedArrivalTime: time,
        ExpectedArrivalTime: expected ? time : null,
        AimedDepartureTime: time,
        ExpectedDepartureTime: expected ? time : null,
      },
    },
  };
}

/** A StopMonitoring answer as the live API sends it. */
export const stopMonitoring = (now, visits) => ({
  ServiceDelivery: {
    ResponseTimestamp: iso(now),
    ProducerRef: 'SF',
    Status: true,
    StopMonitoringDelivery: {
      version: '1.4',
      ResponseTimestamp: iso(now),
      Status: true,
      MonitoredStopVisit: visits,
    },
  },
});

/** One GTFS-RT alert entity as 511 writes it (PascalCase, spec B.1.16). */
export function alertEntity(
  id,
  { agency = 'SF', route = null, stop = null, start, end, text } = {},
) {
  const selector = { AgencyId: agency, RouteId: route, StopId: stop, Trip: null };
  return {
    Id: String(id),
    TripUpdate: null,
    Vehicle: null,
    Alert: {
      ActivePeriods: [{ Start: start ?? 0, End: end ?? 0 }],
      InformedEntities: [selector],
      cause: 1,
      effect: 8,
      HeaderText: { Translations: [{ Text: text ?? `Synthetic alert ${id}.`, Language: 'en' }] },
      DescriptionText: { Translations: [{ Text: 'Synthetic description.', Language: 'en' }] },
    },
  };
}

export const alertsFeed = (now, entities = []) => ({
  Header: { GtfsRealtimeVersion: '1.0', incrementality: 0, Timestamp: Math.floor(now / 1000) },
  Entities: entities,
});

export function json(body, { status = 200, date, headers = {}, bom = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(`${bom ? '﻿' : ''}${text}`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(date === null || date === undefined ? {} : { date: new Date(date).toUTCString() }),
      ...headers,
    },
  });
}

export const errorAnswer = (api, status, headers = {}) =>
  json(status === 401 ? 'This API key provided is invalid.' : 'error', {
    status,
    date: api.clock.wall(),
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });

const abortable = (signal, kind) =>
  new Promise((_, reject) => {
    if (kind === 'network') reject(new TypeError('fetch failed'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** What a request asks: `{ kind: 'dep' | 'alerts', agency, stop, key }`. */
export function readRequest(url) {
  const u = new URL(url);
  const kind = u.pathname.endsWith('/StopMonitoring')
    ? 'dep'
    : u.pathname.endsWith('/servicealerts')
      ? 'alerts'
      : 'other';
  return {
    kind,
    agency: u.searchParams.get('agency'),
    stop: u.searchParams.get('stopCode'),
    key: u.searchParams.get('api_key'),
    format: u.searchParams.get('format'),
  };
}

/** The default 511: two departures (3 and 12 min) at every stop, no alert. */
export function defaultWorld(call, api) {
  const now = api.clock.wall();
  if (call.kind === 'dep')
    return stopMonitoring(now, [visit(now, 3), visit(now, 12, { line: '49', name: 'VAN NESS' })]);
  if (call.kind === 'alerts') return alertsFeed(now, []);
  return 'network';
}

/** A scripted 511: every request is recorded with the virtual time. */
export function createApi(world = defaultWorld) {
  const api = { world, calls: [], open: 0, peak: 0, clock: null };
  api.fetch = async (url, init) => {
    const call = { url: String(url), ...readRequest(String(url)), init, at: api.clock.elapsed };
    api.calls.push(call);
    api.open += 1;
    api.peak = Math.max(api.peak, api.open);
    try {
      const answer = await api.world(call, api);
      if (answer === 'timeout' || answer === 'network')
        return await abortable(init?.signal, answer);
      if (answer instanceof Response) return answer;
      return json(answer, { date: api.clock.wall() });
    } finally {
      api.open -= 1;
    }
  };
  api.count = (kind) => api.calls.filter((c) => c.kind === kind).length;
  return api;
}

/** The devices of a configuration as created by the user in Gladys. */
export function createdDevices(config) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevices(gladys, normalizeConfig(config));
}

export async function setup({
  config = HOME,
  devices,
  store = createMemoryStore(),
  api = createApi(),
  created = true,
  start = START,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? (created ? createdDevices(config) : []),
  });
  await gladys.connect();
  const clock = testClock({ start });
  clock.wall = () => clock.now() + wall.offset;
  api.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const delays = [];
  const timers = {
    ...clock.timers,
    setTimeout: (fn, ms, ...args) => {
      delays.push(ms);
      return clock.timers.setTimeout(fn, ms, ...args);
    },
  };
  const app = new SfBayApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.wall(),
    monotonic: clock.monotonic,
    timers,
    store,
    fetchImpl: api.fetch,
  });
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  /** Starts and lets the first round end (its requests are 2 s apart). */
  const begin = async (cfg = config, options) => {
    await app.start(cfg, options);
    await wait(0);
    await wait(30 * SECOND);
  };
  const status = () => gladys.fake.connectionStatus;
  const text = (id) => gladys.fake.lastState(id);
  return {
    app,
    gladys,
    fake: gladys.fake,
    clock,
    store,
    api,
    wait,
    begin,
    lines,
    wall,
    delays,
    status,
    text,
  };
}

/** Waits (virtual time, bounded) until `predicate()` holds; throws otherwise. */
export async function until(env, predicate, { step = SECOND, max = 2 * HOUR } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    if (predicate()) return;
    await env.wait(step);
  }
  throw new Error('condition never met within the bound');
}
