# Contributing

## Setup

Node 22+ and Python 3.11+ (the harness uses the standard library only, plus `pip install ruff` for linting).

    npm install
    npm run build          # → extension/dist
    npm run dev            # build on every save, and Chrome reloads the extension or its pages by itself
    npm run hooks          # installs the pre-commit scrub check
    npm run check          # typecheck, lint (Biome, Ruff), unit tests, fingerprint tests, build, scrub
    npm run e2e            # the extension in headless Chrome: fixture tests and the traffic replay

Code style: match the code around you. Linting catches bugs, not layout. There is no auto-formatter.
The harness is described in [harness/README.md](harness/README.md).

Load `extension/` unpacked in a **dedicated Chrome profile**. The dev build talks to the local harness
(`npm run fixture` starts it on port 4173). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). That is also
why the profile must be dedicated: a development build polls `localhost:4173` for commands, so any process
on the machine that listens there can change the extension's settings and read its API keys. Release
builds have no such channel.

A development build's OnlyRead Pro service is chosen when it is built. By default it is the mock in the fixture server
(a sign-in falls back to production when the mock is not running), and the build keeps whatever service the browser
already uses. `ONLYREAD_SERVICE_URL=https://pro.onlyread.ai npm run dev` (or `npm run build`) builds for production
instead, and the browser moves to it when the build starts, signing out of the service it leaves. Put the variable on
the command rather than exporting it: every build in that shell would use it. The e2e scripts always build for the
mock, and the suites refuse to start on a build made for another service (`e2e/global-setup.ts`), so run them with
`npm run e2e`, or `npm run build` first with the variable unset.

## Adding a site

If you only want a site supported, [open a site request](https://github.com/onlyreadai/onlyread/issues/new?template=site-request.yml)
instead. To add one yourself:

The workflow is fixed: scaffold with
`harness/site/new_app.py`, record a monitor session, label every endpoint, score, build the verdict cache,
write a decoder if reads and writes share an endpoint, verify in enforce against server truth, then
write `coverage.json` (`build_site.py` then writes the site's `README.md` from it). After labeling, build the site's replay file (`python3 harness/site/replay_corpus.py <site>`) and add the
site's start URL to `SITES` in `e2e/replay.spec.ts`, so CI replays its traffic on every push. A site's profile is marked verified (its tested list ships, though the UI shows no badge for it) only when reads pass with zero false blocks
and every tested write is refused and did not persist.

Rules for test accounts: use dedicated accounts, act only on content the test account owns, and never
send invites, messages or reactions to real people.

## Private data

`apps/*/sessions/` holds raw recordings (request bodies, tokens, message text). It is git-ignored and
must never be committed. Before committing labels, scores or reports, run `npm run scrub`, and list your own
account identifiers in `.env` as `ONLYREAD_PRIVATE_IDS=` so the check can find them.

## License and contributor agreement

OnlyRead is open source under the [GNU Affero General Public License v3.0](LICENSE), and will stay that
way. The same code also powers a hosted service, OnlyRead Pro, which may be offered for a fee. To make that possible, every
contributor signs the [Contributor License Agreement](CLA.md) once, before the first pull request is
merged:

- you keep the copyright to your contribution,
- you grant OnlyRead AI (In Formation) the right to use it under other terms as well, including commercial and hosted
  offerings,
- everything merged here remains available to everyone under the AGPL-3.0.

A bot asks for the signature on your first pull request.
