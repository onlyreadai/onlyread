#!/usr/bin/env python3
"""Build the release: the zip for the Chrome Web Store, and the same files for someone to load unpacked.

    python3 harness/bundle.py            # build and verify the release zips
    npm run release                      # all checks first, then this with --strict
    python3 harness/bundle.py --service-url https://<host>   # a test release locked to another Pro service

Builds the extension in distribution mode (ONLYREAD_DIST=1: no dev sink, no control channel and none of
its handlers, minified, no source maps), stages only the files Chrome needs at runtime, verifies the
staged release (below), and writes bundles/onlyread-<version>-webstore.zip (manifest at the zip root) and
bundles/onlyread-<version>.zip (everything under an `onlyread/` folder). Then it rebuilds in dev mode so
the loaded working copy keeps its dev sink.

With --service-url URL it makes a test release instead: the same release build, locked to that Pro service rather than
pro.onlyread.ai, under its own name and with a badge on its toolbar icon, so it is never taken for the store copy. It
writes only bundles/onlyread-<version>-dev.zip (no Web Store zip) and is refused with --strict, so `npm run release`
never makes one.

Verification, any failure stops the release:
  - no development code or address in the bundle (control channel, dev handlers, localhost sink, maps);
  - LICENSE, NOTICE and THIRD_PARTY_NOTICES.txt are staged;
  - manifest version equals package.json's; no `key` (the working copy's is dropped when staging); every file the manifest and pages load is present;
  - the manifest's permissions are exactly the ones a permission table justifies: a Markdown file whose table names
    each permission in backticks in its first column, named by ONLYREAD_STORE_LISTING (environment or .env); the
    check is skipped with a note when nothing is named or the file is missing;
  - a store release is built with no service of its own, is named OnlyRead, points at pro.onlyread.ai and lets only
    pro.onlyread.ai frame its settings page; a test release carries its own name and its service URL, and lets only that
    service frame it;
  - with --strict: the git tree is clean, so the zip matches a commit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import os
import pathlib
import shutil
import subprocess
import sys
import urllib.parse
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
# Files Chrome loads at runtime. Source, policy JSON and test vectors are compile-time only (bundled
# into dist/*.js by esbuild), so they are deliberately left out.
RUNTIME = ["manifest.json", "popup.html", "options.html", "setup.html", "ui.css", "welcome.css", "layout.css"]
# OnlyRead's license, its NOTICE (copyright, and the brand files the AGPL does not cover) and the licenses of the npm
# packages bundled into its scripts (written by scripts/build.mjs) go with every copy of the release.
LEGAL = {"LICENSE": ROOT / "LICENSE", "NOTICE": ROOT / "NOTICE", "THIRD_PARTY_NOTICES.txt": EXT / "dist" / "THIRD_PARTY_NOTICES.txt"}
DIST_JS = ["background.js", "popup.js", "options.js", "setup.js", "content.js", "whatsapp-socket.js", "telegram-worker.js"]
# The store release's Pro service (extension/policy/default.json).
STORE_SERVICE_URL = "https://pro.onlyread.ai"
STORE_NAME, DEV_NAME = "OnlyRead", "OnlyRead (dev)"
# What scripts/build.mjs built with ({dist, serviceUrl}): checked against what was asked for, never staged.
BUILD_INFO = EXT / "dist" / "build-info.json"
# The test release's toolbar badge (audit.ts clearBadge): a store build drops that code entirely.
DEV_BADGE = 'text:"DEV"'


def build_env(dist: bool, service_url: str | None = None) -> dict[str, str]:
    """The build's environment. ONLYREAD_DIST and ONLYREAD_SERVICE_URL come only from here: either left in the shell
    must not turn a store release, or the restored dev build, into something else (the restored dev build is the plain
    one, which keeps the service a browser already uses)."""
    env = {k: v for k, v in os.environ.items() if k not in ("ONLYREAD_DIST", "ONLYREAD_SERVICE_URL")}
    if dist: env["ONLYREAD_DIST"] = "1"
    if service_url: env["ONLYREAD_SERVICE_URL"] = service_url
    return env


def run_build(dist: bool, service_url: str | None = None) -> None:
    subprocess.run(["npm", "run", "-s", "build"], cwd=ROOT, env=build_env(dist, service_url), check=True)


def check_service_url(service_url: str) -> None:
    """A test release's service address, refused up front with scripts/build.mjs's own message (it prints the reason)."""
    r = subprocess.run(["node", "scripts/build.mjs", "--validate-only"], cwd=ROOT, env=build_env(True, service_url))
    if r.returncode != 0:
        fail(f"--service-url {service_url!r} refused")
    # Valid by now, so it parses. The dev sink's address is a marker no release may carry (DEV_MARKERS).
    u = urllib.parse.urlsplit(service_url)
    if u.hostname == "localhost" and u.port == 4173:
        fail("4173 is the fixture server and dev sink's port, which no release may name; use another port")


# Strings only development code carries. Each must be absent from every shipped script.
DEV_MARKERS = {
    "__control": "the localhost control channel (control.ts)",
    "secrets:get": "the dev control handlers (dev-control.ts)",
    "debug:typed-secrets": "the dev control handlers (dev-control.ts)",
    "localhost:4173": "the dev sink address",
    "127.0.0.1:4179": "the dev reload signal (dev-reload.ts)",
    "dev:reload-pages": "the dev page reload (dev-reload.ts)",
    "sourceMappingURL": "a source map reference",
    "__ONLYREAD_DIST__": "an unresolved build flag",
    "__ONLYREAD_SERVICE_URL__": "an unresolved build flag",
    "__onlyread": "the e2e status hook",
}


def fail(msg: str) -> None:
    raise SystemExit(f"release check failed: {msg}")


def listing_path() -> pathlib.Path | None:
    """The permission table's file, named by ONLYREAD_STORE_LISTING in the environment or .env (relative to the repo
    root), or None when nothing is named."""
    raw = os.environ.get("ONLYREAD_STORE_LISTING", "")
    env = ROOT / ".env"
    if not raw and env.is_file():
        for line in env.read_text().split("\n"):
            if line.startswith("ONLYREAD_STORE_LISTING="):
                raw = line.split("=", 1)[1].strip()
    return (ROOT / pathlib.Path(raw).expanduser()).resolve() if raw else None


def justified_permissions() -> set[str] | None:
    """Permissions named in the permission table (first column, backticked), or None when no file is named or it is
    missing."""
    listing = listing_path()
    if listing is None or not listing.is_file():
        return None
    return set(re.findall(r"^\| `([A-Za-z]+)` \|", listing.read_text(), re.M))


def frame_matches(service_url: str | None) -> list[str]:
    """The pages a release's settings page may be framed by: its own Pro service's. A match pattern without a port
    matches every port."""
    if not service_url:
        return [f"{STORE_SERVICE_URL}/*"]
    u = urllib.parse.urlsplit(service_url)
    return [f"{u.scheme}://{u.hostname}/*"]


def release_manifest(man: dict, service_url: str | None) -> dict:
    """The staged manifest as a release ships it: no declarativeNetRequestFeedback, the settings page frameable only
    from the release's Pro service, and for a test release its own name."""
    out = json.loads(json.dumps(man))
    # declarativeNetRequestFeedback only feeds the dev-only onRuleMatchedDebug logger.
    out["permissions"] = [p for p in out["permissions"] if p != "declarativeNetRequestFeedback"]
    # The account page frames the settings page only from the release's Pro origin: the local mock's and any other
    # origins are for development builds (a release's service address is the one it was built with, policy.ts
    # normalizePolicy).
    if service_url:
        out["name"] = out["action"]["default_title"] = DEV_NAME
    for war in out.get("web_accessible_resources", []):
        war["matches"] = frame_matches(service_url)
    return out


def check_service(stage: pathlib.Path, service_url: str | None, build_info: dict) -> None:
    """A store release is built with no service override, named OnlyRead, locked to pro.onlyread.ai and frameable only
    from it, with no test release's badge; a test release is built with its service, carries its own name and is
    frameable only from its service."""
    if build_info != {"dist": True, "serviceUrl": service_url or ""}:
        fail(f"the build was made with {build_info}, not a release for {service_url or 'the store'}")
    man = json.loads((stage / "manifest.json").read_text())
    bg = (stage / "dist" / "background.js").read_text()
    name = DEV_NAME if service_url else STORE_NAME
    if man["name"] != name or man["action"]["default_title"] != name:
        fail(f"manifest name {man['name']!r} / title {man['action']['default_title']!r}, expected {name!r}")
    if f'"{service_url or STORE_SERVICE_URL}"' not in bg:
        fail(f"background.js does not carry its Pro service {service_url or STORE_SERVICE_URL}")
    # The settings page is frameable from the release's own service only: a development build's other origins (any
    # https site, the local mock) never reach a release.
    wars = man.get("web_accessible_resources", [])
    if not wars or any(war["matches"] != frame_matches(service_url) for war in wars):
        fail(f"web_accessible_resources matches {[w['matches'] for w in wars]}, expected only {frame_matches(service_url)}")
    if not service_url and DEV_BADGE in bg:
        fail(f"background.js carries the test release's badge ({DEV_BADGE})")


def check_dist(stage: pathlib.Path) -> None:
    """dist/ ships only the scripts the extension loads: not build-info.json, notices or anything else the build left."""
    extra = sorted({f.name for f in (stage / "dist").iterdir()} - set(DIST_JS))
    if extra:
        fail(f"dist/ holds files the extension does not load: {extra}")


def verify(stage: pathlib.Path, service_url: str | None = None) -> None:
    for js in (stage / "dist").glob("*.js"):
        code = js.read_text()
        for marker, what in DEV_MARKERS.items():
            if marker in code:
                fail(f"{js.name} contains {what} ({marker!r})")
    for name in LEGAL:
        if not (stage / name).is_file() or not (stage / name).read_text().strip():
            fail(f"{name} is not staged")
    man = json.loads((stage / "manifest.json").read_text())
    pkg = json.loads((ROOT / "package.json").read_text())
    if man["version"] != pkg["version"]:
        fail(f"manifest version {man['version']} != package.json {pkg['version']}")
    if "key" in man:
        fail("manifest carries a `key` (dev-only fixed id)")
    loaded = [man["background"]["service_worker"], man["action"]["default_popup"], man["options_page"],
              *man["action"]["default_icon"].values(), *man["icons"].values(),
              *(js for cs in man["content_scripts"] for js in cs["js"])]
    for page in stage.glob("*.html"):
        loaded += re.findall(r'<script[^>]*src="([^"]+)"', page.read_text())
        loaded += re.findall(r'<link[^>]*href="(?!https?:)([^"]+)"', page.read_text())
    for f in loaded:
        if not (stage / f).is_file():
            fail(f"{f} is loaded but not in the release")
    declared, justified = set(man["permissions"]), justified_permissions()
    if justified is None:
        print("note: no permission table named (ONLYREAD_STORE_LISTING) or the file is missing; permissions not checked against the store listing")
    elif declared != justified:
        fail(f"permissions differ from the permission table: undocumented {sorted(declared - justified)}, "
             f"documented but not requested {sorted(justified - declared)}")
    if any(f.suffix == ".map" or f.name.startswith(".") for f in stage.rglob("*")):
        fail("a source map or hidden file is staged")
    check_dist(stage)
    check_service(stage, service_url, json.loads(BUILD_INFO.read_text()))


def git_state(strict: bool) -> str:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty and strict:
        fail("uncommitted changes; a release must match a commit (commit, or drop --strict for a test build)")
    return f"{head}{' + uncommitted changes' if dirty else ''}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Build and verify the release zips.")
    ap.add_argument("--strict", action="store_true", help="refuse a dirty git tree (npm run release)")
    ap.add_argument("--service-url", help="a test release locked to this Pro service instead of https://pro.onlyread.ai")
    args = ap.parse_args()
    service_url = args.service_url
    if service_url is not None and not service_url:
        fail("--service-url is empty: name the test release's Pro service, e.g. --service-url https://<host>")
    if service_url and args.strict:
        fail("--service-url makes a test release, never a store one: it cannot go with --strict (npm run release)")
    if service_url:
        check_service_url(service_url)
    commit = git_state(args.strict)
    version = json.loads((EXT / "manifest.json").read_text())["version"]
    out_dir = ROOT / "bundles"
    out_dir.mkdir(exist_ok=True)
    folder = "onlyread-dev" if service_url else "onlyread"
    zip_path = out_dir / f"onlyread-{version}{'-dev' if service_url else ''}.zip"
    store_zip = None if service_url else out_dir / f"onlyread-{version}-webstore.zip"
    stage = ROOT / "bundles" / "_stage" / folder

    print(f"building distribution bundle (ONLYREAD_DIST=1{f', ONLYREAD_SERVICE_URL={service_url}' if service_url else ''})…")
    try:
        run_build(dist=True, service_url=service_url)
    except subprocess.CalledProcessError:
        fail("the distribution build failed (its output is above)")
    try:
        if stage.parent.exists():
            shutil.rmtree(stage.parent)
        stage.mkdir(parents=True)
        for name in RUNTIME:
            shutil.copy2(EXT / name, stage / name)
        (stage / "dist").mkdir()
        for js in DIST_JS:
            src = EXT / "dist" / js
            if not src.exists():
                raise SystemExit(f"missing built file: {src} (build failed?)")
            shutil.copy2(src, stage / "dist" / js)
        shutil.copytree(EXT / "assets", stage / "assets")
        for name, src in LEGAL.items():
            if not src.is_file():
                raise SystemExit(f"missing {src}")
            shutil.copy2(src, stage / name)
        man = json.loads((stage / "manifest.json").read_text())
        # The working copy's `key` pins dev builds to the store's ID; the store refuses an upload that carries one, and an
        # unpacked copy with it would collide with the store install, so the release goes without it.
        man.pop("key", None)
        (stage / "manifest.json").write_text(json.dumps(release_manifest(man, service_url), indent=2) + "\n")

        # The shipped default policy carries the dev sink URL; the dist build ignores it at runtime, but a
        # release must not contain a localhost endpoint at all (store review, and no accidental reporting).
        bg = (stage / "dist" / "background.js").read_text()
        for lit in ('"http://localhost:4173/__audit"', "'http://localhost:4173/__audit'"):
            bg = bg.replace(lit, "null")
        (stage / "dist" / "background.js").write_text(bg)
        verify(stage, service_url)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage.parent))
        # Chrome Web Store upload: manifest.json at the zip root. Never for a test release.
        if store_zip:
            with zipfile.ZipFile(store_zip, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(stage.rglob("*")):
                    if f.is_file():
                        z.write(f, f.relative_to(stage))
        size_kb = zip_path.stat().st_size / 1024
        files = sum(1 for _ in stage.rglob("*") if _.is_file())
    finally:
        shutil.rmtree(stage.parent, ignore_errors=True)
        print("restoring the dev build…")
        run_build(dist=False)

    print(f"\n  release checks passed · version {version} · commit {commit}")
    if service_url:
        print(f"  {zip_path.relative_to(ROOT)}  ({files} files, {size_kb:.0f} KB, to load unpacked)\n")
        print(f"A test release: \"{DEV_NAME}\", locked to the Pro service {service_url}.")
        print("Never upload it to the store. To try it:")
        print(f"  1. Unzip it (gives an `{folder}` folder).")
        print("  2. Use a separate Chrome profile, with the store copy of OnlyRead off or not installed: two copies")
        print("     guarding the same tabs get in each other's way.")
        print("  3. In that profile open chrome://extensions, turn on Developer mode, click 'Load unpacked' and pick")
        print(f"     the `{folder}` folder.")
        print(f"  4. Sign in with Continue: it signs in to {service_url}.")
        return 0
    sha = hashlib.sha256(store_zip.read_bytes()).hexdigest()[:16]
    print(f"  {store_zip.relative_to(ROOT)}  (Chrome Web Store upload, sha256 {sha}…)")
    print(f"  {zip_path.relative_to(ROOT)}  ({files} files, {size_kb:.0f} KB, to load unpacked)\n")
    print("Send that zip. Tell your friend to:")
    print("  1. Unzip it (gives an `onlyread` folder).")
    print("  2. Open chrome://extensions, turn on Developer mode (top right).")
    print("  3. Click 'Load unpacked' and pick the `onlyread` folder.")
    print("  4. A setup window opens: Continue signs in to OnlyRead Pro, the AI judge; or open")
    print("     'Your own key' and paste a provider key, then Save and test.")
    print("  5. Try the demo on one of the sites offered (or Skip demo): one change, refused.")
    print("  6. Switch on more sites from the popup or the settings page. Chrome shows a")
    print("     'started debugging this browser' banner while a site is guarded: that is how")
    print("     OnlyRead inspects requests.")
    print("  A release always enforces, and guards during agent sessions by default (settings:")
    print("  When to protect -> Always to guard all the time).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
