# SF Bay Area Transit for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration: the next
departures (Muni, BART, Caltrain, AC Transit, SamTrans, VTA, Golden Gate...)
and the service alerts at up to five stops of the San Francisco Bay Area. Data
provided by 511.org ([511.org](https://511.org/)), read with your own free 511
token.

It is **not an official source**, nor endorsed by 511, MTC or any operator. It
was never tested with a real 511 token nor on a real Gladys: it follows the
511 SF Bay Open Data specification (transit) and is tested against a simulated
511 built from it.

- **Quota first**: a 511 token allows 60 requests per hour by default; the
  integration plans and counts its requests so that no hour holds more than
  90 % of your limit, also across a restart (counted in `/data`).
- One device per stop: next and following departure (texts), departures
  within 60 minutes and alerts in effect (counters), first alert (text).
- Never a made-up value: a failed or unreadable read publishes nothing.

User documentation: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test, fake Gladys of the SDK, simulated 511, virtual clock
npm run lint
npm run format:check
node scripts/mutants.mjs   # mutation check of the guards (one at a time; use memcap)
node scripts/cover.mjs cover.png
```

## Licence

Apache License 2.0 (see `LICENSE`). Data provided by 511.org under the 511
Data Disseminator Agreement, see `THIRD_PARTY_NOTICES.md`.
