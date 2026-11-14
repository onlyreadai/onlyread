#!/usr/bin/env python3
"""Build a bundled site profile from an app directory.

    python3 harness/site/build_site.py gmail "Gmail"
    python3 harness/site/build_site.py calendar "Google Calendar"
    python3 harness/site/build_site.py linear "Linear"

Reads apps/<app>/policy.json (domains, telemetry, blocked GET paths, shape lists) and
apps/<app>/cache.json (verdicts from the labels) and writes extension/policy/sites/<app>.json, the
profile the popup lists and toggles, and apps/<app>/README.md, the site's public summary of what was tested
(from site.json and coverage.json, then apps/<app>/how-it-works.md when the site has its own mechanism to explain),
and docs/SITES.md, the same lists for every tested site, so the public doc cannot drift from the coverage files.
Judge settings stay in the global policy.

    python3 harness/site/build_site.py --check

Builds the same outputs in memory, compares them with the files on disk and writes nothing.
It prints the files that differ and exits 1, or exits 0 when everything matches. With no site
argument it checks every site that has an apps/<site>/site.json and a coverage.json; with a
site argument it checks just that site."""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
# Official product icons, loaded at runtime (nothing bundled); the popup falls back to the site favicon.
DESCRIPTIONS = {
    "gmail": "Read mail, search and open messages. Refuses star, archive, trash, snooze, labels, drafts, send, replies and settings changes.",
    "calendar": "Browse calendars, events, search and settings. Refuses event changes, settings, calendar creation and deletion.",
    "linear": "Read issues, projects, cycles and views. Refuses issue, project, comment, reaction and settings mutations.",
}
ICONS = {
    "gmail": "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
    "calendar": "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
    "linear": "https://linear.app/favicon.ico",
}


def load_inputs(app):
    src = ROOT / "apps" / app
    site_meta = json.loads((src / "site.json").read_text()) if (src / "site.json").exists() else {}
    pol = json.loads((src / "policy.json").read_text())
    cache = json.loads((src / "cache.json").read_text()) if (src / "cache.json").exists() else {}
    coverage = json.loads((src / "coverage.json").read_text()) if (src / "coverage.json").exists() else None
    return src, site_meta, pol, cache, coverage


def build_profile(app, name, site_meta, pol, cache, coverage):
    return {
        "id": app,
        "name": name,
        "domains": pol["targetDomains"],
        "verified": bool(site_meta.get("verified", True)),  # set false in apps/<app>/site.json until the enforce run is done
        "iconUrl": site_meta.get("iconUrl") or ICONS.get(app),
        "description": site_meta.get("description") or DESCRIPTIONS.get(app, ""),
        # The one part of coverage.json the extension shows (the site's card names what the guard does not cover); what was
        # tested goes to the README and docs/SITES.md below, not into the profile.
        **({"outOfScope": coverage["outOfScope"]} if coverage and coverage.get("outOfScope") else {}),
        "telemetryAllow": pol.get("telemetryAllow", []),
        "blockedGetPaths": pol.get("blockedGetPaths", []),
        "blockedShapes": pol.get("blockedShapes", []),
        "allowedShapes": pol.get("allowedShapes", []),
        "websockets": pol.get("websockets"),  # per-site WS: allow (Linear sync socket) or block; None -> global default
        "blockResponse": pol.get("blockResponse"),  # per-site: reject (rollback for local-first apps) or fail; None -> global default
        "editorGuard": bool(pol.get("editorGuard", False)),  # per-site UI guard: lock rich-text editors (Linear: content writes ride the WS)
        # per-site stanza guard for a socket that carries reads and writes (WhatsApp): only for a site that has one (SiteProfile
        # types it as absent, not null)
        **({"socketGuard": pol["socketGuard"]} if pol.get("socketGuard") else {}),
        "readTrackingShapes": pol.get("readTrackingShapes", []),
        "readPutPaths": pol.get("readPutPaths", []),  # per-site: exact paths where a PUT is a read (a live-updates subscription)
        "cache": {fp: {k: v for k, v in e.items() if k in ("verdict", "pWrite", "note")} for fp, e in cache.items()},
    }


def bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items)


def readme(app, name, profile, src, site_meta, coverage) -> str:
    """The site's public summary: what it is, what was tested, and how."""
    parts = [f"# {name}", "", profile["description"], "", "Domains: " + ", ".join(f"`{d}`" for d in profile["domains"])]
    if site_meta.get("domainsNote"):  # why a domain that is not the site's own is in the profile
        parts += ["", site_meta["domainsNote"]]
    if coverage and (coverage.get("passes") or coverage.get("refused")):
        parts += ["", "## Tested", ""]
        if coverage.get("passes"):
            parts += ["Reads that work with OnlyRead on:", "", bullets(coverage["passes"]), ""]
        if coverage.get("refused"):
            parts += ["Writes that are refused (implicit ones are writes the page makes on its own):", "",
                      bullets(coverage["refused"]), ""]
        parts += ["## How it was verified", "",
                  "Every read above was used with OnlyRead enforcing, with no request wrongly refused. Every write above was",
                  "attempted, refused, and checked against the server's own view after a reload: none of them persisted."]
        if coverage.get("leakCheck"):
            parts += ["The recorded run passed the leak check: no request OnlyRead refused reached the server."]
    own = src / "how-it-works.md"  # a site that works differently from the rest says how, in its own words
    if own.exists():
        parts += ["", own.read_text().rstrip()]
    parts += ["", "The site profile is built from `policy.json` and `cache.json` (verdicts from the labeled endpoints in",
              f"`labels.jsonl`): `python3 harness/site/build_site.py {app}`."]
    return "\n".join(parts) + "\n"


def registry_text() -> str:
    """extension/src/background/sites.generated.ts, from the profiles on disk."""
    sites_dir = ROOT / "extension" / "policy" / "sites"
    profiles = sorted(p.stem for p in sites_dir.glob("*.json"))
    lines = ["// Generated by harness/site/build_site.py — do not edit. One import per extension/policy/sites/*.json.",
             "import type { SiteProfile } from '../shared/types';"]
    for ident in profiles:
        lines.append(f"import {ident.replace('-', '_')} from '../../policy/sites/{ident}.json';")
    lines.append("export const BUILTIN_SITES: SiteProfile[] = [" + ", ".join(i.replace('-', '_') for i in profiles) + "] as SiteProfile[];")
    return "\n".join(lines) + "\n"


# ---- docs/SITES.md: every tested site's lists, from apps/*/coverage.json, in the README's order
SITES_DOC_ORDER = ["gmail", "calendar", "linear", "linkedin", "facebook", "x", "telegram", "whatsapp"]
SITES_DOC_HEAD = """# Tested sites: what was tested

Each tested site ships with a profile: the reads below work with OnlyRead on, and the writes below are
refused. The lists come from each site's `apps/<site>/coverage.json`. This file and `apps/<site>/README.md`
are written from it by `harness/site/build_site.py`.

A site's profile counts as tested (its `verified` flag, which nothing in the UI shows: every guarded site is guarded the same way) only when every tested read works with no false blocks, every tested write is
refused, and the refused change is confirmed absent from the server afterwards, not just from the page.
"(implicit)" marks writes the app makes on its own, such as marking a message read when it is opened.

Any other site can be added from the settings page or with **Guard this site** in the popup. It is then
guarded by the rules and the judge alone, without a decoder or reviewed verdicts, so expect some reads to
be refused until they are labeled.
"""


def sites_doc() -> str:
    apps_dir = ROOT / "apps"
    ids = [a for a in SITES_DOC_ORDER if (apps_dir / a / "coverage.json").exists()]
    ids += sorted(d.name for d in apps_dir.iterdir() if d.is_dir() and d.name not in ids and (d / "coverage.json").exists())
    parts = [SITES_DOC_HEAD.rstrip()]
    for a in ids:
        meta = json.loads((apps_dir / a / "site.json").read_text()) if (apps_dir / a / "site.json").exists() else {}
        cov = json.loads((apps_dir / a / "coverage.json").read_text())
        if not (cov.get("passes") or cov.get("refused")):
            continue  # a profile with no tested run yet (Reddit) has nothing to list
        parts += ["", f"## {meta.get('name', a.title())}"]
        for key, title in (("passes", "Reads that work"), ("refused", "Writes refused"), ("untested", "Not yet tested"), ("outOfScope", "Out of scope")):
            if cov.get(key):
                parts += ["", f"### {title}", "", bullets(cov[key])]
    return "\n".join(parts) + "\n"


def discover_sites() -> list[str]:
    """Every site with an apps/<site>/site.json and a coverage.json, in docs order then sorted."""
    apps_dir = ROOT / "apps"
    ids = [a for a in SITES_DOC_ORDER if (apps_dir / a / "site.json").exists() and (apps_dir / a / "coverage.json").exists()]
    ids += sorted(d.name for d in apps_dir.iterdir() if d.is_dir() and d.name not in ids
                  and (d / "site.json").exists() and (d / "coverage.json").exists())
    return ids


def build(app, name_arg=None):
    src, site_meta, pol, cache, coverage = load_inputs(app)
    name = name_arg or site_meta.get("name", app.title())
    profile = build_profile(app, name, site_meta, pol, cache, coverage)
    out = ROOT / "extension" / "policy" / "sites" / f"{app}.json"
    out.write_text(json.dumps(profile, indent=1) + "\n")
    print(f"{out.relative_to(ROOT)}: {len(profile['domains'])} domains, {len(profile['cache'])} cache entries")

    (src / "README.md").write_text(readme(app, name, profile, src, site_meta, coverage))

    # ---- registry: every profile in extension/policy/sites becomes a built-in (no manual import list)
    gen = ROOT / "extension" / "src" / "background" / "sites.generated.ts"
    gen.write_text(registry_text())
    profiles = sorted(p.stem for p in (ROOT / "extension" / "policy" / "sites").glob("*.json"))
    print(f"{gen.relative_to(ROOT)}: {', '.join(profiles)}")

    # Every site's reviewed query schema (apps/*/query-schema.json) goes into the extension with the profiles.
    import subprocess
    subprocess.run([sys.executable, str(ROOT / "harness" / "site" / "query_schema.py"), "build"], check=True)

    (ROOT / "docs" / "SITES.md").write_text(sites_doc())
    print("docs/SITES.md: " + ", ".join(a for a in SITES_DOC_ORDER))


def check(sites) -> int:
    """Compare the generated outputs with the files on disk, writing nothing.

    Returns 0 when everything matches, 1 otherwise, printing the files that differ.
    The query-schema merge (harness/site/query_schema.py build) is not checked: it writes
    its own generated file and has no check mode."""
    differs = []
    for app in sites:
        src, site_meta, pol, cache, coverage = load_inputs(app)
        name = site_meta.get("name", app.title())
        profile = build_profile(app, name, site_meta, pol, cache, coverage)
        outputs = {
            ROOT / "extension" / "policy" / "sites" / f"{app}.json": json.dumps(profile, indent=1) + "\n",
            src / "README.md": readme(app, name, profile, src, site_meta, coverage),
        }
        for path, text in outputs.items():
            if not path.exists() or path.read_text() != text:
                differs.append(str(path.relative_to(ROOT)))
    shared = {
        ROOT / "extension" / "src" / "background" / "sites.generated.ts": registry_text(),
        ROOT / "docs" / "SITES.md": sites_doc(),
    }
    for path, text in shared.items():
        if not path.exists() or path.read_text() != text:
            differs.append(str(path.relative_to(ROOT)))
    if differs:
        for rel in differs:
            print(f"out of date: {rel}")
        return 1
    print(f"check passed: generated site files are up to date ({len(sites)} site{'s' if len(sites) != 1 else ''})")
    return 0


def main(argv) -> int:
    check_mode = "--check" in argv
    args = [a for a in argv if a != "--check"]
    if check_mode:
        sites = [args[0]] if args else discover_sites()
        return check(sites)
    if not args:
        print("usage: build_site.py [--check] <site> [name]", file=sys.stderr)
        return 2
    build(args[0], args[1] if len(args) > 1 else None)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
