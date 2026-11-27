# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The next and following departure, the departures within 60 minutes, the
  service alerts in effect and the first alert at up to five stops of the San
  Francisco Bay Area, data provided by 511.org (your own free 511 token).
- The quota of the token kept (alerts too: their attempt and back-off survive a restart): intervals planned within 90 % of the hourly
  limit, every request counted (also across a restart), 429 and 5xx pauses.
