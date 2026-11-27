// -----------------------------------------------------------------------------
// The configuration read strictly: blanks are absent (never 0), the token and
// the ids hold only what 511 uses, a refused field is named, never echoed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, readLines, readNumber } from '../src/config.js';
import { configErrors } from '../src/i18n.js';

const KEY = 'test-token-0123456789abcdef';
const base = { api_key: KEY, stop1_agency: 'sf', stop1_code: '15553' };

test('defaults: 5 min, 60 per hour, alerts on, English; the agency in upper case', () => {
  const config = normalizeConfig(base);
  assert.deepEqual(config, {
    language: 'en',
    key: KEY,
    refreshMinutes: 5,
    hourlyLimit: 60,
    alerts: true,
    stops: [{ slot: 1, name: null, agency: 'SF', code: '15553', lines: [] }],
    errors: [],
  });
});

test('Gladys sends empty fields as null or "": absent, never 0', () => {
  const config = normalizeConfig({
    ...base,
    refresh_minutes: '',
    hourly_limit: null,
    alerts: null,
    stop2_agency: null,
    stop2_code: '',
    stop1_lines: '',
  });
  assert.equal(config.refreshMinutes, 5);
  assert.equal(config.hourlyLimit, 60);
  assert.equal(config.stops.length, 1);
  assert.deepEqual(config.errors, []);
  assert.equal(readNumber(''), null);
  assert.ok(Number.isNaN(readNumber('1e3')));
  assert.ok(Number.isNaN(readNumber('0x10')));
});

test('the token: required, letters, digits, - and _ only; never echoed', () => {
  for (const bad of ['short', 'with space 0123456', 'line\r\nbreak0123', 'a&b=c0123456', 42]) {
    const config = normalizeConfig({ ...base, api_key: bad });
    assert.equal(config.key, null);
    assert.deepEqual(config.errors, [{ slot: null, field: 'api_key', code: 'key_invalid' }]);
    assert.ok(!JSON.stringify(configErrors(config.errors)).includes(String(bad)));
  }
  assert.deepEqual(normalizeConfig({ ...base, api_key: '' }).errors[0].code, 'required');
  assert.equal(normalizeConfig({ ...base, api_key: `  ${KEY} ` }).key, KEY);
});

test('bounds: interval 2 to 60 min, limit 20 to 1000; a refused limit is the default', () => {
  for (const [value, ok] of [
    ['2', true],
    ['60', true],
    ['1', false],
    ['61', false],
    ['2.5', false],
    ['abc', false],
  ]) {
    const config = normalizeConfig({ ...base, refresh_minutes: value });
    assert.equal(config.errors.length === 0, ok, value);
  }
  const limit = normalizeConfig({ ...base, hourly_limit: '5000' });
  assert.equal(limit.hourlyLimit, 60);
  assert.equal(limit.errors[0].field, 'hourly_limit');
  assert.equal(normalizeConfig({ ...base, hourly_limit: '19' }).hourlyLimit, 60);
  assert.equal(normalizeConfig({ ...base, hourly_limit: 120 }).hourlyLimit, 120);
});

test('stops: the first required, both fields together, no dot, colon or control byte', () => {
  assert.deepEqual(normalizeConfig({ api_key: KEY }).errors, [
    { slot: 1, field: 'stop1_code', code: 'required' },
  ]);
  const half = normalizeConfig({ ...base, stop2_code: '123' });
  assert.deepEqual(half.errors, [{ slot: 2, field: 'stop2_agency', code: 'required' }]);
  for (const code of ['1.2', 'a:b', '../x', 'a b', 'x\u0000']) {
    const config = normalizeConfig({ ...base, stop1_code: code });
    assert.equal(config.stops.length, 0, code);
  }
  assert.equal(normalizeConfig({ ...base, stop1_agency: 'S F' }).stops.length, 0);
  const dup = normalizeConfig({ ...base, stop2_agency: 'SF', stop2_code: '15553' });
  assert.equal(dup.stops.length, 1, 'the same stop twice costs the quota twice');
  assert.equal(dup.errors[0].code, 'duplicate');
});

test('lines: comma or semicolon separated, unique, 10 at most, names with spaces allowed', () => {
  assert.deepEqual(readLines('14, 14R;49 ,14'), { lines: ['14', '14R', '49'] });
  assert.deepEqual(readLines('Yellow-N, Local Weekday'), { lines: ['Yellow-N', 'Local Weekday'] });
  assert.equal(readLines('a,b,c,d,e,f,g,h,i,j,k').error, 'lines_too_many');
  assert.equal(readLines('14\n49').error, 'lines_invalid');
  assert.equal(readLines('<b>').error, 'lines_invalid');
});

test('the name: 60 characters at most, no control byte', () => {
  assert.equal(normalizeConfig({ ...base, stop1_name: '  Bus  home ' }).stops[0].name, 'Bus home');
  assert.equal(normalizeConfig({ ...base, stop1_name: 'x'.repeat(61) }).stops.length, 0);
  assert.equal(normalizeConfig({ ...base, stop1_name: 'a\u0085b' }).stops.length, 0);
});
