"""The release bundler's manifest edit and service checks (harness/bundle.py): a store release stays OnlyRead on
pro.onlyread.ai, and only --service-url makes the dev copy."""
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import bundle

MANIFEST = json.loads((bundle.EXT / "manifest.json").read_text())


def stage(tmp: str, man: dict, background: str) -> pathlib.Path:
    root = pathlib.Path(tmp)
    (root / "dist").mkdir()
    (root / "manifest.json").write_text(json.dumps(man))
    (root / "dist" / "background.js").write_text(background)
    return root


class ManifestTests(unittest.TestCase):
    def test_store_release(self):
        man = bundle.release_manifest(MANIFEST, None)
        self.assertEqual((man["name"], man["action"]["default_title"]), ("OnlyRead", "OnlyRead"))
        self.assertEqual([w["matches"] for w in man["web_accessible_resources"]], [["https://pro.onlyread.ai/*"]])
        self.assertNotIn("declarativeNetRequestFeedback", man["permissions"])
        # The working copy (a development build) lets any https page frame the settings page (framed.ts shows it only
        # inside the service it was built for); a release never does (the matches above).
        self.assertIn("https://*/*", MANIFEST["web_accessible_resources"][0]["matches"])

    def test_test_release(self):
        man = bundle.release_manifest(MANIFEST, DEV)
        self.assertEqual((man["name"], man["action"]["default_title"]), ("OnlyRead (dev)", "OnlyRead (dev)"))
        self.assertEqual([w["matches"] for w in man["web_accessible_resources"]], [[f"{DEV}/*"]])
        self.assertEqual(bundle.release_manifest(MANIFEST, "http://localhost:8080")["web_accessible_resources"][0]["matches"],
                         ["http://localhost/*"])
        self.assertEqual(MANIFEST["name"], "OnlyRead")  # the working copy's manifest is left alone


DEV = "https://foo.example"
STORE_INFO = {"dist": True, "serviceUrl": ""}
DEV_INFO = {"dist": True, "serviceUrl": DEV}


class ServiceCheckTests(unittest.TestCase):
    def check(self, man: dict, background: str, service_url: str | None, info: dict) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bundle.check_service(stage(tmp, man, background), service_url, info)

    def test_store_release_passes(self):
        self.check(bundle.release_manifest(MANIFEST, None), 'x="https://pro.onlyread.ai"', None, STORE_INFO)

    def test_store_release_refuses_the_dev_name_badge_or_a_missing_service(self):
        dev = bundle.release_manifest(MANIFEST, DEV)
        store = bundle.release_manifest(MANIFEST, None)
        for man, bg in [(dev, 'x="https://pro.onlyread.ai"'), (store, 'x="https://other.example"'),
                        (store, 'x="https://pro.onlyread.ai";b({text:"DEV"})')]:
            with self.subTest(bg=bg, name=man["name"]), self.assertRaises(SystemExit):
                self.check(man, bg, None, STORE_INFO)

    def test_a_release_refuses_frame_origins_other_than_its_own(self):
        for service_url, info in [(None, STORE_INFO), (DEV, DEV_INFO)]:
            for matches in [MANIFEST["web_accessible_resources"][0]["matches"], ["https://*/*"], ["https://pro.onlyread.ai/*", f"{DEV}/*"], []]:
                man = bundle.release_manifest(MANIFEST, service_url)
                man["web_accessible_resources"][0]["matches"] = matches
                with self.subTest(service_url=service_url, matches=matches), self.assertRaises(SystemExit) as e:
                    self.check(man, f'x="https://pro.onlyread.ai",y="{service_url}"', service_url, info)
                self.assertIn("web_accessible_resources", str(e.exception.code))
        # No frame permission at all is no release either.
        man = bundle.release_manifest(MANIFEST, None)
        del man["web_accessible_resources"]
        with self.assertRaises(SystemExit):
            self.check(man, 'x="https://pro.onlyread.ai"', None, STORE_INFO)

    def test_store_release_refuses_a_build_with_any_override(self):
        # pro.onlyread.ai is always in background.js (policy/default.json): only the build's own record shows an override.
        for info in [{**STORE_INFO, "serviceUrl": "https://other.example"}, DEV_INFO, {**STORE_INFO, "dist": False}]:
            with self.subTest(info=info), self.assertRaises(SystemExit):
                self.check(bundle.release_manifest(MANIFEST, None), 'x="https://pro.onlyread.ai"', None, info)

    def test_test_release(self):
        dev = bundle.release_manifest(MANIFEST, DEV)
        bg = f'a="https://pro.onlyread.ai",b="{DEV}";c({{text:"DEV"}})'
        self.check(dev, bg, DEV, DEV_INFO)
        for man, bg2, info in [(dev, 'a="https://pro.onlyread.ai"', DEV_INFO), (bundle.release_manifest(MANIFEST, None), bg, DEV_INFO),
                               (dev, bg, STORE_INFO), (dev, bg, {**DEV_INFO, "serviceUrl": "https://other.example"})]:
            with self.subTest(bg=bg2, info=info), self.assertRaises(SystemExit):
                self.check(man, bg2, DEV, info)

    def test_build_info_is_never_staged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = stage(tmp, MANIFEST, "")
            for js in bundle.DIST_JS: (root / "dist" / js).write_text("")
            bundle.check_dist(root)
            (root / "dist" / "build-info.json").write_text(json.dumps(STORE_INFO))
            with self.assertRaises(SystemExit) as e:
                bundle.check_dist(root)
            self.assertIn("build-info.json", str(e.exception.code))


class RunBuildTests(unittest.TestCase):
    def env(self, **kw) -> dict:
        # Both exported in the shell: neither may leak into a build that did not ask for it.
        exported = {"ONLYREAD_SERVICE_URL": "https://other.example", "ONLYREAD_DIST": "1"}
        with mock.patch.dict(os.environ, exported), mock.patch.object(bundle.subprocess, "run") as run:
            bundle.run_build(**kw)
        return run.call_args.kwargs["env"]

    def test_exported_settings_never_reach_a_store_release_or_the_restored_dev_build(self):
        self.assertNotIn("ONLYREAD_SERVICE_URL", self.env(dist=True))
        self.assertEqual(self.env(dist=True)["ONLYREAD_DIST"], "1")
        self.assertNotIn("ONLYREAD_SERVICE_URL", self.env(dist=False))
        self.assertNotIn("ONLYREAD_DIST", self.env(dist=False))

    def test_the_test_release_gets_its_own(self):
        self.assertEqual(self.env(dist=True, service_url=DEV)["ONLYREAD_SERVICE_URL"], DEV)


class ArgumentTests(unittest.TestCase):
    def refused(self, *argv: str) -> str:
        with mock.patch.object(sys, "argv", ["bundle.py", *argv]), mock.patch.object(bundle, "run_build") as build:
            with self.assertRaises(SystemExit) as e:
                bundle.main()
            build.assert_not_called()
        return str(e.exception.code)

    def test_strict_never_makes_a_test_release(self):
        self.assertIn("--strict", self.refused("--strict", "--service-url", DEV))

    def test_a_test_release_names_its_service(self):
        self.assertIn("is empty", self.refused("--service-url", ""))

    def test_the_dev_sink_port_is_refused_up_front(self):
        self.assertIn("4173", self.refused("--service-url", "http://localhost:4173"))

    def test_a_bad_address_is_refused_up_front_by_the_build_script(self):
        # Malformed ones included: scripts/build.mjs --validate-only refuses them before anything parses them here.
        for url in ["http://evil.example", "https://[::1", "https://[::1]:8443", "https://pro.onlyread.ai"]:
            with self.subTest(url=url):
                self.assertIn("refused", self.refused("--service-url", url))


if __name__ == "__main__":
    unittest.main()
