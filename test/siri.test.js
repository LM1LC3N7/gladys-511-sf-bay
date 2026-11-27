// -----------------------------------------------------------------------------
// Strict reading of the 511 answers: the examples of the specification
// (appendix B.1.10 and B.1.16, shapes copied, values synthetic) and the
// shape of the live API.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertsForStop,
  inEffect,
  pick,
  readAlerts,
  readDateTime,
  readStopMonitoring,
  readVisit,
  selects,
} from '../src/siri.js';
import {
  alertEntity,
  alertsFeed,
  iso,
  stopMonitoring,
  visit,
  START,
  MINUTE,
} from './helpers/setup.js';

const NOW = START;

test('the live shape: ServiceDelivery at the top, a list of visits', () => {
  const read = readStopMonitoring(
    stopMonitoring(NOW, [visit(NOW, 3), visit(NOW, 10, { expected: false })]),
  );
  assert.equal(read.at, NOW);
  assert.equal(read.visits.length, 2);
  assert.deepEqual(read.visits[0], {
    line: '14',
    lineName: 'MISSION',
    destination: 'Downtown',
    time: NOW + 3 * MINUTE,
    realtime: true,
    stopRef: '15553',
  });
  assert.equal(read.visits[1].realtime, false, 'aimed time only: scheduled');
});

test('the shape of the specification: a Siri wrapper, one visit as an object, offsets', () => {
  const json = {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: '2004-12-17T09:30:46-05:00',
        ProducerRef: 'BA',
        Status: true,
        StopMonitoringDelivery: {
          version: 1.4,
          ResponseTimestamp: '2004-12-17T09:30:47-05:00',
          Status: true,
          MonitoredStopVisit: {
            RecordedAtTime: '2004-12-17T09:25:46-05:00',
            MonitoringRef: 'EMBR',
            MonitoredVehicleJourney: {
              LineRef: 'Warm Springs/South Fremont - Daly City',
              PublishedLineName: 'Warm Springs/South Fremont - Daly City',
              DestinationName: 'Warm Springs/South Fremont',
              MonitoredCall: {
                StopPointRef: 'EMBR',
                AimedArrivalTime: '2004-12-17T09:40:46-05:00',
                ExpectedArrivalTime: '2004-12-17T09:40:46-05:00',
                AimedDepartureTime: '2004-12-17T09:42:47-05:00',
                ExpectedDepartureTime: '2004-12-17T09:40:47-05:00',
              },
            },
          },
        },
      },
    },
  };
  const read = readStopMonitoring(json);
  assert.equal(read.at, Date.parse('2004-12-17T14:30:46Z'));
  assert.equal(read.visits.length, 1);
  assert.equal(read.visits[0].time, Date.parse('2004-12-17T14:40:47Z'), 'expected departure first');
  assert.equal(read.visits[0].destination, 'Warm Springs/South Fremont');
});

test('no visit, an empty list or null: no departure (not an error)', () => {
  for (const visits of [[], null, undefined, '']) {
    const json = stopMonitoring(NOW, visits);
    if (visits === undefined) delete json.ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit;
    assert.deepEqual(readStopMonitoring(json), { at: NOW, visits: [] });
  }
});

test('one unreadable visit refuses the whole answer; a visit without any time is skipped', () => {
  const bad = visit(NOW, 3);
  bad.MonitoredVehicleJourney.MonitoredCall.ExpectedDepartureTime = '2026-11-27 18:03';
  assert.deepEqual(readStopMonitoring(stopMonitoring(NOW, [visit(NOW, 1), bad])), {
    unreadable: true,
  });
  const noLine = visit(NOW, 3);
  delete noLine.MonitoredVehicleJourney.LineRef;
  delete noLine.MonitoredVehicleJourney.PublishedLineName;
  assert.deepEqual(readStopMonitoring(stopMonitoring(NOW, [noLine])), { unreadable: true });
  const none = visit(NOW, 3);
  const call = none.MonitoredVehicleJourney.MonitoredCall;
  for (const k of [
    'AimedArrivalTime',
    'ExpectedArrivalTime',
    'AimedDepartureTime',
    'ExpectedDepartureTime',
  ]) {
    call[k] = '';
  }
  assert.deepEqual(readVisit(none), { skip: true });
  assert.equal(readStopMonitoring(stopMonitoring(NOW, [none, visit(NOW, 4)])).visits.length, 1);
});

test('not a ServiceDelivery, Status false, a bad response time, too many visits', () => {
  assert.equal(readStopMonitoring(null), null);
  assert.equal(readStopMonitoring('<html>'), null);
  assert.equal(readStopMonitoring({ data: [] }), null);
  const refused = stopMonitoring(NOW, []);
  refused.ServiceDelivery.StopMonitoringDelivery.Status = false;
  assert.deepEqual(readStopMonitoring(refused), { refused: true });
  const badTime = stopMonitoring(NOW, []);
  badTime.ServiceDelivery.ResponseTimestamp = 'yesterday';
  assert.equal(readStopMonitoring(badTime), null);
  const many = stopMonitoring(
    NOW,
    Array.from({ length: 1001 }, (_, i) => visit(NOW, i % 50)),
  );
  assert.equal(readStopMonitoring(many), null);
  const noTime = stopMonitoring(NOW, [visit(NOW, 1)]);
  delete noTime.ServiceDelivery.ResponseTimestamp;
  delete noTime.ServiceDelivery.StopMonitoringDelivery.ResponseTimestamp;
  assert.equal(readStopMonitoring(noTime).at, null, 'the HTTP Date decides then');
});

test('times: offset or Z required, impossible dates refused', () => {
  assert.equal(readDateTime('2026-11-27T18:00:00Z'), START);
  assert.equal(readDateTime('2026-11-27T10:00:00-08:00'), START);
  assert.equal(readDateTime('2026-11-27T18:00:00.1234567Z'), START);
  assert.equal(readDateTime('2026-11-27T18:00:00'), null);
  assert.equal(readDateTime('2026-02-30T18:00:00Z'), null);
  assert.equal(readDateTime(1764266400000), null);
});

test('pick: any case and underscores, own keys only', () => {
  assert.equal(pick({ HeaderText: 1 }, 'header_text'), 1);
  assert.equal(pick({ header_text: 2 }, 'HeaderText'), 2);
  assert.equal(pick(JSON.parse('{"__proto__": {"x": 1}}'), 'toString'), undefined);
  assert.equal(pick({}, 'constructor'), undefined);
  assert.equal(pick(null, 'a'), undefined);
});

test('the alerts example of the specification (PascalCase) is read', () => {
  const json = {
    Header: { GtfsRealtimeVersion: '1.0', incrementality: 0, Timestamp: 1590704336 },
    Entities: [
      {
        Id: '3469',
        TripUpdate: null,
        Vehicle: null,
        Alert: {
          ActivePeriods: [{ Start: 1532736000, End: 1609488000 }],
          InformedEntities: [{ AgencyId: '5S', Trip: null }],
          cause: 1,
          effect: 8,
          Url: { Translations: [{ Text: '', Language: 'en' }] },
          HeaderText: { Translations: [{ Text: 'Call 511 for more.', Language: 'en' }] },
          DescriptionText: { Translations: [{ Text: 'Details.', Language: 'en' }] },
          TtsHeaderText: null,
          TtsDescriptionText: null,
        },
      },
    ],
  };
  const read = readAlerts(json);
  assert.equal(read.at, 1590704336000);
  assert.equal(read.alerts.length, 1);
  const [alert] = read.alerts;
  assert.equal(alert.header, 'Call 511 for more.');
  assert.deepEqual(alert.periods, [{ start: 1532736000000, end: 1609488000000 }]);
  assert.deepEqual(alert.selectors, [{ agency: '5S', route: null, stop: null, tripRoute: null }]);
});

test('the GTFS-RT reference names (entity, active_period, informed_entity) are read too', () => {
  const json = {
    header: { gtfs_realtime_version: '2.0', timestamp: '1764266400' },
    entity: [
      { id: 'a', trip_update: {} },
      {
        id: 'b',
        alert: {
          active_period: [{ start: '1764266000' }],
          informed_entity: [{ route_id: '14', agency_id: 'SF' }, { trip: { route_id: '49' } }],
          header_text: {
            translation: [
              { text: 'Detour', language: 'en' },
              { text: 'Déviation', language: 'fr' },
            ],
          },
        },
      },
      { id: 'c', is_deleted: true, alert: {} },
    ],
  };
  const read = readAlerts(json, 'fr');
  assert.equal(read.alerts.length, 1);
  assert.equal(read.alerts[0].header, 'Déviation');
  assert.deepEqual(read.alerts[0].periods, [{ start: 1764266000000, end: null }]);
  assert.equal(read.alerts[0].selectors[1].tripRoute, '49');
  assert.equal(readAlerts(json, 'en').alerts[0].header, 'Detour');
});

test('an unreadable alert refuses the feed; no header is not a feed', () => {
  assert.equal(readAlerts({ Entities: [] }), null);
  assert.equal(readAlerts([]), null);
  assert.equal(readAlerts({ Header: { Timestamp: 'now' }, Entities: [] }), null);
  const noId = alertsFeed(NOW, [alertEntity('x')]);
  delete noId.Entities[0].Id;
  assert.deepEqual(readAlerts(noId), { unreadable: true });
  const badPeriod = alertsFeed(NOW, [alertEntity('x')]);
  badPeriod.Entities[0].Alert.ActivePeriods = [{ Start: -5 }];
  assert.deepEqual(readAlerts(badPeriod), { unreadable: true });
  assert.deepEqual(readAlerts(alertsFeed(NOW, [])), { at: NOW, alerts: [] });
});

test('in effect: open periods, any period, none means always', () => {
  const alert = (periods) => ({ periods });
  assert.ok(inEffect(alert([]), NOW));
  assert.ok(inEffect(alert([{ start: null, end: null }]), NOW));
  assert.ok(inEffect(alert([{ start: NOW - 1, end: NOW + 1 }]), NOW));
  assert.ok(!inEffect(alert([{ start: NOW + 1, end: null }]), NOW));
  assert.ok(!inEffect(alert([{ start: null, end: NOW - 1 }]), NOW));
  assert.ok(
    inEffect(
      alert([
        { start: NOW + 1, end: null },
        { start: NOW - 5, end: NOW + 5 },
      ]),
      NOW,
    ),
  );
});

test('selectors: every field set must match; an empty selector names nothing', () => {
  const stop = { agency: 'SF', code: '15553' };
  const lines = new Set(['14', 'mission']);
  const s = (o) => ({ agency: null, route: null, stop: null, tripRoute: null, ...o });
  assert.ok(selects(s({ agency: 'sf' }), stop, lines), 'agency-wide');
  assert.ok(!selects(s({ agency: 'BA' }), stop, lines));
  assert.ok(selects(s({ route: '14' }), stop, lines));
  assert.ok(!selects(s({ route: '22' }), stop, lines));
  assert.ok(!selects(s({ agency: 'SF', route: '22' }), stop, lines));
  assert.ok(selects(s({ stop: '15553' }), stop, lines));
  assert.ok(selects(s({ stop: 'SF:15553' }), stop, lines));
  assert.ok(!selects(s({ stop: '15554' }), stop, lines));
  assert.ok(!selects(s({ stop: '15553', route: '22' }), stop, lines));
  assert.ok(selects(s({ tripRoute: 'MISSION' }), stop, lines));
  assert.ok(!selects(s({}), stop, lines));
  const alerts = readAlerts(
    alertsFeed(NOW, [
      alertEntity(1, { agency: 'SF' }),
      alertEntity(2, { agency: 'SF', route: '22' }),
      alertEntity(3, { agency: 'SF', stop: '15553', start: Math.floor(NOW / 1000) + 60 }),
      alertEntity(4, { agency: 'SF', stop: '15553' }),
    ]),
  ).alerts;
  assert.deepEqual(
    alertsForStop(alerts, stop, lines, NOW).map((a) => a.id),
    ['1', '4'],
  );
  assert.equal(iso(NOW), '2026-11-27T18:00:00Z');
});
