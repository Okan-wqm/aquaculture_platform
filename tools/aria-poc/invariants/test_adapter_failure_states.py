#!/usr/bin/env python3
"""Adapter failure states — a dead scanner is never a clean scan.

The 2026-09-01 audit reproduced both shapes: the banned-phrase adapter
turned child exit 127 (CLI missing) into zero observations with exit 0,
and the outbox adapter silently skipped unreadable in-scope sources while
reporting the remaining read as clean. Tool-execution failure and scan
result are now different typed states: `unavailable` / `incomplete`.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# ARIA-MEDIUM-377 — under invariants/ so CI discovers it; the adapters it
# loads are one directory up.
_POC = Path(__file__).resolve().parents[1]
_REPO = _POC.parents[1]
# The runner starts an adapter as `python3 <adapter>.py` in this directory, so
# the adapters import their sibling modules (adapter_scope) from it; loading one
# by file path needs the same directory on sys.path.
sys.path.insert(0, str(_POC))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


banned = _load("banned_phrase_adapter_under_test", _POC / "banned_phrase_adapter.py")
outbox = _load("outbox_adapter_under_test", _POC / "outbox_adapter.py")


class BannedPhraseUnavailableTests(unittest.TestCase):
    def _run_main(self) -> tuple[int, dict]:
        import contextlib
        import io

        stdin = io.StringIO("{}")
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(stdout):
            code = banned.main()
        return code, json.loads(stdout.getvalue())

    def test_exit_127_is_unavailable_not_clean(self) -> None:
        with mock.patch.object(
            banned, "_invoke_banned_phrase_cli",
            return_value=(127, "banned-phrase CLI unavailable at /x /y"),
        ), mock.patch.object(banned, "_resolve_repo_root", return_value=Path("/x")):
            code, body = self._run_main()
        self.assertNotEqual(code, 0)
        self.assertEqual(body["status"], "unavailable")
        self.assertEqual(body["observations"], [])
        self.assertEqual(body["metadata"]["exit_code"], 127)

    def test_gate_error_exit_2_is_unavailable(self) -> None:
        with mock.patch.object(
            banned, "_invoke_banned_phrase_cli",
            return_value=(2, "ts-node crashed"),
        ), mock.patch.object(banned, "_resolve_repo_root", return_value=Path("/x")):
            code, body = self._run_main()
        self.assertNotEqual(code, 0)
        self.assertEqual(body["status"], "unavailable")


class BannedPhraseTimeoutTests(unittest.TestCase):
    def test_a_gate_timeout_is_unavailable_not_a_crash(self) -> None:
        import subprocess

        root = Path(tempfile.mkdtemp(prefix="aria-banned-timeout-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        for rel in (banned.GATE_TS_NODE, banned.GATE_SCRIPT):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text("", encoding="utf-8")
        with mock.patch.object(banned.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired(cmd="ts-node", timeout=60)):
            code, text = banned._invoke_banned_phrase_cli(root, mode="tree")
        self.assertEqual(code, 124)
        self.assertIn("timed out", text)


# DET-banned (B01, B02) — the banned-phrase adapter's production default and its
# closed set of served modes. The phrases below are assembled from fragments so
# this file does not trip the gate whose adapter it tests.
FOR_NOW = " ".join(("for", "now"))
TEMP = "tempo" + "rary"

GATE_VERDICT = "\n".join((
    "Banned-phrase violations detected:",
    f'  apps/a/src/one.ts:3:10  "{FOR_NOW}"',
    f"    > // {FOR_NOW}, skip the check",
    f'  docs/two.md:7:1  "{TEMP}"',
    f"    > a {TEMP} fix until the store lands",
    "",
))


class _BannedAdapterCase(unittest.TestCase):
    """main() driven through the process boundary: only the gate spawn is faked."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-banned-modes-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        # Both files exist, so a request that was not refused reaches the spawn.
        for rel in (banned.GATE_TS_NODE, banned.GATE_SCRIPT):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_text("", encoding="utf-8")

    def run_adapter(self, stdin_text: str, gate_exit: int = 0, gate_output: str = "") -> tuple:
        verdict = subprocess.CompletedProcess(args=[], returncode=gate_exit, stdout="", stderr=gate_output)
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(stdin_text)), \
                contextlib.redirect_stdout(stdout), \
                mock.patch.object(banned, "_resolve_repo_root", return_value=self.root), \
                mock.patch.object(banned.subprocess, "run", return_value=verdict) as spawn:
            code = banned.main()
        return code, json.loads(stdout.getvalue()), spawn

    def gate_args_after_script(self, spawn: mock.Mock) -> list[str]:
        argv = spawn.call_args.args[0]
        return argv[argv.index(str(self.root / banned.GATE_SCRIPT)) + 1:]


class BannedPhraseDefaultModeTests(_BannedAdapterCase):
    """B01 — a cycle's checkout has an empty index, so the default must read the tree."""

    def test_a_request_naming_no_mode_spawns_the_gate_in_tree_mode(self) -> None:
        for stdin_text in ("", "{}", json.dumps({"cycle_id": "c-1"})):
            with self.subTest(stdin=stdin_text):
                code, body, spawn = self.run_adapter(stdin_text)
                self.assertEqual(code, 0)
                spawn.assert_called_once()
                self.assertEqual(self.gate_args_after_script(spawn), ["--mode=tree"])
                self.assertEqual(body["metadata"]["mode"], "tree")

    def test_the_cli_wrapper_defaults_to_tree_mode(self) -> None:
        verdict = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(banned.subprocess, "run", return_value=verdict) as spawn:
            banned._invoke_banned_phrase_cli(self.root)
        self.assertEqual(self.gate_args_after_script(spawn), ["--mode=tree"])

    def test_the_adapter_alone_owns_the_default_mode(self) -> None:
        # The production run is the manifest's runner with its default_input; a
        # `mode` there would be a second owner of the default.
        manifest = json.loads((_REPO / "tools/aria-adapters/banned-phrase-adapter.tool.json").read_text("utf-8"))
        self.assertNotIn("mode", manifest["default_input"])
        self.assertEqual(manifest["runner"]["argv"], ["python3", "banned_phrase_adapter.py"])
        self.assertEqual(banned.DEFAULT_MODE, "tree")

    def test_the_served_modes_are_a_closed_set_that_holds_the_default(self) -> None:
        # SERVED_MODES is the closed set B02 introduces: a new name in the adapter.
        self.assertEqual(set(banned.SERVED_MODES), {"tree", "staged"})
        self.assertIn(banned.DEFAULT_MODE, banned.SERVED_MODES)


@unittest.skipUnless((_REPO / banned.GATE_TS_NODE).exists(), "needs the repository's ts-node (npm ci)")
class BannedPhraseRealGateTests(unittest.TestCase):
    """B01 against the real gate: the default run sees committed content with a clean index."""

    EXCUSE = "apps/demo/src/excuse.ts"

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-banned-realgate-"))
        self.addCleanup(self._remove_root)
        # The real gate and its toolchain, linked rather than copied; the fixture's
        # own git repository is what the gate scans (it asks git for its root).
        (self.root / "tools").mkdir()
        (self.root / "tools" / "gates").symlink_to(_REPO / "tools" / "gates")
        (self.root / "node_modules").symlink_to(_REPO / "node_modules")
        committed = {
            self.EXCUSE: f"export const id = 1; // {FOR_NOW}, skip the tenant check\n",
            # Near misses: each carries the phrase, or its word, and must stay silent.
            "docs/reviews/note.md": f"{FOR_NOW} we accept this.\n",
            "apps/demo/src/label.ts": f'export const LABEL = "{FOR_NOW}";\n',
            "apps/demo/src/identifier.ts": f"export const {TEMP}Directory = '/var/work';\n",
            "apps/demo/src/table.ts": f"// a {TEMP} table for the batch\nexport const t = 1;\n",
        }
        for rel, text in committed.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_text(text, encoding="utf-8")
        for args in (["init", "--quiet", "--initial-branch=main"], ["add", *committed], ["commit", "--quiet", "-m", "fixture"]):
            subprocess.run(["git", *args], cwd=self.root, env=self._git_env(), check=True, capture_output=True)
        (self.root / "apps/demo/src/untracked.ts").write_text(f"// {FOR_NOW}\n", encoding="utf-8")

    def _remove_root(self) -> None:
        # Unlink the two links first: never let a recursive delete reach the shared tree.
        for link in (self.root / "tools" / "gates", self.root / "node_modules"):
            if link.is_symlink():
                link.unlink()
        shutil.rmtree(self.root, ignore_errors=True)

    def _git_env(self) -> dict[str, str]:
        # No GIT_* from a hook that is running this suite may reach the fixture.
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(HOME=str(self.root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                   GIT_AUTHOR_NAME="Aqua Test", GIT_AUTHOR_EMAIL="aqua-test@example.invalid",
                   GIT_COMMITTER_NAME="Aqua Test", GIT_COMMITTER_EMAIL="aqua-test@example.invalid")
        return env

    def test_the_default_run_reports_the_committed_excuse_and_nothing_near_it(self) -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env[banned.REPO_ROOT_ENV] = str(self.root)
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"cycle_id": "c-pin"}))), \
                contextlib.redirect_stdout(stdout):
            code = banned.main()
        body = json.loads(stdout.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual([(f["rule"], f["path"]) for f in body["findings"]], [("banned_phrase", self.EXCUSE)])
        self.assertEqual(len(body["observations"]), 1)
        self.assertEqual(body["evidence_sources"], [self.EXCUSE])
        self.assertEqual(body["read_paths"], [self.EXCUSE])
        self.assertEqual(body["metadata"]["violation_count"], 1)
        self.assertEqual(body["metadata"]["mode"], "tree")


class BannedPhraseServedModesTests(_BannedAdapterCase):
    """B02 — only `tree` and `staged` are served; every other request is refused unspawned."""

    # `range`/`file` need operands the adapter never forwards (the gate shell-
    # interpolates refs); `commit` scans only HEAD's message and would read as clean.
    UNSERVED = ("range", "file", "commit", "bogus", "", ["tree"], None,
                "tree --ignore-exemptions", "tree\n--mode=file")

    def test_an_unserved_mode_is_refused_before_the_gate_is_spawned(self) -> None:
        for mode in self.UNSERVED:
            with self.subTest(mode=mode):
                code, body, spawn = self.run_adapter(
                    json.dumps({"mode": mode}), gate_exit=2, gate_output="range mode requires two refs")
                spawn.assert_not_called()
                self.assertNotEqual(code, 0)
                self.assertEqual(body["status"], "unavailable")
                for key in ("observations", "findings", "read_paths", "evidence_sources"):
                    self.assertEqual(body[key], [], key)
                reason = body["metadata"]["reason"]
                self.assertIn("not served", reason)
                self.assertTrue(any(name in reason for name in (str(mode), repr(mode))), reason)

    def test_operands_beside_a_served_mode_are_never_forwarded_to_the_gate(self) -> None:
        operands = {"base": "--output=/x", "head": "HEAD", "path": "../../etc/passwd", "refs": ["a", "b"]}
        for given in ({}, {"mode": "tree"}, {"mode": "staged"}):
            with self.subTest(mode=given.get("mode")):
                _, _, spawn = self.run_adapter(json.dumps({**given, **operands}))
                self.assertEqual(self.gate_args_after_script(spawn), [f"--mode={given.get('mode', 'tree')}"])

    def test_operands_beside_an_unserved_mode_are_refused_not_forwarded(self) -> None:
        for mode in ("range", "file"):
            with self.subTest(mode=mode):
                payload = {"mode": mode, "base": "--output=/x", "head": "HEAD", "path": "../../etc/passwd"}
                code, body, spawn = self.run_adapter(json.dumps(payload))
                spawn.assert_not_called()
                self.assertNotEqual(code, 0)
                self.assertEqual(body["status"], "unavailable")

    def test_each_served_mode_reaches_the_gate_and_its_verdict_is_parsed(self) -> None:
        for given, served in (({}, "tree"), ({"mode": "tree"}, "tree"), ({"mode": "staged"}, "staged")):
            with self.subTest(request=given):
                code, body, spawn = self.run_adapter(json.dumps(given), gate_exit=1, gate_output=GATE_VERDICT)
                self.assertEqual(code, 0)
                self.assertEqual(self.gate_args_after_script(spawn), [f"--mode={served}"])
                self.assertEqual(body["metadata"]["mode"], served)
                self.assertEqual(len(body["observations"]), 2)
                self.assertEqual([f["rule"] for f in body["findings"]], ["banned_phrase"] * 2)
                self.assertEqual(body["evidence_sources"], ["apps/a/src/one.ts", "docs/two.md"])


class OutboxIncompleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outbox-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))

    def test_unreadable_source_marks_envelope_incomplete(self) -> None:
        good = self.root / "apps" / "x" / "src" / "svc.ts"
        good.parent.mkdir(parents=True)
        good.write_text("export const x = 1;\n", encoding="utf-8")
        bad = self.root / "apps" / "x" / "src" / "broken.ts"
        # Valid path, invalid UTF-8 payload: read_text raises
        # UnicodeDecodeError, the exact production shape of an
        # unreadable in-scope source.
        bad.write_bytes(b"\xff\xfe\x00bad\xff")

        envelope = outbox.scan(self.root, allowed_paths=["apps/x/src/svc.ts", "apps/x/src/broken.ts"])

        self.assertEqual(envelope["metadata"]["unreadable_file_count"], 1)
        self.assertIn("apps/x/src/broken.ts", envelope["metadata"]["unreadable_paths"])
        self.assertEqual(envelope["status"], "incomplete")

    def test_fully_readable_scan_has_no_status_override(self) -> None:
        good = self.root / "apps" / "x" / "src" / "svc.ts"
        good.parent.mkdir(parents=True)
        good.write_text("export const x = 1;\n", encoding="utf-8")

        envelope = outbox.scan(self.root, allowed_paths=["apps/x/src/svc.ts"])

        self.assertNotIn("status", envelope)
        self.assertEqual(envelope["metadata"]["scanned_file_count"], 1)


if __name__ == "__main__":
    unittest.main()
