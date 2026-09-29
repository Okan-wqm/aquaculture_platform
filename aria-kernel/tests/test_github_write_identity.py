"""ARIA-CRITICAL-246 — the kernel writes to GitHub only on an installation token.

An operator approval is a GitHub act by an account in operators.json
(``operator_approval.verify_operator_approval``). The lanes exported the
operator's PAT as ``GH_TOKEN``, and the operator's terminal holds the operator's
``gh`` login, so a kernel write could be authored as the operator, including a
comment that carries an ``ARIA-APPROVE`` line. The process tests run the
kernel's own ``notify send`` as a child process against a fake ``gh`` on
``PATH`` that logs every call it receives.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from aria_kernel import github_writes as gw

_KERNEL_ROOT = Path(__file__).resolve().parents[1]
_APPROVAL_BODY = "cycle note\nARIA-APPROVE surface=runtime_profile profile=strict ceiling=strict"

# Answers `issue list` with no match and `issue create` with a URL, and logs
# every argv. It has no stored login: which credential a write runs on is
# decided before it is called.
_FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "token": os.environ.get("GH_TOKEN")}) + "\\n")
if sys.argv[1:3] == ["issue", "list"]:
    print("[]")
elif sys.argv[1:3] == ["issue", "create"]:
    print("https://github.com/o/r/issues/7")
"""


class CredentialClass(unittest.TestCase):
    def test_every_token_class_is_named_by_its_prefix(self) -> None:
        cases = {
            "ghs_abc": "installation",
            "ghp_abc": "personal_access_token",
            "github_pat_abc": "fine_grained_personal_access_token",
            "gho_abc": "oauth_user_token",
            "ghu_abc": "user_to_server_token",
            "0123456789abcdef0123456789abcdef01234567": "unrecognised",
        }
        for token, expected in cases.items():
            self.assertEqual(gw.credential_class({"GH_TOKEN": token}), expected, token)

    def test_gh_token_wins_over_github_token_as_gh_reads_them(self) -> None:
        self.assertEqual(gw.credential_class({"GH_TOKEN": "ghp_a", "GITHUB_TOKEN": "ghs_b"}), "personal_access_token")
        self.assertEqual(gw.credential_class({"GITHUB_TOKEN": "ghs_b"}), "installation")

    def test_no_token_is_absent_because_gh_would_use_its_stored_login(self) -> None:
        self.assertEqual(gw.credential_class({}), "absent")
        self.assertEqual(gw.credential_class({"GH_TOKEN": "  "}), "absent")


class RunGhWrite(unittest.TestCase):
    def test_a_user_credential_is_refused_before_gh_runs(self) -> None:
        runner = mock.Mock()
        for token, name in (("ghp_x", "personal_access_token"), ("github_pat_x", "fine_grained_personal_access_token")):
            with self.assertRaises(gw.GitHubWriteRefused) as caught:
                gw.run_gh_write(["issue", "comment", "1", "--body", _APPROVAL_BODY], env={"GH_TOKEN": token}, runner=runner)
            self.assertEqual(str(caught.exception), f"github_write_requires_installation_token:{name}")
        with self.assertRaises(gw.GitHubWriteRefused):
            gw.run_gh_write(["issue", "comment", "1"], env={}, runner=runner)
        runner.assert_not_called()

    def test_an_installation_token_runs_gh_with_the_environment_it_was_checked_in(self) -> None:
        runner = mock.Mock(return_value=subprocess.CompletedProcess(["gh"], 0, "", ""))
        gw.run_gh_write(["pr", "merge", "5"], env={"GH_TOKEN": "ghs_x"}, cwd="/w", timeout=9, runner=runner)
        argv, kwargs = runner.call_args.args[0], runner.call_args.kwargs
        self.assertEqual(argv, ["gh", "pr", "merge", "5"])
        self.assertEqual((kwargs["env"], kwargs["cwd"], kwargs["timeout"]), ({"GH_TOKEN": "ghs_x"}, "/w", 9))

    def test_no_env_means_this_process_environment(self) -> None:
        runner = mock.Mock(return_value=subprocess.CompletedProcess(["gh"], 0, "", ""))
        with mock.patch.dict(os.environ, {"GH_TOKEN": "ghp_operator"}):
            with self.assertRaises(gw.GitHubWriteRefused):
                gw.run_gh_write(["workflow", "run", "x.yml"], runner=runner)
        runner.assert_not_called()


class TheKernelNeverPostsAsTheOperator(unittest.TestCase):
    """`notify send` on the github_issue channel, as a real process."""

    def _send(self, token: str | None) -> tuple[subprocess.CompletedProcess[str], list[dict]]:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            gh = bin_dir / "gh"
            gh.write_text(_FAKE_GH, encoding="utf-8")
            gh.chmod(0o755)
            log = root / "gh.log"
            env = {k: v for k, v in os.environ.items() if k not in {"GH_TOKEN", "GITHUB_TOKEN"}}
            env.update({
                "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "PYTHONPATH": str(_KERNEL_ROOT),
                "FAKE_GH_LOG": str(log),
                "ARIA_NOTIFY_GITHUB_REPO": "o/r",
            })
            if token is not None:
                env["GH_TOKEN"] = token
            completed = subprocess.run(
                [sys.executable, "-m", "aria_kernel", "notify", "send", "--kind", "test", "--title", "cycle note",
                 "--body", _APPROVAL_BODY, "--channel", "github_issue", "--tools-dir", str(root / "tools")],
                capture_output=True, text=True, env=env, timeout=120, check=False,
            )
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
        return completed, calls

    @staticmethod
    def _writes(calls: list[dict]) -> list[list[str]]:
        return [c["argv"] for c in calls if c["argv"][:2] in (["issue", "comment"], ["issue", "create"])]

    def test_the_operators_pat_posts_nothing_and_the_row_names_why(self) -> None:
        for token, name in (("ghp_operator", "personal_access_token"),
                            ("github_pat_operator", "fine_grained_personal_access_token"),
                            (None, "absent")):
            completed, calls = self._send(token)
            self.assertEqual(self._writes(calls), [], f"{name}: nothing is posted")
            self.assertEqual(completed.returncode, 1, completed.stderr)
            row = json.loads(completed.stdout)[0]
            self.assertEqual(row["status"], "failed")
            self.assertEqual(row["detail"]["error"], f"github_write_requires_installation_token:{name}")

    def test_an_installation_token_posts_the_notice(self) -> None:
        completed, calls = self._send("ghs_installation")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        writes = [c for c in calls if c["argv"][:2] == ["issue", "create"]]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]["token"], "ghs_installation")


if __name__ == "__main__":
    unittest.main()
