// -----------------------------------------------------------------------------
// The fixed values of the integration: the 511 SF Bay Open Data API (transit),
// its quota, the bounds of what is read, and the keys shared with the manifest.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the package (the release bumps it): the User-Agent follows. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** The transit API of 511 SF Bay Open Data (the documentation gives http; https answers the same). */
export const API_BASE = 'https://api.511.org/transit';

/** An honest User-Agent naming the integration, never a browser's. */
export const USER_AGENT = `gladys-sf-bay-transit/${VERSION} (+https://github.com/LM1LC3N7/gladys-sf-bay-transit)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/**
 * The quota of a 511 token: "60 requests per 3600 seconds" by default
 * (511.org/open-data/transit, read on 2026-11-27); 511 can raise it on
 * request. The user gives the limit of their token; the integration plans
 * at most 90 % of it and never sends more than that in any sliding hour.
 */
export const HOURLY_LIMIT_DEFAULT = 60;
export const HOURLY_LIMIT_MIN = 20;
export const HOURLY_LIMIT_MAX = 1000;
export const BUDGET_SHARE = 0.9;
/** The sliding window of the quota. */
export const QUOTA_WINDOW = HOUR;
/** The alerts get at most this share of the budget (the departures the rest). */
export const ALERTS_SHARE = 1 / 3;
/** A request held by the quota guard waits for a free slot this long at most, else it is skipped. */
export const QUOTA_WAIT_MAX = 2 * MINUTE;

/** At least this between the starts of two requests (one at a time anyway). */
export const REQUEST_GAP = 2 * SECOND;
/** One request never lasts longer (connection, answer and body). */
export const REQUEST_TIMEOUT = 20 * SECOND;
/** A body larger than this is cut before it is read in full (memory bound). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Stop visits read per answer at most; a longer list is refused (never cut). */
export const MAX_VISITS = 1000;
/** Alert entities read per answer at most; a longer feed is refused. */
export const MAX_ALERTS = 2000;

/** The read interval of the departures, in minutes (config `refresh_minutes`). */
export const REFRESH_DEFAULT = 5;
export const REFRESH_MIN = 2;
export const REFRESH_MAX = 60;
/** The alerts of an agency are read every 15 minutes at the most often. */
export const ALERTS_EVERY_MIN = 15;

/** A stop answered 400 or 404: tried again after this. */
export const STOP_RETRY = 30 * MINUTE;
/** A failed alerts read: tried again one alerts interval later, doubled, bounded. */
export const ALERTS_RETRY_MAX = 2 * HOUR;

/** Pauses after a 429 (rate limit) and a 5xx, doubled each time, bounded. */
export const PAUSE_429_FIRST = 10 * MINUTE;
export const PAUSE_5XX_FIRST = 2 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing on a connection: retried forever, spaced out. */
export const CONFIG_RETRY_FIRST = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/**
 * A server time further than this from the local clock is not believed: the
 * local clock is wrong, or the answer is an old copy. Nothing is published.
 */
export const CLOCK_SKEW = 5 * MINUTE;
/** An alerts feed whose header time is older than this (against the server time) is stale. */
export const ALERTS_STALE = 6 * HOUR;
/** Departures counted on the counter: within this window. */
export const WINDOW_MINUTES = 60;
/** A departure further than this is ignored (an absurd time). */
export const HORIZON = 24 * HOUR;
/** A departure up to this much in the past is "leaving now" (0 min). */
export const LEAVING_GRACE = MINUTE;
/** `connected`: a stop read successfully within this many departure intervals. */
export const CONNECTED_INTERVALS = 3;

/** Watched stops (one Gladys device each). */
export const WATCH_SLOTS = [1, 2, 3, 4, 5];
export const LINES_MAX = 10;
/** Lines seen at a stop, remembered for the alerts (bounded, forgotten after 7 days). */
export const SEEN_LINES_MAX = 30;
export const SEEN_LINES_KEEP = 7 * 24 * HOUR;
export const NAME_MAX = 60;
/** An operator id of 511 (`SF`, `BA`, `CT`, `AC`, `3D`...). */
export const AGENCY_PATTERN = /^[A-Za-z0-9]{1,10}$/;
/** A stop code: letters, digits, `-` and `_` (no dot, colon, comma). */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A line as 511 names it (`14`, `KT`, `Yellow-N`, `Local`): no comma, semicolon nor control byte. */
export const LINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _/.-]{0,59}$/;
/** A 511 token: letters, digits, `-` and `_` only (never a control byte, a space, a `&`). */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Counters are bounded. */
export const COUNT_MAX = MAX_VISITS;
/** The texts published on the device, in characters. */
export const TEXT_MAX = 600;
/** The status shown in the configuration screen, in characters. */
export const STATUS_MAX = 1500;

export const DEVICE_TYPE = 'stop';
export const FEATURES = Object.freeze({
  NEXT: 'next',
  SECOND: 'second',
  DEPARTURES: 'departures',
  ALERTS: 'alerts',
  ALERT_TEXT: 'alert_text',
});

export const ACTIONS = Object.freeze({ TEST: 'test' });

/** The time zone of the Bay Area (the times of the texts and the status). */
export const TIME_ZONE = 'America/Los_Angeles';

export const STATE_FILE = '/data/sfbay-state.json';
