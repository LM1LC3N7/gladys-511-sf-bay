// -----------------------------------------------------------------------------
// The quota of the 511 token (60 requests per 3600 seconds by default).
//
// `plan()` chooses the intervals so that, in ANY sliding hour, the requests
// stay within 90 % of the limit: rounds started P minutes apart put at most
// ceil(60 / P) rounds in an hour, each with one request per stop (departures)
// or per agency (alerts). The alerts take at most a third of the budget.
//
// `Quota` is the hard guard on top of it: every request sent is counted (its
// start, on the monotonic clock), and none is sent when the last hour already
// holds the budget. The counted starts are kept in /data (wall times) so a
// restart knows them.
// -----------------------------------------------------------------------------

import { ALERTS_EVERY_MIN, ALERTS_SHARE, BUDGET_SHARE, QUOTA_WINDOW } from './constants.js';

/** Rounds in a sliding hour for rounds at least `minutes` apart. */
export const roundsPerHour = (minutes) => Math.ceil(60 / minutes);

/**
 * `{ budget, depEvery, alertsEvery, perHour }`: the intervals in minutes
 * (`alertsEvery` null without alerts) and the requests of the worst hour.
 */
export function plan({ stops, agencies, refreshMinutes, hourlyLimit, alerts }) {
  const budget = Math.floor(hourlyLimit * BUDGET_SHARE);
  let alertsEvery = null;
  let alertsPerHour = 0;
  if (alerts && agencies > 0) {
    const share = Math.max(1, Math.floor(budget * ALERTS_SHARE));
    alertsEvery = ALERTS_EVERY_MIN;
    while (agencies * roundsPerHour(alertsEvery) > share && alertsEvery < 60) alertsEvery += 1;
    alertsPerHour = agencies * roundsPerHour(alertsEvery);
  }
  const left = budget - alertsPerHour;
  let depEvery = refreshMinutes;
  while (stops * roundsPerHour(depEvery) > left && depEvery < 60) depEvery += 1;
  return {
    budget,
    depEvery,
    alertsEvery,
    perHour: stops * roundsPerHour(depEvery) + alertsPerHour,
  };
}

export class Quota {
  constructor(budget) {
    this.budget = budget;
    /** Monotonic starts of the requests of the last hour, oldest first. */
    this.starts = [];
  }

  prune(mono) {
    while (this.starts.length > 0 && this.starts[0] <= mono - QUOTA_WINDOW) this.starts.shift();
  }

  /** The requests counted in the hour before `mono`. */
  used(mono) {
    this.prune(mono);
    return this.starts.length;
  }

  /** 0 when a request may start at `mono`, else the ms until a slot frees. */
  waitFor(mono) {
    this.prune(mono);
    if (this.starts.length < this.budget) return 0;
    const oldest = this.starts[this.starts.length - this.budget];
    return Math.max(1, oldest + QUOTA_WINDOW - mono);
  }

  take(mono) {
    this.starts.push(mono);
  }

  /** The starts as wall times (for /data), from one reading of both clocks. */
  toWall(mono, wall) {
    this.prune(mono);
    return this.starts.map((start) => Math.round(wall - (mono - start)));
  }

  /**
   * The starts read back from /data (wall times): a time in the future is not
   * believed, and counted as "just now" (the safe side); older than an hour,
   * dropped.
   */
  loadWall(times, mono, wall) {
    const starts = [];
    for (const at of Array.isArray(times) ? times : []) {
      if (!Number.isFinite(at) || at <= 0) continue;
      const age = wall - at;
      if (age >= QUOTA_WINDOW) continue;
      starts.push(mono - Math.max(0, age));
    }
    starts.sort((a, b) => a - b);
    this.starts = starts;
    this.prune(mono);
  }
}
