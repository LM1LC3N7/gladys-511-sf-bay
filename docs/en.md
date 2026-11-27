# SF Bay Area Transit

The **next departures** and the **service alerts** at up to five stops of the
San Francisco Bay Area (Muni, BART, Caltrain, AC Transit, SamTrans, VTA,
Golden Gate Transit, ferries...), in Gladys. Data provided by 511.org
([511.org](https://511.org/)).

This integration is unofficial: it is not affiliated with 511, MTC nor any
transit operator, and it is **not an official source**. Check 511.org or the
operator before you travel. It was never tested with a real 511 token nor on
a real Gladys installation by its author: it was written from the 511
specification and tested against a simulated 511 that follows it.

## Get started in 4 steps

1. **Get a free 511 token** on
   [511.org/open-data/token](https://511.org/open-data/token): you receive it
   by e-mail. Accepting the 511 terms is your choice: you are the one who
   receives the data.
2. **Find your stop.** You need the 511 id of the operator and the stop code:

   | Operator     | Id   |
   | ------------ | ---- |
   | Muni (SFMTA) | `SF` |
   | BART         | `BA` |
   | Caltrain     | `CT` |
   | AC Transit   | `AC` |
   | SamTrans     | `SM` |
   | VTA          | `SC` |
   | Golden Gate  | `GG` |

   The stop code is on the sign of most bus stops (Muni: 5 digits, e.g.
   `15553`), and in the stop list of the operator on 511.org. A parent station
   code gives every platform of the station.

3. **Install the integration** from the catalog, paste the token in
   **511 token**, type the operator and the stop code in **Stop 1**, and save.
4. Open the **Discover** tab and press **Add** on the stop.

**One device per stop.** A device belongs to a slot, its operator and its
stop code: typing another stop in a slot offers a new device; the old one is
no longer updated (delete it in Gladys). Changing the line filter keeps the
device.

## The quota of the token

A 511 token allows **60 requests per hour** by default (511 can raise it on
request: type your limit in **Hourly limit of your token**). The integration:

- reads each stop with **one request** per read (511 answers one stop per
  request), and the alerts with **one request per operator** every 15 minutes
  or more;
- plans the intervals so that **no hour holds more than 90 %** of your limit:
  with the default limit, 1 stop every 5 minutes plus its alerts is 16
  requests an hour; 5 stops of 3 operators are read every 8 minutes (52 an
  hour). When your interval does not fit, it is lengthened and the status
  says so;
- **counts every request it sends** and never sends one when the last hour
  already holds 90 % of the limit (it waits up to 2 minutes for a slot, else
  that read is skipped and the status says so). The count is written to
  `/data` before the request leaves, so a restart knows it. When `/data` cannot
  tell it (unreadable file), the first reads wait one interval;
- stops every read when 511 answers **429**: for the time it asks, 10
  minutes at least (doubled on the next ones), 6 hours at most, kept across a restart;
  a **5xx** of the departures pauses the reads 2 minutes (doubled, 6 hours at
  most).

Discovery, the **Show the last reads** button and saving an unchanged
configuration never read 511 (saving the configuration again only tries
a token refused before a restart once more).

## What each device holds

The feature names end with "(511.org)": the attribution 511 asks for, next
to the data.

- **Next departure** and **Following departure**: texts with the line, the
  destination, the minutes to wait (counted against the time of the 511
  answer) and the clock time, e.g. `14 MISSION → Downtown: 3 min (10:03)`;
  `, scheduled` when the operator gives only the timetable time. When there is
  none: `No predicted departure (read 10:05)`. They are texts so that a
  departure that no longer exists is never left on the dashboard as a number.
- **Departures within 60 min**: a counter, for the scenes.
- **Service alerts**: how many alerts are in effect now for the stop, its
  lines or its whole operator.
- **Alert**: the text of the first one, e.g. `Line 49 detour. (+1 more)`, or
  `No alert (read 10:05)`.

The **lines of a stop**, for the alerts, are the lines you filtered, else the
lines 511 showed at the stop (kept 7 days). Until a first departure is seen,
the alert count of the stop waits (the status says so): a count made without
the lines of the stop would miss their alerts. A line that has not called at
the stop for 7 days is forgotten.

## Never a made-up value

- A read that failed, an answer that cannot be read (one departure whose time
  cannot be read refuses the whole answer), an answer whose time differs from
  the clock of the machine by more than 5 minutes: **nothing is published**,
  never 0; the status says why and since when.
- "No predicted departure" is published only for a stop where 511 has shown a
  departure once: a mistyped stop code would otherwise look like an empty
  stop.
- A stop that 511 answers 404 (unknown) is tried again after 30 minutes; the
  other stops go on.
- A refused token (401 to a departures read) stops every read and is kept
  (a short fingerprint in `/data`, never the token): **save a new token** to
  read again. A 401 to an alerts read is not taken as a refused token.

## Privacy

The token is kept by Gladys in its database, never shown again, sent only to
511.org, never written in the logs, the status nor `/data`. Your stops are
written to `/data` only as salted fingerprints.

## Licence and data

The code is under the Apache License 2.0. The data is provided by 511.org
(Metropolitan Transportation Commission) under the 511 Data Disseminator
Agreement that you accept with your token: data provided by 511.org, no
warranty, no operator logo. The integration does not use "511" as a brand.
