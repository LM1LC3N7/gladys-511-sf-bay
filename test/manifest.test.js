// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTIONS,
  HOURLY_LIMIT_DEFAULT,
  HOURLY_LIMIT_MAX,
  HOURLY_LIMIT_MIN,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  WATCH_SLOTS,
} from '../src/constants.js';
import { ALERT_MODES, LANGUAGES, normalizeConfig, stopKeys } from '../src/config.js';
import { buildDevices } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');
const SEMVER = /^\d+\.\d+\.\d+$/;
const KEY = 'test-token-0123456789abcdef';

const FIVE = {
  api_key: KEY,
  ...Object.fromEntries(
    WATCH_SLOTS.flatMap((slot) => [
      [`stop${slot}_agency`, 'SF'],
      [`stop${slot}_code`, `1555${slot}`],
    ]),
  ),
};

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one version in the four places, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, SEMVER);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-511-sf-bay:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(pkg.name, 'gladys-511-sf-bay');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(
    pkg.dependencies['@gladysassistant/integration-sdk'],
    /^\^\d+\.\d+\.\d+$/,
    'never pinned',
  );
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.categories, ['transport']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.countries, ['US']);
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries need 5.3.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.location, undefined, 'the house location is never asked');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-511-sf-bay\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
  // 511 Data Disseminator Agreement 5.c: "511" never in the name of the product.
  assert.doesNotMatch(manifest.name, /511/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; no key prefixed gladys_; the token is a secret without default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  const expected = ['intro', 'api_key', 'language', 'refresh_minutes', 'hourly_limit', 'alerts'];
  for (const slot of WATCH_SLOTS) {
    const keys = stopKeys(slot);
    expected.push(`stop${slot}`, keys.name, keys.agency, keys.code, keys.lines);
    assert.equal(fields[keys.code].required, slot === 1);
    assert.equal(fields[keys.agency].required, slot === 1);
    // The example name is not the key.
    assert.doesNotMatch(fields[keys.name].placeholder.en, /stop\d/);
  }
  assert.deepEqual(Object.keys(fields), expected);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  const secret = fields.api_key;
  assert.equal(secret.type, 'secret');
  assert.equal(secret.required, true);
  assert.equal('default' in secret, false);
  assert.equal('placeholder' in secret, false);
  assert.match(
    secret.description.en,
    /Kept by Gladys in its database, never shown again, sent only to 511\.org\./,
  );
  assert.match(
    secret.description.fr,
    /Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à 511\.org\./,
  );
  assert.equal(fields.refresh_minutes.default, REFRESH_DEFAULT);
  assert.equal(fields.refresh_minutes.min, REFRESH_MIN);
  assert.equal(fields.refresh_minutes.max, REFRESH_MAX);
  assert.equal(fields.hourly_limit.default, HOURLY_LIMIT_DEFAULT);
  assert.equal(fields.hourly_limit.min, HOURLY_LIMIT_MIN);
  assert.equal(fields.hourly_limit.max, HOURLY_LIMIT_MAX);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(
    fields.alerts.options.map((o) => o.value),
    ALERT_MODES,
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  const defaults = normalizeConfig({ api_key: KEY, stop1_agency: 'SF', stop1_code: '1' });
  assert.equal(defaults.refreshMinutes, fields.refresh_minutes.default);
  assert.equal(defaults.hourlyLimit, fields.hourly_limit.default);
  assert.equal(defaults.language, fields.language.default);
  assert.equal(defaults.alerts ? 'on' : 'off', fields.alerts.default);
  for (const field of manifest.config_schema.filter((f) => f.type === 'select')) {
    assert.ok(
      field.options.some((o) => o.value === field.default),
      field.key,
    );
  }
});

test('actions and handlers agree; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(index.includes('app.connected()'));
  assert.ok(index.includes('app.start(config, { saved: true })'));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const file of ['src/api.js', 'src/app.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    for (const word of ["'POST'", "'PUT'", "'DELETE'", 'Mozilla']) {
      assert.ok(!code.includes(word), `${file}: never ${word}`);
    }
  }
});

test('the published devices follow the core rules (supported_options, units, ranges)', async () => {
  const gladys = createFakeGladys({ selector: 'sfbay' });
  const devices = buildDevices(gladys, normalizeConfig(FIVE));
  assert.equal(devices.length, 5);
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  let unitsByCategory = null;
  if (existsSync(core)) {
    const require = createRequire(core);
    unitsByCategory = require(core.pathname).DEVICE_FEATURE_UNITS_BY_CATEGORY;
  }
  for (const device of devices) {
    assert.doesNotMatch(device.external_id, /\.|:.*:.*:.*:/);
    const ids = new Set();
    for (const feature of device.features) {
      assert.ok(!ids.has(feature.external_id));
      ids.add(feature.external_id);
      // Label a plain non-empty string without outer spaces, value integer or
      // string, unique, no other key: a single error rejects the Discovery.
      const options = feature.supported_options ?? [];
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(String(option.value)));
        values.add(String(option.value));
      }
      assert.equal(options.length, 0);
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.type, 'binary');
      assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max));
      assert.equal(typeof feature.has_feedback, 'boolean');
      assert.match(feature.name, /511\.org/, 'the attribution next to the data');
      if (feature.unit && unitsByCategory) {
        assert.ok(unitsByCategory[feature.category]?.includes(feature.unit), feature.external_id);
      }
    }
  }
  // The fake Gladys of the SDK applies the core checks on publication.
  await gladys.connect();
  await gladys.publishDiscoveredDevices(devices);
});

test('the licenses ship in the image; no name in LICENSE; 511 acknowledged', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /511 Data Disseminator\s+Agreement/);
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  assert.match(intro.description.en, /data provided by 511\.org/);
  assert.match(intro.description.fr, /données fournies par 511\.org/);
  assert.ok(intro.links.some((l) => l.url === 'https://511.org/'));
  for (const file of ['README.md', 'docs/en.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(read(file), /[Dd]ata provided by 511\.org/, file);
    assert.match(read(file), /not an official source/i, file);
  }
  assert.match(read('docs/fr.md'), /[Dd]onnées fournies par 511\.org/);
  assert.match(read('docs/fr.md'), /pas une source officielle/i);
  for (const file of ['docs/en.md', 'docs/fr.md', 'README.md']) {
    assert.match(read(file), /jamais (été )?testée? avec un vrai|never tested with a real/i, file);
  }
});
