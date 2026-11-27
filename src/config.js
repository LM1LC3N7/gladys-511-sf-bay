// -----------------------------------------------------------------------------
// The configuration filled in by the user, read strictly: an empty field is
// absent (never 0), a number is a plain decimal, an id holds only the
// characters 511 uses. A refused field is named by its key, never echoed back
// (the token least of all).
// -----------------------------------------------------------------------------

import {
  AGENCY_PATTERN,
  CODE_PATTERN,
  HOURLY_LIMIT_DEFAULT,
  HOURLY_LIMIT_MAX,
  HOURLY_LIMIT_MIN,
  KEY_PATTERN,
  LINE_PATTERN,
  LINES_MAX,
  NAME_MAX,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  WATCH_SLOTS,
} from './constants.js';

export const LANGUAGES = ['en', 'fr'];
export const ALERT_MODES = ['on', 'off'];

// Any control character (C0, DEL, C1): never in a name, an id or the token.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The keys of the fields of a watched stop (manifest `config_schema`). */
export const stopKeys = (slot) => ({
  name: `stop${slot}_name`,
  agency: `stop${slot}_agency`,
  code: `stop${slot}_code`,
  lines: `stop${slot}_lines`,
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * A number typed by the user: `null` when blank, `NaN` when not a plain
 * decimal (`Number('')` is 0, `Number('1e3')` 1000: both refused here).
 */
export function readNumber(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  return /^[-+]?\d{1,6}(\.\d{1,6})?$/.test(text) ? Number(text) : NaN;
}

/** An integer within bounds, the default when blank, `undefined` when refused. */
function readInteger(value, min, max, fallback) {
  const number = readNumber(value);
  if (number === null) return fallback;
  if (Number.isNaN(number) || !Number.isInteger(number) || number < min || number > max) {
    return undefined;
  }
  return number;
}

/** A free text: `null` when blank, `undefined` when refused (control byte). */
function readText(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || CONTROL.test(value)) return undefined;
  return value.trim().replace(/\s+/g, ' ');
}

/** An id matching `pattern`: `null` when blank, `undefined` when refused. */
function readId(value, pattern) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return pattern.test(id) ? id : undefined;
}

/** Line ids, comma or semicolon separated, unique (case-insensitive), bounded. */
export function readLines(value) {
  if (isBlank(value)) return { lines: [] };
  if (typeof value !== 'string' || CONTROL.test(value)) return { error: 'lines_invalid' };
  const lines = [];
  const seen = new Set();
  for (const part of value.split(/[,;]/)) {
    const line = part.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    if (!LINE_PATTERN.test(line)) return { error: 'lines_invalid' };
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  if (lines.length > LINES_MAX) return { error: 'lines_too_many' };
  return { lines };
}

function readStop(raw, slot) {
  const keys = stopKeys(slot);
  const agency = readId(raw[keys.agency], AGENCY_PATTERN);
  const code = readId(raw[keys.code], CODE_PATTERN);
  if (agency === null && code === null) {
    // An empty slot is off; the first one is required.
    return slot === 1 ? { errors: [{ slot, field: keys.code, code: 'required' }] } : {};
  }
  const errors = [];
  if (agency === null) errors.push({ slot, field: keys.agency, code: 'required' });
  if (agency === undefined) errors.push({ slot, field: keys.agency, code: 'agency_invalid' });
  if (code === null) errors.push({ slot, field: keys.code, code: 'required' });
  if (code === undefined) errors.push({ slot, field: keys.code, code: 'code_invalid' });
  const lines = readLines(raw[keys.lines]);
  if (lines.error) errors.push({ slot, field: keys.lines, code: lines.error });
  const name = readText(raw[keys.name]);
  if (name === undefined || (name && [...name].length > NAME_MAX)) {
    errors.push({ slot, field: keys.name, code: 'name_invalid' });
  }
  if (errors.length > 0) return { errors };
  return {
    stop: {
      slot,
      name: name || null,
      // Operator ids are upper case at 511 (SF, BA, CT, AC, 3D).
      agency: agency.toUpperCase(),
      code,
      lines: lines.lines,
    },
    errors: [],
  };
}

/**
 * The configuration the app runs with. `stops` holds the valid ones only;
 * `errors` names each refused field (never its value). `key` is `null` when
 * missing or refused: nothing is read without it.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const language = LANGUAGES.includes(source.language) ? source.language : 'en';

  let key = null;
  if (isBlank(source.api_key)) errors.push({ slot: null, field: 'api_key', code: 'required' });
  else if (typeof source.api_key !== 'string' || !KEY_PATTERN.test(source.api_key.trim())) {
    errors.push({ slot: null, field: 'api_key', code: 'key_invalid' });
  } else key = source.api_key.trim();

  let refreshMinutes = readInteger(
    source.refresh_minutes,
    REFRESH_MIN,
    REFRESH_MAX,
    REFRESH_DEFAULT,
  );
  if (refreshMinutes === undefined) {
    errors.push({ slot: null, field: 'refresh_minutes', code: 'refresh' });
    refreshMinutes = REFRESH_DEFAULT;
  }
  let hourlyLimit = readInteger(
    source.hourly_limit,
    HOURLY_LIMIT_MIN,
    HOURLY_LIMIT_MAX,
    HOURLY_LIMIT_DEFAULT,
  );
  if (hourlyLimit === undefined) {
    // A refused limit falls back to the default, never to a larger one.
    errors.push({ slot: null, field: 'hourly_limit', code: 'limit' });
    hourlyLimit = HOURLY_LIMIT_DEFAULT;
  }
  let alerts = isBlank(source.alerts) ? 'on' : String(source.alerts).trim();
  if (!ALERT_MODES.includes(alerts)) {
    errors.push({ slot: null, field: 'alerts', code: 'alerts' });
    alerts = 'on';
  }

  const stops = [];
  const seen = new Set();
  for (const slot of WATCH_SLOTS) {
    const result = readStop(source, slot);
    if (result.stop) {
      const id = `${result.stop.agency}|${result.stop.code}`;
      if (seen.has(id)) {
        // The same stop twice would cost the quota twice for nothing.
        errors.push({ slot, field: stopKeys(slot).code, code: 'duplicate' });
        continue;
      }
      seen.add(id);
      stops.push(result.stop);
    }
    errors.push(...(result.errors ?? []));
  }
  return { language, key, refreshMinutes, hourlyLimit, alerts: alerts === 'on', stops, errors };
}
