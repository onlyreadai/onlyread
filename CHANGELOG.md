# Changelog

## [1.0.1] - 2026-11-10

### Fixed

- LinkedIn: a post's comment box, a company page's message box and LinkedIn's own error toasts open again; they were refused as writes.
- Refusals by the built-in rules (PUT, PATCH, DELETE, form posts, blocked paths) now show the in-page notice too.
- The notice shows above a site's open dialog, and beside a site's own toast instead of covering it.
- A site resending a refused request counts as one change in Activity and the notice.
- An agent's browser signed in by a setup link applies a site removal made on the Pro account while an agent works there.
- Support reports with a binary request body (a refused gzip request on LinkedIn) send again; they failed on the service.
- Pro account page: the report and PIN dialogs cover the whole window instead of being clipped to the framed section.

### Changed

- Guard every site: a site with a profile gets its whole profile whether its switch is on or not.
  In the popup, a site's switch then allows or guards that site, and an allowed host stays fully unguarded.

### Added

- Pro: "Try the demo" on the Pro settings card and the account page; framed settings follow the account page's light or dark theme.

## [1.0.0] - 2026-11-05

First release.

[1.0.1]: https://github.com/onlyreadai/onlyread/releases/tag/v1.0.1
[1.0.0]: https://github.com/onlyreadai/onlyread/releases/tag/v1.0.0
