// -----------------------------------------------------------------------------
// The integration: reads the next visits of each watched stop
// (StopMonitoring) and the service alerts of their agencies from the 511 SF
// Bay Open Data API, publishes what each stop sees, and tells in the status
// exactly where each stop stands and how much of the quota is used.
//
// The quota of the token (60 requests per hour by default) is the first rule:
//   - `plan()` lengthens the intervals so that the worst sliding hour stays
//     within 90 % of the limit (one request per stop per departures round, one
//     per agency per alerts round, the alerts a third of it at most);
//   - every request sent is counted, and none is sent when the last hour
//     already holds that budget (it waits up to 2 min for a slot, else it is
//     skipped); the counted requests are written to /data BEFORE the request,
//     so a restart knows them; a /data that cannot tell them makes the first
//     reads wait one interval;
//   - one request at a time, 2 s apart; a 429 pauses every read (Retry-After,
//     else 10 min doubled, 6 h at most, kept in /data); a 5xx of the departures
//     pauses every read too (2 min doubled); the alerts are secondary: their
//     failures are spaced out for their agency only;
//   - a 401 of the departures is a refused token: kept in /data (a short
//     fingerprint), nothing read again until a new token is saved; a 401 of
//     the alerts is never taken as a refused token.
//
// Never a value without proof: a departure is counted against the response
// time of 511, which must be within 5 minutes of the local clock; a failed or
// unreadable read publishes nothing (never 0); "no departure" is told only
// for a stop where 511 has shown a visit once; an alert count only for a stop
// whose lines are known (filter typed, or lines seen there).
//
// Clocks: the decisions (gap, quota, pause, interval) use the monotonic
// clock, read once per decision; the wall clock serves only /data (restart)
// and the times shown.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { alertsUrl, getJson, stopMonitoringUrl } from './api.js';
import { normalizeConfig } from './config.js';
import {
  ALERTS_RETRY_MAX,
  CLOCK_SKEW,
  CONFIG_RETRY_FIRST,
  CONFIG_RETRY_MAX,
  CONNECTED_INTERVALS,
  FEATURES,
  HORIZON,
  HOUR,
  LEAVING_GRACE,
  MINUTE,
  ALERTS_STALE,
  PAUSE_429_FIRST,
  PAUSE_5XX_FIRST,
  PAUSE_MAX,
  PAUSE_MIN,
  QUOTA_WAIT_MAX,
  REQUEST_GAP,
  SECOND,
  SEEN_LINES_KEEP,
  SEEN_LINES_MAX,
  STATUS_MAX,
  STOP_RETRY,
  TEXT_MAX,
  WINDOW_MINUTES,
} from './constants.js';
import { buildDevices, stopIds } from './devices.js';
import {
  M,
  alertText,
  configErrors,
  departureText,
  failure,
  formatClock,
  stopLabel,
} from './i18n.js';
import { Quota, plan } from './quota.js';
import { alertsForStop, readAlerts, readStopMonitoring } from './siri.js';
import { createFileStore } from './store.js';

const SAVE_BOUND = 2 * SECOND;
const GLADYS_BOUND = 10 * SECOND;
/** A timer is never armed longer than this (nor on a non-finite delay). */
const TIMER_MAX = HOUR;
/** A round due within this is run now (a timer may fire a little early). */
const DUE_SLACK = SECOND;
const QUOTA_KEEP_MAX = 2000;
/** Reads in a row without any visit of the filtered lines before the status warns. */
const FILTER_MISS_WARN = 3;

const isTime = (value) => Number.isFinite(value) && value > 0;
const NO_PAUSE = () => ({ until: null, kind: null, status: null, level429: 0, level5xx: 0 });
const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The departures of a stop at the time `at` of the answer, soonest first:
 * the lines of the filter only (LineRef or published name), nothing gone more
 * than a minute ago, nothing beyond 24 h; minutes rounded down.
 */
export function departuresAt(visits, stop, at) {
  const filter = new Set(stop.lines.map((l) => l.toLowerCase()));
  const list = [];
  for (const visit of visits) {
    if (
      filter.size > 0 &&
      !filter.has(visit.line.toLowerCase()) &&
      !filter.has(visit.lineName.toLowerCase())
    ) {
      continue;
    }
    const delta = visit.time - at;
    if (delta < -LEAVING_GRACE || delta > HORIZON) continue;
    list.push({ ...visit, minutes: Math.max(0, Math.floor(delta / MINUTE)) });
  }
  return list.sort((a, b) => a.time - b.time);
}

/** The departures within the counter window (60 min). */
export const countWithin = (departures, at) =>
  departures.filter((d) => d.time - at <= WINDOW_MINUTES * MINUTE).length;

/** The wait before the next alerts read after `level` failures in a row (0: the interval). */
export const alertsDelay = (every, level) =>
  level <= 0 ? every : Math.min(every * 2 ** (level - 1), Math.max(every, ALERTS_RETRY_MAX));

export class SfBayApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    apiBase,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;

    /** Bumped by every start and stop: an older round goes quiet. */
    this.gen = 0;
    /** Bumped by every connection and disconnection (config retry loop). */
    this.connGen = 0;
    this.config = null;
    this.plan = null;
    this.timer = null;
    this.sleeps = new Set();
    this.pendingStart = undefined;
    this.starting = null;
    this.inRound = false;
    this.stopped = false;

    this.quota = new Quota(0);
    this.lastRequestMono = -Infinity;
    this.inflight = null;
    this.pauseUntilMono = null;
    this.depDueMono = null;
    /** Per agency: `{ dueMono, level }` of the next alerts read. */
    this.alertsDue = new Map();
    /** Per stop (agency|code): the monotonic time before which it is not read (400, 404). */
    this.stopRetry = new Map();
    /** Per stop: reads in a row whose visits match none of the filtered lines. */
    this.filterMiss = new Map();
    /** Per slot: `{ key, dep, alerts }`, what the status tells. */
    this.results = new Map();
    /** The full hash of a token 511 refused in this process (memory only). */
    this.refusedHash = null;
    this.refused = false;
    this.keyHash = null;
    this.lastStatus = null;
    this.lastStopsKey = null;

    this.loaded = false;
    this.storeStatus = 'absent';
    this.persisted = { stops: {}, alertsAt: {}, alertsLevel: {} };
    /** Whether /data tells the requests sent before this start (null: not known yet). */
    this.dataTells = null;
    this.saveFailed = false;
    this.startMono = this.monotonic();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A connection to Gladys: read the configuration, then start. A failing
   * `getConfig()` is retried forever, spaced out (5 s doubled up to 5 min),
   * with the status saying so.
   */
  async connected() {
    const conn = ++this.connGen;
    this.stopped = false;
    // A new connection: Gladys gets the status again, even unchanged.
    this.lastStatus = null;
    let delay = CONFIG_RETRY_FIRST;
    for (;;) {
      let raw;
      try {
        raw = await this.bounded(() => this.gladys.getConfig());
      } catch (err) {
        if (conn !== this.connGen) return;
        this.logger.warn(
          `Configuration not read (${err?.name ?? 'Error'}); retry in ${delay / SECOND} s`,
        );
        await this.setStatus(
          false,
          M.configRetry({ seconds: Math.round(delay / SECOND) }),
          this.gen,
        );
        await this.sleep(delay);
        if (conn !== this.connGen) return;
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);
        continue;
      }
      if (conn !== this.connGen) return;
      await this.start(raw);
      return;
    }
  }

  async disconnected() {
    this.connGen += 1;
    await this.stop();
  }

  /**
   * Apply a configuration. `saved`: the user saved it (a new try of a token
   * refused before a restart). Configurations saved in a row apply one after
   * the other, the last one winning.
   */
  start(raw, { saved = false } = {}) {
    this.stopped = false;
    this.pendingStart = { raw, saved: saved || this.pendingStart?.saved === true };
    if (!this.starting) {
      this.starting = (async () => {
        try {
          while (this.pendingStart) {
            const next = this.pendingStart;
            this.pendingStart = undefined;
            await this.applyConfig(next.raw, next.saved);
          }
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  async stop() {
    this.gen += 1;
    this.stopped = true;
    this.cancelTimers();
    await this.persist();
  }

  /** Waits for the start in progress and the request in flight (tests). */
  async idle() {
    while (this.starting || this.inflight) {
      await this.starting;
      await this.inflight;
    }
  }

  cancelTimers() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    for (const sleep of this.sleeps) {
      this.timers.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  /** A timer delay: finite, never negative, never longer than TIMER_MAX. */
  static delay(ms) {
    if (!Number.isFinite(ms)) return TIMER_MAX;
    return Math.min(Math.max(0, ms), TIMER_MAX);
  }

  /** A wait on the injected timers, released at once by a stop. */
  sleep(ms) {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      const entry = { resolve };
      entry.timer = this.timers.setTimeout(() => {
        this.sleeps.delete(entry);
        resolve();
      }, SfBayApp.delay(ms));
      this.sleeps.add(entry);
    });
  }

  arm(delay, gen) {
    if (gen !== this.gen || this.stopped) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick(gen).catch((err) => {
        this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
      });
    }, SfBayApp.delay(delay));
  }

  stopKey(stop) {
    return `${stop.agency}|${stop.code}`;
  }

  /** A salted fingerprint of a stop: never the stop in clear in /data. */
  stopPrint(stop) {
    return sha(`${this.persisted.salt}|${stop.agency}|${stop.code}`).slice(0, 32);
  }

  /** A short (8-bit) salted fingerprint of a token: enough to keep a refusal, never to find the token. */
  keyPrint(key) {
    return sha(`${this.persisted.salt}|key|${key}`).slice(0, 2);
  }

  async applyConfig(raw, saved) {
    this.gen += 1;
    const gen = this.gen;
    this.cancelTimers();
    const config = normalizeConfig(raw);
    this.config = config;
    this.load();
    for (const error of config.errors) {
      this.logger.warn(`Configuration: field ${error.field} refused (${error.code})`);
    }
    await this.publishDevices();
    if (gen !== this.gen) return;
    const errors = configErrors(config.errors);
    const withErrors = (message) => ({
      en: `${message.en} ${errors.en}`.trim(),
      fr: `${message.fr} ${errors.fr}`.trim(),
    });
    if (!config.key) {
      await this.setStatus(false, withErrors(M.noKey), gen);
      return;
    }
    if (config.stops.length === 0) {
      await this.setStatus(false, withErrors(M.noStop), gen);
      return;
    }

    // A refused token is never sent again on its own: only a token saved by
    // the user that is not the one refused in this process is tried.
    this.keyHash = sha(config.key);
    const print = this.keyPrint(config.key);
    if (saved && this.refusedHash !== this.keyHash) {
      this.refusedHash = null;
      if (this.persisted.refused) {
        this.persisted.refused = null;
        await this.persist();
        if (gen !== this.gen) return;
      }
    }
    this.refused = this.refusedHash === this.keyHash || this.persisted.refused?.print === print;
    if (this.refused) {
      await this.updateStatus(gen);
      return;
    }

    const agencies = [...new Set(config.stops.map((s) => s.agency))];
    this.plan = plan({
      stops: config.stops.length,
      agencies: agencies.length,
      refreshMinutes: config.refreshMinutes,
      hourlyLimit: config.hourlyLimit,
      alerts: config.alerts,
    });
    this.quota.budget = this.plan.budget;
    if (this.dataTells === null) await this.checkData();
    if (gen !== this.gen) return;

    // When is each read due? One reading of both clocks for the decision.
    const wall = this.now();
    const mono = this.monotonic();
    const depEvery = this.plan.depEvery * MINUTE;
    const alertsEvery = (this.plan.alertsEvery ?? 0) * MINUTE;
    const stopsKey = JSON.stringify([config.stops, this.plan, config.alerts, this.keyHash]);
    const changed = this.lastStopsKey !== null && this.lastStopsKey !== stopsKey;
    const first = this.lastStopsKey === null;
    this.lastStopsKey = stopsKey;
    // Results of stops no longer configured (or changed) are forgotten.
    for (const [slot, result] of [...this.results]) {
      const stop = config.stops.find((s) => s.slot === slot);
      if (!stop || result.key !== this.stopKey(stop)) this.results.delete(slot);
    }
    const dueFrom = (lastAt, every) => {
      // /data cannot tell the requests before this start: one interval.
      if (!this.dataTells) return this.startMono + every;
      if (!isTime(lastAt)) return mono;
      // A time in the future is not believed: one interval from now.
      if (lastAt > wall) return mono + every;
      return mono + Math.max(0, lastAt + every - wall);
    };
    if (first) {
      this.depDueMono = dueFrom(this.persisted.depAt, depEvery);
    } else if (changed) {
      // Another stop list or plan: read now (the quota guard still holds).
      this.depDueMono = Math.min(this.depDueMono ?? mono, mono);
    }
    for (const agency of [...this.alertsDue.keys()]) {
      if (!agencies.includes(agency) || !config.alerts) this.alertsDue.delete(agency);
    }
    if (config.alerts) {
      for (const agency of agencies) {
        if (this.alertsDue.has(agency)) continue;
        // After a restart: the attempt in /data plus its back-off (failures in a row).
        const level = first ? (this.persisted.alertsLevel[agency] ?? 0) : 0;
        const dueMono = first
          ? dueFrom(this.persisted.alertsAt[agency], alertsDelay(alertsEvery, level))
          : mono;
        this.alertsDue.set(agency, { dueMono, level });
      }
    }
    const pause = this.persisted.pause;
    if (pause && isTime(pause.until) && pause.until > wall && pause.until - wall <= PAUSE_MAX) {
      const left = pause.until - wall;
      if (this.pauseUntilMono === null || this.pauseUntilMono < mono + left) {
        this.pauseUntilMono = mono + left;
      }
    }
    await this.updateStatus(gen);
    if (gen !== this.gen) return;
    this.arm(this.nextDelay(this.monotonic()), gen);
  }

  /**
   * Whether /data tells the requests sent before this start: readable and
   * writable (checked by writing it back before any read).
   */
  async checkData() {
    if (this.storeStatus === 'unreadable') this.dataTells = false;
    else {
      this.dataTells = await this.persist();
      if (!this.dataTells) this.saveFailed = true;
    }
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    let result;
    try {
      result = this.store.load();
    } catch {
      result = { status: 'unreadable', data: {} };
    }
    this.storeStatus = result.status;
    if (result.status === 'unreadable') {
      this.logger.warn(
        'The state file of /data is unreadable: left untouched, running from memory',
      );
    }
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const persisted = { stops: {}, alertsAt: {}, alertsLevel: {}, refused: null };
    persisted.salt =
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : randomBytes(16).toString('hex');
    if (isTime(data.depAt)) persisted.depAt = data.depAt;
    if (data.alertsAt && typeof data.alertsAt === 'object') {
      for (const [agency, at] of Object.entries(data.alertsAt).slice(0, 20)) {
        if (/^[A-Z0-9]{1,10}$/.test(agency) && isTime(at)) persisted.alertsAt[agency] = at;
      }
    }
    if (data.alertsLevel && typeof data.alertsLevel === 'object') {
      for (const [agency, level] of Object.entries(data.alertsLevel).slice(0, 20)) {
        if (
          /^[A-Z0-9]{1,10}$/.test(agency) &&
          Number.isInteger(level) &&
          level >= 0 &&
          level <= 10
        ) {
          persisted.alertsLevel[agency] = level;
        }
      }
    }
    if (data.pause && typeof data.pause === 'object') {
      const level = (n) => (Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0);
      persisted.pause = {
        until: isTime(data.pause.until) ? data.pause.until : null,
        kind: data.pause.kind === 'server' ? 'server' : 'rate',
        status:
          Number.isInteger(data.pause.status) &&
          data.pause.status >= 100 &&
          data.pause.status <= 599
            ? data.pause.status
            : null,
        level429: level(data.pause.level429),
        level5xx: level(data.pause.level5xx),
      };
    }
    if (data.refused && /^[0-9a-f]{2}$/.test(data.refused.print ?? '')) {
      persisted.refused = { print: data.refused.print };
    }
    if (data.stops && typeof data.stops === 'object') {
      for (const [print, stop] of Object.entries(data.stops).slice(0, 50)) {
        if (!/^[0-9a-f]{32}$/.test(print) || !stop || typeof stop !== 'object') continue;
        const lines = {};
        if (stop.lines && typeof stop.lines === 'object') {
          for (const [line, at] of Object.entries(stop.lines).slice(0, SEEN_LINES_MAX)) {
            if (line.length <= 120 && isTime(at)) lines[line] = at;
          }
        }
        persisted.stops[print] = { confirmed: stop.confirmed === true, lines };
      }
    }
    this.persisted = persisted;
    const wall = this.now();
    const mono = this.monotonic();
    const quota = Array.isArray(data.quota) ? data.quota.slice(-QUOTA_KEEP_MAX) : [];
    this.quota.loadWall(quota, mono, wall);
  }

  /** Saves /data without ever waiting more than SAVE_BOUND for it. */
  async persist() {
    if (!this.loaded || this.storeStatus === 'unreadable') return false;
    this.persisted.quota = this.quota.toWall(this.monotonic(), this.now());
    let timer;
    const bound = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('late'), SAVE_BOUND);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => this.store.save(this.persisted))
          .then(() => 'saved'),
        bound,
      ]);
      if (outcome === 'late') this.logger.warn('Saving /data is slow: going on without waiting');
      const ok = outcome === 'saved';
      if (!ok) this.saveFailed = true;
      return ok;
    } catch (err) {
      this.logger.warn(`Saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      this.saveFailed = true;
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /**
   * A call to Gladys, never waited for more than 10 s: a Gladys that does not
   * answer never holds a round. Rejects when late, as a failed call.
   */
  async bounded(fn) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new Error('Gladys did not answer')),
        GLADYS_BOUND,
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Discovery, actions ----------------------------------------------------

  async publishDevices() {
    const config = this.config ?? normalizeConfig(this.gladys.config);
    try {
      await this.bounded(() =>
        this.gladys.publishDiscoveredDevices(buildDevices(this.gladys, config)),
      );
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the stops of the configuration, never a read. */
  scan() {
    return this.publishDevices();
  }

  /** The test button: what the last reads gave and the quota used; it never reads. */
  testConnection() {
    return this.composeStatus().message;
  }

  // --- The rounds -------------------------------------------------------------

  /** The ms until the next read due (or the end of a pause), bounded. */
  nextDelay(mono) {
    const dues = [this.depDueMono, ...[...this.alertsDue.values()].map((d) => d.dueMono)].filter(
      (d) => Number.isFinite(d),
    );
    let next = dues.length > 0 ? Math.min(...dues) : mono + TIMER_MAX;
    if (this.pausedFor(mono) > 0) next = Math.max(next, this.pauseUntilMono);
    // Woken at least every departures interval: the status stays true.
    const every = (this.plan?.depEvery ?? 60) * MINUTE;
    return Math.min(Math.max(0, next - mono), every);
  }

  async tick(gen) {
    if (gen !== this.gen || this.refused || !this.plan) return;
    if (this.inRound) {
      this.arm(SECOND, gen);
      return;
    }
    this.inRound = true;
    try {
      const start = this.monotonic();
      if (this.pausedFor(start) === 0) {
        if (this.depDueMono !== null && this.depDueMono <= start + DUE_SLACK) {
          this.depDueMono = start + this.plan.depEvery * MINUTE;
          this.persisted.depAt = this.now();
          await this.readDepartures(gen);
        }
        for (const agency of [...this.alertsDue.keys()]) {
          if (gen !== this.gen || this.refused) return;
          const due = this.alertsDue.get(agency);
          if (due && due.dueMono <= start + DUE_SLACK)
            await this.readAgencyAlerts(gen, agency, start);
        }
        if (gen !== this.gen) return;
        await this.persist();
      }
      if (gen !== this.gen) return;
      await this.updateStatus(gen);
    } finally {
      this.inRound = false;
      // A second at least between two rounds: never a loop of empty rounds.
      if (gen === this.gen && !this.refused) {
        this.arm(Math.max(SECOND, this.nextDelay(this.monotonic())), gen);
      }
    }
  }

  /** The pause left, in ms (0 when none). */
  pausedFor(mono = this.monotonic()) {
    if (this.pauseUntilMono === null) return 0;
    return Math.max(0, this.pauseUntilMono - mono);
  }

  /**
   * One request, when its turn comes: after the one in flight, 2 s after the
   * start of the previous one, and only when the last hour holds less than the
   * budget (waiting up to 2 min for a slot, else skipped). The request is
   * counted and /data written before it leaves. `null` when stopped meanwhile.
   */
  async call(url, gen, { pausing = false, beforeSend = null } = {}) {
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      if (this.pausedFor() > 0) return { ok: false, kind: 'paused' };
      const mono = this.monotonic();
      const gap = this.lastRequestMono + REQUEST_GAP - mono;
      const quotaWait = this.quota.waitFor(mono);
      if (quotaWait > QUOTA_WAIT_MAX) {
        this.logger.warn('Request skipped: the hourly quota of the token is used up');
        return { ok: false, kind: 'quota' };
      }
      const wait = Math.max(gap, quotaWait);
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      // Counted before it leaves, and in /data before it leaves.
      this.quota.take(mono);
      this.lastRequestMono = mono;
      // What a restart must know of this request (its time) goes to /data with it.
      beforeSend?.();
      break;
    }
    const job = (async () => {
      await this.persist();
      if (gen !== this.gen) return null;
      return getJson(url, { fetchImpl: this.fetchImpl, timers: this.timers });
    })();
    this.inflight = job.then(
      () => {},
      () => {},
    );
    let result;
    try {
      result = await job;
    } finally {
      this.inflight = null;
    }
    if (result === null) return null;
    if (!result.ok && (result.kind === 'rate' || (pausing && result.kind === 'server'))) {
      this.startPause(result);
      // Stopped or restarted meanwhile: the pause still reaches /data.
      await this.persist();
    } else if (result.ok) {
      // 511 answered: the pauses end.
      this.pauseUntilMono = null;
      if (this.persisted.pause) this.persisted.pause = NO_PAUSE();
    }
    return result;
  }

  /** A pause of every read: 429 (Retry-After, else 10 min doubled) or 5xx (2 min doubled). */
  startPause(result) {
    const pause = this.persisted.pause ?? NO_PAUSE();
    let delay;
    if (result.kind === 'rate') {
      pause.level429 = Math.min(pause.level429 + 1, 30);
      delay = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);
    } else {
      pause.level5xx = Math.min(pause.level5xx + 1, 30);
      delay = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);
    }
    if (Number.isFinite(result.retryAfter) && result.retryAfter > delay) delay = result.retryAfter;
    delay = Math.min(Math.max(delay, PAUSE_MIN), PAUSE_MAX);
    const mono = this.monotonic();
    const wall = this.now();
    // A shorter pause never replaces a longer one.
    if (this.pauseUntilMono === null || this.pauseUntilMono < mono + delay) {
      this.pauseUntilMono = mono + delay;
      pause.until = wall + delay;
      pause.kind = result.kind === 'rate' ? 'rate' : 'server';
      pause.status = result.status ?? null;
    }
    this.persisted.pause = pause;
    this.logger.warn(
      `511 asked to slow down (${result.kind}): reads paused ${Math.round(delay / SECOND)} s`,
    );
  }

  /** The lines known at a stop (lower case): the filter typed, else the lines seen there. */
  linesOf(stop) {
    if (stop.lines.length > 0) return new Set(stop.lines.map((l) => l.toLowerCase()));
    const seen = this.persisted.stops[this.stopPrint(stop)]?.lines ?? {};
    return new Set(Object.keys(seen));
  }

  /** 511 showed a visit at this stop: confirmed, and its lines learnt (bounded, 7 days). */
  learn(stop, visits) {
    const print = this.stopPrint(stop);
    const entry = this.persisted.stops[print] ?? { confirmed: false, lines: {} };
    entry.confirmed = true;
    const wall = this.now();
    for (const visit of visits) {
      for (const line of [visit.line, visit.lineName]) {
        if (line) entry.lines[[...line.toLowerCase()].slice(0, 120).join('')] = wall;
      }
    }
    const kept = Object.entries(entry.lines)
      .filter(([, at]) => wall - at <= SEEN_LINES_KEEP)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_LINES_MAX);
    entry.lines = Object.fromEntries(kept);
    this.persisted.stops[print] = entry;
  }

  /** The departures of every stop: one request each. */
  async readDepartures(gen) {
    for (const stop of this.config.stops) {
      if (gen !== this.gen || this.refused) return;
      const mono = this.monotonic();
      const retry = this.stopRetry.get(this.stopKey(stop));
      if (retry !== undefined && retry > mono) continue;
      const answer = await this.call(stopMonitoringUrl(this.config.key, stop, this.apiBase), gen, {
        pausing: true,
      });
      if (answer === null || gen !== this.gen) return;
      if (!answer.ok) {
        if (answer.kind === 'auth') {
          await this.refuseKey(gen);
          return;
        }
        if (answer.kind === 'http' && (answer.status === 400 || answer.status === 404)) {
          this.stopRetry.set(this.stopKey(stop), this.monotonic() + STOP_RETRY);
          this.recordFailure(stop, 'dep', { kind: 'not_found', status: answer.status });
        } else if (answer.kind === 'http') {
          // Another refusal of the departures (403...): every read is spaced out.
          this.startPause({ kind: 'server', status: answer.status });
          this.recordFailure(stop, 'dep', answer);
        } else this.recordFailure(stop, 'dep', answer);
        this.logger.warn(
          `Stop ${stop.slot}: departures not read (${answer.kind}${answer.status ? ` ${answer.status}` : ''})`,
        );
        continue;
      }
      this.stopRetry.delete(this.stopKey(stop));
      const read = readStopMonitoring(answer.json);
      const kind = !read
        ? 'format'
        : read.refused
          ? 'refused'
          : read.unreadable
            ? 'unreadable'
            : null;
      if (kind) {
        this.logger.warn(`Stop ${stop.slot}: departures not published (${kind})`);
        this.recordFailure(stop, 'dep', { kind });
        continue;
      }
      const at = read.at ?? answer.serverDate;
      const fresh = this.freshness(at);
      if (fresh) {
        this.recordFailure(stop, 'dep', { kind: fresh });
        continue;
      }
      if (read.visits.length > 0) this.learn(stop, read.visits);
      this.checkFilter(stop, read.visits);
      const departures = departuresAt(read.visits, stop, at);
      // "No departure" only for a stop where 511 has shown a visit once: a
      // mistyped code reads as an empty stop.
      if (departures.length === 0 && !this.persisted.stops[this.stopPrint(stop)]?.confirmed) {
        this.recordFailure(stop, 'dep', { kind: 'unconfirmed' });
        continue;
      }
      await this.onDepartures(stop, departures, at);
    }
  }

  /** Why a server time cannot be used (`null` when it can). */
  freshness(at) {
    if (!isTime(at)) return 'no_date';
    if (Math.abs(at - this.now()) > CLOCK_SKEW) {
      this.logger.warn('The time of the 511 answer differs from the local clock: not used');
      return 'clock';
    }
    return null;
  }

  /**
   * A line filter that matches none of the visits 511 shows at the stop, read
   * after read, is probably mistyped: the status says so (the texts would say
   * "no departure" forever otherwise).
   */
  checkFilter(stop, visits) {
    const key = this.stopKey(stop);
    if (stop.lines.length === 0) {
      this.filterMiss.delete(key);
      return;
    }
    const wanted = new Set(stop.lines.map((l) => l.toLowerCase()));
    const matched = visits.some(
      (v) => wanted.has(v.line.toLowerCase()) || wanted.has(v.lineName.toLowerCase()),
    );
    if (matched) this.filterMiss.delete(key);
    else if (visits.length > 0) this.filterMiss.set(key, (this.filterMiss.get(key) ?? 0) + 1);
  }

  async onDepartures(stop, departures, at) {
    const language = this.config.language;
    const count = countWithin(departures, at);
    this.setResult(stop, 'dep', {
      ok: true,
      readAt: at,
      readMono: this.monotonic(),
      count,
      next: departures[0] ?? null,
    });
    const ids = stopIds(this.gladys, stop);
    if (!this.isCreated(ids)) return;
    try {
      await this.bounded(() =>
        this.gladys.publishStates([
          {
            device_feature_external_id: ids.feature(FEATURES.NEXT),
            text: departureText(departures[0], at, language, 'next', TEXT_MAX),
          },
          {
            device_feature_external_id: ids.feature(FEATURES.SECOND),
            text: departureText(departures[1], at, language, 'second', TEXT_MAX),
          },
          { device_feature_external_id: ids.feature(FEATURES.DEPARTURES), state: count },
        ]),
      );
    } catch (err) {
      this.logger.warn(`Stop ${stop.slot}: departures not published (${err?.name ?? 'Error'})`);
    }
  }

  /** A refused token (401 of the departures): kept, nothing read until a new one is saved. */
  async refuseKey(gen) {
    this.refused = true;
    this.refusedHash = this.keyHash;
    this.persisted.refused = { print: this.keyPrint(this.config.key) };
    this.logger.warn('511 refused the token (401): reads stopped until a new token is saved');
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.persist();
    await this.updateStatus(gen);
  }

  /**
   * The alerts of one agency (secondary: a failure is spaced out for this
   * agency only, never a refused token, never a pause but for a 429).
   */
  async readAgencyAlerts(gen, agency, start) {
    const stops = this.config.stops.filter((s) => s.agency === agency);
    const known = stops.filter((s) => this.linesOf(s).size > 0);
    for (const stop of stops) {
      if (!known.includes(stop)) this.recordFailure(stop, 'alerts', { kind: 'lines_unknown' });
    }
    // No stop of the agency with known lines: no request spent; looked at
    // again with the next departures (never a due time left in the past).
    if (known.length === 0) {
      this.alertsDue.set(agency, { ...this.alertsDue.get(agency), dueMono: this.retryAt(start) });
      return;
    }
    const every = this.plan.alertsEvery * MINUTE;
    // The time of the attempt and the back-off reach /data before the request
    // leaves: a restart (even in a loop) never reads these alerts sooner.
    const answer = await this.call(alertsUrl(this.config.key, agency, this.apiBase), gen, {
      beforeSend: () => {
        this.persisted.alertsAt[agency] = this.now();
        this.persisted.alertsLevel[agency] = Math.min(
          (this.alertsDue.get(agency)?.level ?? 0) + 1,
          10,
        );
      },
    });
    if (answer === null || gen !== this.gen) return;
    const failed = (kind, status) => {
      const due = this.alertsDue.get(agency);
      if (kind !== 'paused' && kind !== 'quota') {
        const level = Math.min((due?.level ?? 0) + 1, 10);
        this.alertsDue.set(agency, { dueMono: start + alertsDelay(every, level), level });
        this.persisted.alertsLevel[agency] = level;
      } else this.alertsDue.set(agency, { level: due?.level ?? 0, dueMono: this.retryAt(start) });
      this.logger.warn(`Agency ${agency}: alerts not read (${kind})`);
      for (const stop of known) this.recordFailure(stop, 'alerts', { kind, status });
    };
    if (!answer.ok) {
      failed(answer.kind, answer.status);
      return;
    }
    const read = readAlerts(answer.json, this.config.language);
    if (!read || read.unreadable) {
      failed(read ? 'unreadable' : 'format');
      return;
    }
    const at = answer.serverDate;
    const fresh = this.freshness(at);
    if (fresh) {
      failed(fresh);
      return;
    }
    // A feed of unknown age (no header time) is never "no alert".
    if (read.at === null) {
      failed('undated');
      return;
    }
    if (at - read.at > ALERTS_STALE) {
      failed('stale');
      return;
    }
    this.alertsDue.set(agency, { dueMono: start + every, level: 0 });
    this.persisted.alertsLevel[agency] = 0;
    for (const stop of known) {
      if (gen !== this.gen) return;
      const alerts = alertsForStop(read.alerts, stop, this.linesOf(stop), at);
      this.setResult(stop, 'alerts', {
        ok: true,
        readAt: at,
        readMono: this.monotonic(),
        count: alerts.length,
      });
      const ids = stopIds(this.gladys, stop);
      if (!this.isCreated(ids)) continue;
      try {
        await this.bounded(() =>
          this.gladys.publishStates([
            { device_feature_external_id: ids.feature(FEATURES.ALERTS), state: alerts.length },
            {
              device_feature_external_id: ids.feature(FEATURES.ALERT_TEXT),
              text: alertText(alerts, at, this.config.language, TEXT_MAX),
            },
          ]),
        );
      } catch (err) {
        this.logger.warn(`Stop ${stop.slot}: alerts not published (${err?.name ?? 'Error'})`);
      }
    }
  }

  /** A read skipped without a request: tried again with the next departures, a minute at least. */
  retryAt(start) {
    return Math.max(start + MINUTE, this.depDueMono ?? 0);
  }

  isCreated(ids) {
    return !!this.gladys.devices?.some((device) => device.external_id === ids.device);
  }

  setResult(stop, part, value) {
    const key = this.stopKey(stop);
    const before = this.results.get(stop.slot);
    const entry = before && before.key === key ? before : { key, dep: null, alerts: null };
    entry[part] = value;
    this.results.set(stop.slot, entry);
  }

  /** A failure keeps the time of the last success (the status says since when). */
  recordFailure(stop, part, { kind, status }) {
    const key = this.stopKey(stop);
    const before = this.results.get(stop.slot);
    const previous = before && before.key === key ? before[part] : null;
    this.setResult(stop, part, {
      ok: false,
      kind,
      status: status ?? null,
      readAt: previous?.readAt ?? null,
      readMono: previous?.readMono ?? null,
    });
  }

  // --- Status -------------------------------------------------------------------

  composeStatus() {
    const config = this.config;
    const lines = { en: [], fr: [] };
    const add = (message) => {
      lines.en.push(message.en);
      lines.fr.push(message.fr);
    };
    if (!config?.key) return { connected: false, message: M.noKey };
    if (this.refused) return { connected: false, message: M.keyRefused };
    const mono = this.monotonic();
    let connected = false;
    if (this.plan) {
      add(
        M.plan({
          perHour: this.plan.perHour,
          limit: config.hourlyLimit,
          depEvery: this.plan.depEvery,
          alertsEvery: this.plan.alertsEvery,
          raised: this.plan.depEvery > config.refreshMinutes,
        }),
      );
      add(M.used({ used: this.quota.used(mono), budget: this.plan.budget }));
    }
    const paused = this.pausedFor(mono);
    if (paused > 0) {
      const pause = this.persisted.pause;
      add(
        M.pause({
          until: formatClock(this.now() + paused),
          why: failure(pause?.kind ?? 'rate', pause?.status),
        }),
      );
    }
    const every = (this.plan?.depEvery ?? 60) * MINUTE;
    for (const stop of config.stops) {
      const result = this.results.get(stop.slot);
      const label = stopLabel(stop, config.language);
      const part = (value, okText) => {
        if (!value) return failure(null);
        const since = value.readAt
          ? {
              en: ` (last read ${formatClock(value.readAt)})`,
              fr: ` (dernière lecture ${formatClock(value.readAt)})`,
            }
          : { en: '', fr: '' };
        if (value.ok) return okText(value);
        const why = failure(value.kind, value.status);
        return { en: `${why.en}${since.en}`, fr: `${why.fr}${since.fr}` };
      };
      const misses = this.filterMiss.get(this.stopKey(stop)) ?? 0;
      const filterWarning =
        misses >= FILTER_MISS_WARN
          ? {
              en: ` (none of the filtered lines in the last ${misses} reads: check the line filter)`,
              fr: ` (aucune des lignes filtrées dans les ${misses} dernières lectures : vérifiez le filtre de lignes)`,
            }
          : { en: '', fr: '' };
      const dep = part(result?.dep, (v) => ({
        en: `read ${formatClock(v.readAt)}, ${v.count} within 60 min${filterWarning.en}`,
        fr: `lu à ${formatClock(v.readAt)}, ${v.count} dans les 60 min${filterWarning.fr}`,
      }));
      const alerts = config.alerts
        ? part(result?.alerts, (v) => ({
            en: `${v.count} alert(s), read ${formatClock(v.readAt)}`,
            fr: `${v.count} alerte(s), lu à ${formatClock(v.readAt)}`,
          }))
        : null;
      add({
        en: `${label}: departures ${dep.en}${alerts ? `; alerts ${alerts.en}` : ''}.`,
        fr: `${label} : départs ${dep.fr}${alerts ? ` ; alertes ${alerts.fr}` : ''}.`,
      });
      const lastOk = result?.dep?.readMono;
      if (Number.isFinite(lastOk) && mono - lastOk <= CONNECTED_INTERVALS * every) connected = true;
    }
    if (this.dataTells === false && this.storeStatus === 'unreadable') add(M.dataUnknown);
    else if (this.saveFailed) add(M.dataNotSaved);
    const errors = configErrors(config.errors);
    if (errors.en) add(errors);
    add(M.attribution);
    const cut = (list) => [...list.join(' ')].slice(0, STATUS_MAX).join('');
    return { connected, message: { en: cut(lines.en), fr: cut(lines.fr) } };
  }

  async updateStatus(gen) {
    const { connected, message } = this.composeStatus();
    await this.setStatus(connected, message, gen);
  }

  async setStatus(connected, message, gen) {
    if (gen !== this.gen) return;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.bounded(() => this.gladys.setConnectionStatus(connected, message));
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not published (${err?.name ?? 'Error'})`);
    }
  }
}
