"""ARIA-HIGH-270 / ADR-0023 — an MCP write is admitted only on a verified operator signature.

Pre-fix ``AriaMcpServer._write_gate`` accepted any ``operator_approval_ref``
of six characters or more and recorded it on governance as the operator's
approval: a runtime signal or a HUMAN_REQUIRED resolution needed no operator
act at all. These pins cover the replacement: the call carries an
``operator_approval`` signed (throwaway key, temp dir) in the
``aria-operator-request`` namespace over the tool, the digest of the call's
exact arguments, the audience, the actor class and a bounded expiry, and the
gate verifies it against the allowed-signers anchor committed on main.

ARIA-MEDIUM-283 — an approval is one operator act and admits one write. The
signed subject carries a fresh ``approval_id``; the gate spends it on the
governance ledger under that ledger's lock, so a second use is refused from
this process or any other, and a fresh approval admits the same write again.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import operator_request_signature as ors
from aria_kernel.mcp_server import (
    APPROVAL_ARGUMENT,
    APPROVAL_FIELDS,
    MCP_WRITE_TOOL_EVENT,
    AriaMcpServer,
    mcp_write_subject,
    sign_mcp_write_approval,
)
from aria_kernel.operator_request_terms import utc_iso
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import AUDIENCE, OperatorRequestFixture, mint_ed25519_key

_KERNEL_ROOT = Path(__file__).resolve().parents[1]
_SIGNAL = {"source": "operator", "service": "hr-service", "summary": "leave drift", "code_refs": ["a.py"]}


def _clean_env() -> mock._patch:
    env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
    return mock.patch.dict(os.environ, env, clear=True)


class McpWriteGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-mcp-gate-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")
        self.server = AriaMcpServer(base_dir=self.fx.tools, workspace_root=self.fx.repo, allow_writes=True)

    def _approve(self, tool: str = "runtime_signal_ingest", arguments: dict | None = None, **kwargs) -> dict:
        options = {"signing_key": self.fx.key, "signer_principal": self.fx.principal, "actor_class": "T0",
                   "expires_in_hours": 1, "workspace_root": self.fx.repo, "base_dir": self.fx.tools,
                   "subject_stream": io.StringIO()}
        options.update(kwargs)
        return sign_mcp_write_approval(tool, dict(_SIGNAL if arguments is None else arguments), **options)

    def _hand_signed(self, *, namespace: str = ors.SIGNATURE_NAMESPACE, key: Path | None = None,
                     principal: str | None = None, **terms) -> dict:
        """An approval signed past ``sign_mcp_write_approval`` — what a forger could assemble."""
        now = datetime.now(timezone.utc).replace(microsecond=0)
        approval = {"actor_class": "T0", "audience": AUDIENCE, "expires_at": utc_iso(now + timedelta(hours=1)),
                    "approval_id": "MCPA-" + secrets.token_hex(16)}
        approval.update(terms)
        approval = {name: value for name, value in approval.items() if value is not None}
        signed = ors.sign_operator_subject(
            mcp_write_subject("runtime_signal_ingest", _SIGNAL, approval), namespace=namespace,
            domain_tag=ors.REQUEST_DOMAIN_TAG, signing_key=key or self.fx.key,
            signer_principal=principal or self.fx.principal,
        )
        return {field: signed[field] for field in APPROVAL_FIELDS if field in signed}

    def _call(self, approval, arguments: dict | None = None, tool: str = "runtime_signal_ingest") -> dict:
        args = dict(_SIGNAL if arguments is None else arguments)
        if approval is not None:
            args[APPROVAL_ARGUMENT] = approval
        return self.server.call_tool(tool, args)

    def _assert_refused(self, result: dict, reason: str) -> None:
        self.assertTrue(result["isError"], result)
        self.assertIn(reason, result["content"][0]["text"])
        governance = self.fx.tools / "governance.jsonl"
        self.assertFalse(governance.exists() and MCP_WRITE_TOOL_EVENT in governance.read_text(encoding="utf-8"),
                         "a refused write is never recorded as an approved one")

    def test_an_unsigned_write_is_refused(self) -> None:
        self._assert_refused(self._call(None), APPROVAL_ARGUMENT)
        # The pre-fix shape: a free-text reference of any length is no operator act.
        self._assert_refused(self.server.call_tool("runtime_signal_ingest", {**_SIGNAL, "operator_approval_ref": "approve-123"}),
                             APPROVAL_ARGUMENT)
        self._assert_refused(self._call("approve-123"), APPROVAL_ARGUMENT)
        unsigned = {k: v for k, v in self._approve().items() if k != "signature"}
        self._assert_refused(self._call(unsigned), ors.SIGNATURE_MISSING)

    def test_a_signature_in_another_namespace_is_refused(self) -> None:
        # The fixture key is enrolled for the label namespace too, and the
        # bytes are the request subject's: only the -n namespace differs.
        self.assertIn(ors.LABEL_NAMESPACE, ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)[0].content.decode())
        self._assert_refused(self._call(self._hand_signed(namespace=ors.LABEL_NAMESPACE)), ors.SIGNATURE_INVALID)
        self.assertFalse(self._call(self._hand_signed())["isError"], "the same act in its own namespace verifies")

    def test_an_expired_or_unbounded_approval_is_refused(self) -> None:
        past = utc_iso(datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1))
        self._assert_refused(self._call(self._hand_signed(expires_at=past)), ors.SUBJECT_EXPIRED)
        beyond = utc_iso(datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=169))
        self._assert_refused(self._call(self._hand_signed(expires_at=beyond)), ors.SUBJECT_EXPIRY_INVALID)
        approval = self._approve()
        with mock.patch("aria_kernel.mcp_server.datetime") as clock:
            clock.now.return_value = datetime.now(timezone.utc) + timedelta(hours=2)
            self._assert_refused(self._call(approval), ors.SUBJECT_EXPIRED)
        with self.assertRaisesRegex(GovernanceError, ors.SUBJECT_EXPIRY_INVALID):
            self._approve(expires_in_hours=169)

    def test_a_valid_signature_admits_exactly_the_signed_write(self) -> None:
        approval = self._approve()
        result = self._call(approval)
        self.assertFalse(result["isError"], result)
        rows = [json.loads(line) for line in (self.fx.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()]
        used = [row for row in rows if row.get("kind") == MCP_WRITE_TOOL_EVENT]
        self.assertEqual(len(used), 1)
        recorded = used[0]["details"]["operator_approval"]
        self.assertEqual((recorded["signer_principal"], recorded["actor_class"]), (self.fx.principal, "T0"))
        self.assertRegex(recorded["subject_digest"], r"^sha256:[0-9a-f]{64}$")
        self.assertNotIn(APPROVAL_ARGUMENT, used[0]["details"]["args"])
        # The signature binds the tool and the exact arguments.
        self._assert_refused_after_success(self._call(approval, arguments={**_SIGNAL, "summary": "something else"}))
        self._assert_refused_after_success(self._call(approval, arguments={"request_id": "HR-1", "resolution_note": "n"},
                                                      tool="human_required_resolve"))

    def _assert_refused_after_success(self, result: dict) -> None:
        self.assertTrue(result["isError"], result)
        self.assertIn(ors.SIGNATURE_INVALID, result["content"][0]["text"])

    def test_who_signs_is_judged_by_the_committed_anchor(self) -> None:
        intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")
        self._assert_refused(self._call(self._hand_signed(key=intruder, principal="intruder@aria.test")),
                             ors.SIGNER_NOT_ENROLLED)
        self._assert_refused(self._call(self._hand_signed(key=intruder)), ors.SIGNATURE_INVALID)
        self._assert_refused(self._call(self._hand_signed(actor_class="T2")), ors.ACTOR_CLASS_REFUSED)
        self._assert_refused(self._call(self._hand_signed(audience="someone/else")), ors.SUBJECT_AUDIENCE_MISMATCH)
        # A checkout moved off main is no anchor, so nothing it enrols admits a write.
        self.fx.commit_files({"notes.md": "x\n"}, message="chore(test): off main", on_main=False)
        self._assert_refused(self._call(self._hand_signed()), "mcp_write_anchor_unavailable")

    def _used(self) -> list[dict]:
        governance = self.fx.tools / "governance.jsonl"
        rows = [json.loads(line) for line in governance.read_text(encoding="utf-8").splitlines()] if governance.exists() else []
        return [row for row in rows if row.get("kind") == MCP_WRITE_TOOL_EVENT]

    def test_an_approval_admits_its_write_once(self) -> None:
        approval = self._approve()
        self.assertRegex(approval["approval_id"], r"^MCPA-[0-9a-f]{32}$")
        self.assertFalse(self._call(approval)["isError"])
        replay = self._call(approval)
        self.assertTrue(replay["isError"], replay)
        self.assertIn("mcp_write_approval_consumed", replay["content"][0]["text"])
        used = self._used()
        self.assertEqual(len(used), 1, "the replay is never recorded as a second approved write")
        self.assertEqual(used[0]["details"]["operator_approval"]["approval_id"], approval["approval_id"])
        # A second operator act admits the same write again: one act, one write.
        self.assertFalse(self._call(self._approve())["isError"])
        self.assertEqual(len(self._used()), 2)

    def test_an_approval_without_its_signed_id_is_refused(self) -> None:
        self._assert_refused(self._call(self._hand_signed(approval_id=None)), "mcp_write_approval_id_invalid")
        self._assert_refused(self._call(self._hand_signed(approval_id="MCPA-reused")), "mcp_write_approval_id_invalid")
        # The id is signed: swapping it on a valid approval breaks the signature.
        approval = dict(self._approve(), approval_id="MCPA-" + "0" * 32)
        self._assert_refused(self._call(approval), ors.SIGNATURE_INVALID)

    def _race(self, approval: dict, processes: int) -> list[dict]:
        """``processes`` separate interpreters present ``approval`` at the same instant."""
        genesis = json.loads((self.fx.repo / ors.ENROLMENTS_PATH).read_text(encoding="utf-8").splitlines()[0])["child"]
        script = (
            "import json, sys, time\n"
            "from tests._helpers import operator_requests as fixture\n"
            "fixture._FIXTURE_GENESES.append(json.loads(sys.argv[1]))\n"
            "from aria_kernel.mcp_server import AriaMcpServer\n"
            "server = AriaMcpServer(base_dir=sys.argv[2], workspace_root=sys.argv[3], allow_writes=True)\n"
            "start = float(sys.argv[5])\n"
            "while time.time() < start:\n"
            "    time.sleep(0.005)\n"
            "print(json.dumps(server.call_tool('runtime_signal_ingest', json.loads(sys.argv[4]))))\n"
        )
        env = {**os.environ, "PYTHONPATH": str(_KERNEL_ROOT), "PYTHONDONTWRITEBYTECODE": "1"}
        start = str(time.time() + 3.0)
        argv = [sys.executable, "-c", script, json.dumps(genesis), str(self.fx.tools), str(self.fx.repo),
                json.dumps({**_SIGNAL, APPROVAL_ARGUMENT: approval}), start]
        children = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
                    for _ in range(processes)]
        results = []
        for child in children:
            out, err = child.communicate(timeout=120)
            self.assertEqual(child.returncode, 0, err)
            results.append(json.loads(out.strip().splitlines()[-1]))
        return results

    def test_one_approval_admits_one_write_across_processes(self) -> None:
        results = self._race(self._approve(), processes=3)
        admitted = [r for r in results if not r["isError"]]
        refused = [r["content"][0]["text"] for r in results if r["isError"]]
        self.assertEqual(len(admitted), 1, results)
        self.assertEqual(len(refused), 2, results)
        for text in refused:
            self.assertIn("mcp_write_approval_consumed", text)
        self.assertEqual(len(self._used()), 1)
        # Spent in this process, refused in another.
        approval = self._approve()
        self.assertFalse(self._call(approval)["isError"])
        (late,) = self._race(approval, processes=1)
        self.assertTrue(late["isError"], late)
        self.assertIn("mcp_write_approval_consumed", late["content"][0]["text"])

    def test_the_cli_signs_an_approval_the_server_admits(self) -> None:
        from aria_kernel.cli import main as cli_main

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(["mcp", "approve", "--tool", "runtime_signal_ingest", "--arguments", json.dumps(_SIGNAL),
                             "--signing-key", str(self.fx.key), "--signer-principal", self.fx.principal,
                             "--actor-class", "T1", "--workspace-root", str(self.fx.repo),
                             "--tools-dir", str(self.fx.tools)])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn('"row_kind":"mcp_write"', err.getvalue(), "the signed subject is shown before signing")
        self.assertFalse(self._call(json.loads(out.getvalue()))["isError"])


if __name__ == "__main__":
    unittest.main()
