# Third-party notices

## 511 SF Bay Open Data (Metropolitan Transportation Commission)

Data provided by 511.org (https://511.org/). The integration reads, at run time and with the token of each user,
the transit API of 511 SF Bay Open Data (https://511.org/open-data/transit): StopMonitoring (SIRI, JSON) and
service alerts (GTFS-Realtime, JSON). Each user requests their own token and accepts the 511 Data Disseminator
Agreement (https://511.org/sites/default/files/pdfs/511_Data_Agreement_Final.pdf, read on 2026-11-27): a
non-exclusive, royalty-free license to use, store and display the data (section 1), the acknowledgement "data
provided by 511.org" with a link to 511.org next to the data (section 5.b: in the feature names, the status, the
configuration screen and the documentation), no logo or mark of the operators (section 2.f, 5.d), no "511" in the
name or branding of the product (section 5.c), no warranty (section 3). The integration is not endorsed by 511,
MTC nor any operator, and it is not an official source.

No code of 511 is used: the client is written from the "511 SF Bay Open Data Specification - Transit" (November 2022) and the GTFS-Realtime reference (https://gtfs.org/realtime/reference/). The test fixtures are synthetic,
written after the examples of that specification; no answer of the live API is copied (no token was used).

## gladys-testkit

`test/kit/clock.mjs` is copied from gladys-testkit (Apache-2.0, same author as this repository).

## npm dependencies

The only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0); its license ships in
`node_modules/@gladysassistant/integration-sdk/LICENSE` of the image. No protobuf library: 511 serves the alerts
in JSON (`format=json`).
