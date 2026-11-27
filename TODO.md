# TODO

## Before announcing

- [x] Repository renamed `gladys-511-sf-bay` → `gladys-sf-bay-transit` before the first release (decision of Louis,
      2026-11-27): section 5.c of the 511 Data Disseminator Agreement forbids "511" in a product name.
- [ ] Section 2.g: notify MTC within 30 days of the launch (message prepared, sent by Louis).
- [ ] Try it with a real 511 token: the shape of a StopMonitoring answer of the live API (`ServiceDelivery` at the
      top, lists, `ExpectedDepartureTime` empty or null when not monitored), the alerts feed in JSON (key case,
      `Header.Timestamp` refresh), the 429 of the quota (status, `Retry-After`), the BOM, the operator ids of the
      docs (SF, BA, CT, AC, SM, SC, GG) with the `operators` endpoint.
- [ ] Install it on a real Gladys 5.3+ and add a stop: device creation, the texts in the dashboard.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store (after the first release).
- [ ] 511 Data Disseminator Agreement 2.g (https://511.org/sites/default/files/2026-04/511_Data_Agreement_Final_2026.pdf): MTC asks for a documentation of a product using the data within 30 days of
      launch (screenshots, URL). Each user is the registered disseminator of their token; whether the integration
      itself should be announced to developerresources@511.org is Louis's call.

## To confirm on the live API

- [ ] `ALERTS_STALE` (6 h): a feed whose `Header.Timestamp` is older than that against the server `Date` is not
      used. If 511 leaves the header time of a quiet operator old, raise it.
- [ ] Whether a quota answer (429) counts against the quota itself (assumed: every request sent is counted).
- [ ] **How 511 answers a request over the quota**: the 429 is documented nowhere (neither the specification nor
      the transit page). If 511 answered 401 instead, a departures read over the quota would be taken as a refused
      token (reads stopped until a token is saved again). The 90 % plan and the guard make it unlikely; to check with
      a real token (review r1).
- [ ] A token changed while the integration is stopped has 1 chance in 256 to match the 8-bit fingerprint of a
      refused one: it waits for a save of the configuration (review r1, m6).
- [ ] The RouteId / StopId of the alerts: the same ids as `LineRef` / the stop code of StopMonitoring (assumed), or
      prefixed (`SF:15553` is accepted for the stop).

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-sf-bay-transit:0.1.0`).
- **SDK `^0.16.1`**, the latest published (npm registry, 2026-11-27). `gladys_version >=5.3.0` for `countries: ["US"]`.
- **Quota** (511.org/open-data/transit, read on 2026-11-27: "60 requests per 3600 seconds" per token by default,
  more on request): the user types the limit of their token (20 to 1000, default 60); the plan keeps the worst
  sliding hour within 90 % of it (`ceil(60 / interval)` rounds per hour, one request per stop, alerts one per operator
  and a third of the budget at most); the guard counts every request sent (monotonic clock in the process, wall
  times in /data written before the request leaves) and never sends beyond the budget (waits 2 min at most for a
  slot, else the request is skipped). /data unreadable: the first reads wait one interval. A future time in /data
  counts as "now" (the safe side).
- **One request per stop**: StopMonitoring takes one `stopCode`; without it 511 answers every stop of the operator
  (megabytes, 5-7 s), never used.
- **JSON only** (`format=json`), so no protobuf library; the UTF-8 BOM 511 sometimes sends is removed before parsing.
- **Freshness**: the response time of 511 (`ResponseTimestamp`, else the HTTP `Date`) must be within 5 minutes of the
  local clock; minutes counted against it.
- **"No departure" needs a confirmed stop**: a stop is confirmed once 511 showed a visit there (salted fingerprint in
  /data); until then an empty answer publishes nothing.
- **Alerts**: per operator, every 15 minutes or more; an alert counts for a stop when one of its informed entities
  names it (every field it sets must match: operator, line, stop, trip line); the lines of a stop are the filter,
  else the lines seen there (7 days, 30 at most); no alert count before they are known.
- **Refused token**: a 401 of StopMonitoring only (a 401 of the alerts is never a refusal); 8-bit salted fingerprint
  in /data, the full hash in memory; a saved token that is not the one refused in this process is always tried once.
- **Pauses**: 429 pauses every read (Retry-After, else 10 min doubled, 6 h at most); 5xx or another 4xx (but 400 and 404) of the departures pause every read (2 min doubled); 400/404 of a stop: that stop again after 30 min; a failed
  alerts read: that operator again one alerts interval later, doubled, 2 h at most.
- **Alerts after a restart** (review r1, B1): the time of the attempt and the back-off level of each operator are
  written to /data before the request leaves; a restart reads them again only after `attempt + back-off`.
- **Line filter** that matches none of the visits 3 reads in a row: said in the status (review r1, m5).
- **Alerts feed without a header time**: not used (never "no alert" from a feed of unknown age, review r1, m4).
- **A new token saved** is read at once (review r1, m6).
- **Timers**: never armed on a non-finite delay nor longer than 1 h; at least 1 s between two rounds.
- **No scene trigger** in 0.1.0 (the counters serve the scenes); a "new alert" trigger could come later.
- **Name**: "SF Bay Area Transit" (no "511" in the brand, agreement 5.c); attribution "data provided by 511.org" in
  the name of the first feature of each device (word for word, review r1, m3), "(511.org)" on the others, the status, the configuration screen and the docs (5.b).
- **Mutation** (milestone 1): the 45 mutants of `scripts/mutants.json`, one at a time on a copy of the repository
  (`node scripts/mutants.mjs`, under `memcap`): all killed after three tests were added (request in /data before it
  leaves, timers bounded, a second between rounds).
- **Checked**: `gi ci` (Prettier, ESLint, Node 24 and 22, Docker, store validator), the suite 20 times under
  `node:22-alpine` (TAP reporter), `npm audit --omit=dev` clean, `gi install` in the sandbox Gladys (RUNNING, no request
  without a token; container removed afterwards). Never run against the live 511 API with a token.

## Next patch

- Review minors: see `_lots/lot25/reviews/511-sf-bay-r2.md` (4 trous de test : niveau remis à 0, plafond 2 h, filtre, crash en vol ; Header.Timestamp absent ou 0 pour un opérateur calme, voir ALERTS_STALE).
