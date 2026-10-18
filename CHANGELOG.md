# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [1.2.0] — 2026-10-17

### Added

- **Translated settings card.** The card's labels and notes follow the
  language picked under Profile → Language on BackIssue 0.9.1 and newer, and
  stay English on older ones. Translations ship for French, German, Spanish,
  Italian, Portuguese (Portugal and Brazil), Dutch, Polish, Japanese and
  Simplified Chinese in `locales/`. Also covers the permission, job and
  library-type labels, the plugin description and the notification titles
  shown in BackIssue’s own screens.

## [1.1.0] — 2026-07-08

### Added
- Watch announce bots: hub bots that announce new uploads with magnet links are
  scanned (main chat and PM), and announced files matching a missing issue of a
  followed series download automatically by exact hash.

## [1.0.0] — 2026-07-08

Initial release: a Direct Connect download source via the AirDC++ Web API.

Adaptive search (returns as soon as a confident match arrives, gives up early on
silence), multi-issue filelist packs, and completed downloads are left in place
so AirDC++ keeps sharing them.
