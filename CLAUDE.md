# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the transit API of 511 SF Bay Open Data
with the user's own token.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/mutants.mjs [3,7]            # mutation check of the guards (memcap)
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        SfBayApp: rounds, quota guard, pauses, refused token, freshness, status
src/quota.js                      plan() (intervals within 90 % of the hourly limit) and the sliding-hour guard
src/api.js                        one bounded GET (time, body), BOM removed, statuses to kinds; never the URL out
src/siri.js                       strict reading of StopMonitoring (SIRI JSON) and alerts (GTFS-RT JSON)
src/config.js                     strict reading of the configuration (manifest `config_schema`)
src/devices.js                    one read-only device per stop (id = slot, operator, stop code)
src/i18n.js                       every text, English and French
src/store.js                      /data state, never overwritten if unreadable
test/                             node --test, fake Gladys of the SDK, simulated 511, virtual clock (test/kit)
scripts/cover.mjs                 generates cover.png (800x534), plain Node
scripts/mutants.mjs, mutants.json mutation check of the guards
```

511 rules kept by the code: the token in the query string only, never logged; one request at a time, 2 s apart;
every request counted in the sliding hour (and in /data before it leaves), never beyond 90 % of the limit; a 429
pauses every read; a 401 of the departures is a refused token, never one of the alerts; nothing published for a
failed, unreadable, unconfirmed or clock-skewed answer; "data provided by 511.org" next to the data, "511" never
in the product name.

## Rules

- **External ids are forever** (`stop:<slot>-<operator>-<code>`), as the
  manifest `config_schema` keys and the feature keys.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  tokens, URLs (they carry the token) or stop codes in clear in /data.
- **Versions belong to the Release workflow**: 0.1.0 was set by hand once (see
  TODO.md); `test/manifest.test.js` checks the four places agree.
- **Changelog** under `## [Unreleased]`, never a version heading.
- **User-facing text** is bilingual (English and French), docs included.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback servers only).
