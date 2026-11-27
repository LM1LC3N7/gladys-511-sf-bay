// -----------------------------------------------------------------------------
// One Gladys device per watched stop, read-only. Its id is the slot of the
// stop in the configuration, its agency and its code (`stop:1-SF-15553`):
// another stop in a slot is another device, never an old device (with the
// values of the old stop) under a new stop. The line filter can change
// without a new device: every read publishes every value again.
//
// Features: the next and the following departure (texts: a departure that no
// longer exists is replaced by "no departure", never left as a number), the
// departures within 60 minutes and the alerts in effect (counters, for the
// scenes), and the first alert (text). No `poll_frequency`: the app reads 511
// at the pace its quota allows.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COUNT_MAX, DEVICE_TYPE, FEATURES } from './constants.js';
import { stopLabel, t } from './i18n.js';

/** The ids of a stop device: slot, agency, code (`ext:<selector>:stop:1-SF-15553`). */
export const stopIds = (gladys, stop) =>
  gladys.externalIds(DEVICE_TYPE, `${stop.slot}-${stop.agency}-${stop.code}`);

export function buildDevice(gladys, stop, language) {
  const ids = stopIds(gladys, stop);
  const counter = (key, name, history) => ({
    name,
    external_id: ids.feature(key),
    category: C.COUNTER_SENSOR,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: COUNT_MAX,
    read_only: true,
    has_feedback: false,
    keep_history: history,
  });
  const text = (key, name) => ({
    name,
    external_id: ids.feature(key),
    category: C.TEXT,
    type: T.TEXT.TEXT,
    // The core columns are NOT NULL; a text has no range (0/0 as the core UI).
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  return {
    name: stopLabel(stop, language),
    external_id: ids.device,
    params: [
      { name: 'agency', value: stop.agency },
      { name: 'stop_code', value: stop.code },
    ],
    features: [
      text(FEATURES.NEXT, t(language, 'next')),
      text(FEATURES.SECOND, t(language, 'second')),
      counter(FEATURES.DEPARTURES, t(language, 'departures'), false),
      counter(FEATURES.ALERTS, t(language, 'alerts'), true),
      text(FEATURES.ALERT_TEXT, t(language, 'alertText')),
    ],
  };
}

export function buildDevices(gladys, config) {
  return config.stops.map((stop) => buildDevice(gladys, stop, config.language));
}
