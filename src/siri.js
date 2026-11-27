// -----------------------------------------------------------------------------
// Strict reading of the 511 answers into small objects.
//
// StopMonitoring (SIRI in JSON, spec appendix B.1.10): `{ Siri: {
// ServiceDelivery } }` in the specification, `{ ServiceDelivery }` in the
// answers of the live API: both are read. `StopMonitoringDelivery` and
// `MonitoredStopVisit` may be one object or a list (one visit comes as an
// object in the specification). Times carry their offset or `Z`.
//
// Service alerts (GTFS-RT in JSON, spec appendix B.1.16): 511 names the
// fields in PascalCase (`Entities`, `Alert`, `ActivePeriods`,
// `InformedEntities`, `HeaderText.Translations`) and a few in lower case
// (`cause`, `effect`); the field names of the GTFS-RT reference
// (`entity`, `active_period`, `informed_entity`...) are read as well.
//
// Never a value without proof: one visit whose time cannot be read refuses
// the whole answer (it could be the next departure), as one alert that
// cannot be read refuses the feed (a count missing one would be wrong).
// -----------------------------------------------------------------------------

import { MAX_ALERTS, MAX_VISITS } from './constants.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const STRING_MAX = 2000;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** A text from the API, bounded, without control bytes; `''` when absent. */
export function readString(value, max = STRING_MAX) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

/**
 * A field of an object whatever its case and underscores (`HeaderText`,
 * `headerText`, `header_text`): the first of `names` present. Own keys only
 * (never `__proto__` or an inherited one).
 */
export function pick(object, ...names) {
  if (!isObject(object)) return undefined;
  const wanted = names.map((n) => n.toLowerCase().replace(/_/g, ''));
  const keys = Object.keys(object).slice(0, 200);
  for (const name of wanted) {
    for (const key of keys) {
      if (key.toLowerCase().replace(/_/g, '') === name && own(object, key)) return object[key];
    }
  }
  return undefined;
}

/** One object, a list, or nothing, as a list (`null` when neither). */
const asList = (value) =>
  value === undefined || value === null || value === ''
    ? []
    : Array.isArray(value)
      ? value
      : isObject(value)
        ? [value]
        : null;

/**
 * A time of the API with its offset or `Z`, in ms, or `null`. A time without
 * offset is refused: it cannot be placed.
 */
export function readDateTime(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // An impossible date (February 30, 24:00) does not come back the same.
  if (new Date(utc).toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return null;
  if (zone === 'Z') return utc;
  const sign = zone[0] === '-' ? -1 : 1;
  const offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60000;
  return utc - offset;
}

/** An optional time: `undefined` when absent or empty, `null` when unreadable. */
function optionalTime(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return readDateTime(value);
}

/**
 * One stop visit: `{ line, lineName, destination, time, realtime, stopRef }`,
 * `{ skip: true }` when it has no time at all (nothing to show), or `null`
 * when it cannot be read.
 */
export function readVisit(visit) {
  if (!isObject(visit)) return null;
  const journey = pick(visit, 'MonitoredVehicleJourney');
  if (!isObject(journey)) return null;
  const call = pick(journey, 'MonitoredCall');
  if (!isObject(call)) return null;
  const line = readString(pick(journey, 'LineRef'), 60);
  const lineName = readString(pick(journey, 'PublishedLineName'), 120);
  if (!line && !lineName) return null;
  const times = {};
  for (const name of [
    'ExpectedDepartureTime',
    'ExpectedArrivalTime',
    'AimedDepartureTime',
    'AimedArrivalTime',
  ]) {
    const time = optionalTime(pick(call, name));
    // A time that is there must be readable.
    if (time === null) return null;
    times[name] = time;
  }
  const expected = times.ExpectedDepartureTime ?? times.ExpectedArrivalTime;
  const aimed = times.AimedDepartureTime ?? times.AimedArrivalTime;
  const time = expected ?? aimed;
  if (time === undefined) return { skip: true };
  return {
    line: line || lineName,
    lineName: lineName || line,
    destination:
      readString(pick(call, 'DestinationDisplay'), 120) ||
      readString(pick(journey, 'DestinationName'), 120),
    time,
    realtime: expected !== undefined,
    stopRef: readString(pick(call, 'StopPointRef'), 60),
  };
}

/**
 * A StopMonitoring answer: `{ at, visits }` (`at` the response time of 511,
 * or null), `{ unreadable: true }` when a visit cannot be read, `{ refused:
 * true }` when 511 says `Status: false`, or `null` when the envelope is not
 * a SIRI ServiceDelivery.
 */
export function readStopMonitoring(json) {
  const siri = isObject(pick(json, 'Siri')) ? pick(json, 'Siri') : json;
  const delivery = pick(siri, 'ServiceDelivery');
  if (!isObject(delivery)) return null;
  const smds = asList(pick(delivery, 'StopMonitoringDelivery'));
  if (smds === null || smds.length === 0 || smds.length > 10) return null;
  let at = optionalTime(pick(delivery, 'ResponseTimestamp'));
  if (at === null) return null;
  const visits = [];
  for (const smd of smds) {
    if (!isObject(smd)) return null;
    if (pick(smd, 'Status') === false || pick(delivery, 'Status') === false) {
      return { refused: true };
    }
    const smdAt = optionalTime(pick(smd, 'ResponseTimestamp'));
    if (smdAt === null) return null;
    at = at ?? smdAt;
    const list = asList(pick(smd, 'MonitoredStopVisit'));
    if (list === null || visits.length + list.length > MAX_VISITS) return null;
    for (const item of list) {
      const visit = readVisit(item);
      if (!visit) return { unreadable: true };
      if (!visit.skip) visits.push(visit);
    }
  }
  return { at: at ?? null, visits };
}

/** A GTFS-RT uint64 (number or numeric string) in seconds, `null` when 0 or absent. */
function readSeconds(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return null;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e11) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,11}$/.test(value)) return Number(value);
  return undefined;
}

/** A translated text: the language wanted, else English, else the first. */
function readTranslated(value, language) {
  if (value === undefined || value === null) return '';
  const list = asList(pick(value, 'Translation', 'Translations'));
  if (!list) return '';
  const entries = list
    .filter(isObject)
    .slice(0, 20)
    .map((t) => ({
      text: readString(pick(t, 'Text'), 1000),
      language: readString(pick(t, 'Language'), 20).toLowerCase(),
    }))
    .filter((t) => t.text);
  const best =
    entries.find((t) => t.language.startsWith(language)) ??
    entries.find((t) => t.language.startsWith('en') || t.language === '') ??
    entries[0];
  return best?.text ?? '';
}

/** One informed entity: the fields that are set (`null` for the others). */
function readSelector(value) {
  if (!isObject(value)) return null;
  const id = (name) => {
    const raw = pick(value, name);
    if (raw === undefined || raw === null || raw === '') return null;
    return readString(raw, 80) || null;
  };
  const trip = pick(value, 'Trip');
  const tripRoute = isObject(trip) ? readString(pick(trip, 'RouteId'), 80) || null : null;
  return { agency: id('AgencyId'), route: id('RouteId'), stop: id('StopId'), tripRoute };
}

/**
 * The alerts of a feed: `{ at, alerts }` (`at` the header time in ms, or
 * null), `{ unreadable: true }` when an alert cannot be read, or `null` when
 * the envelope is not a GTFS-RT feed.
 */
export function readAlerts(json, language = 'en') {
  if (!isObject(json)) return null;
  const header = pick(json, 'Header');
  if (!isObject(header)) return null;
  const stamp = readSeconds(pick(header, 'Timestamp'));
  if (stamp === undefined) return null;
  const entities = asList(pick(json, 'Entities', 'Entity'));
  if (entities === null || entities.length > MAX_ALERTS) return null;
  const alerts = [];
  for (const entity of entities) {
    if (!isObject(entity)) return { unreadable: true };
    const alert = pick(entity, 'Alert');
    // Trip updates and vehicle positions share the feed format: not alerts.
    if (alert === undefined || alert === null) continue;
    if (pick(entity, 'IsDeleted') === true) continue;
    if (!isObject(alert)) return { unreadable: true };
    const id = readString(pick(entity, 'Id'), 120);
    if (!id) return { unreadable: true };
    const periods = [];
    const rawPeriods = asList(pick(alert, 'ActivePeriods', 'ActivePeriod'));
    if (rawPeriods === null) return { unreadable: true };
    for (const period of rawPeriods.slice(0, 100)) {
      if (!isObject(period)) return { unreadable: true };
      const start = readSeconds(pick(period, 'Start'));
      const end = readSeconds(pick(period, 'End'));
      if (start === undefined || end === undefined) return { unreadable: true };
      periods.push({
        start: start === null ? null : start * 1000,
        end: end === null ? null : end * 1000,
      });
    }
    const rawEntities = asList(pick(alert, 'InformedEntities', 'InformedEntity'));
    if (rawEntities === null) return { unreadable: true };
    const selectors = rawEntities.slice(0, 500).map(readSelector).filter(Boolean);
    alerts.push({
      id,
      periods,
      selectors,
      header: readTranslated(pick(alert, 'HeaderText'), language),
      description: readTranslated(pick(alert, 'DescriptionText'), language),
    });
  }
  return { at: stamp === null ? null : stamp * 1000, alerts };
}

/** Whether an alert is in effect at `at` (no period: always). */
export function inEffect(alert, at) {
  if (alert.periods.length === 0) return true;
  return alert.periods.some(
    (p) => (p.start === null || p.start <= at) && (p.end === null || at <= p.end),
  );
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether an informed entity names this stop: every field it sets must
 * match (GTFS-RT semantics), and it sets at least one. `lines` holds the
 * lines of the stop in lower case (filter of the user, or lines seen there).
 */
export function selects(selector, stop, lines) {
  const { agency, route, stop: stopId, tripRoute } = selector;
  if (agency === null && route === null && stopId === null && tripRoute === null) return false;
  if (agency !== null && !same(agency, stop.agency)) return false;
  if (route !== null && !lines.has(route.toLowerCase())) return false;
  if (tripRoute !== null && !lines.has(tripRoute.toLowerCase())) return false;
  if (stopId !== null && !same(stopId, stop.code) && !same(stopId, `${stop.agency}:${stop.code}`)) {
    return false;
  }
  return true;
}

/** The alerts in effect at `at` that name the stop, its lines or its whole agency. */
export function alertsForStop(alerts, stop, lines, at) {
  return alerts.filter(
    (alert) => inEffect(alert, at) && alert.selectors.some((s) => selects(s, stop, lines)),
  );
}
