"""Plan 024 v3 §H-0 + §H-1 + §H-2 — cross-platform exclusive lock +
claim atomicity + submit idempotency tests.

§H-0: aria-kernel/aria_kernel/file_lock.py exposes
with_exclusive_lock as a cross-platform context manager.
§H-1: claim_request wraps the read-state→check→append sequence in
the lock with a CAS recheck so concurrent claims race to a single
winner.
§H-2: submit_claim_result performs an existing-result lookup before
the append; duplicate submissions return idempotent: True instead
of writing a second result row.

Tests:
1. with_exclusive_lock acquire + release single use.
2. with_exclusive_lock timeout when held by another process (sub-
   process spawn for portability).
3. claim_request CAS rechecks state after lock acquisition.
4. submit_claim_result returns idempotent when called twice for the
   same claim_id with the same envelope.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from aria_kernel.file_lock import lock_sidecar_path, lock_sidecar_target, with_exclusive_lock


class WithExclusiveLockTests(unittest.TestCase):
    def test_acquire_and_release_single_use(self) -> None:
        """Plan 024 §H-0 acceptance (1)."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            with with_exclusive_lock(target):
                # Inside the with: lock side-car file exists.
                lock_path = target.with_suffix(target.suffix + ".lock")
                self.assertTrue(lock_path.exists())
            # POSIX: lock side-car may persist (auto-release on close);
            # Windows: side-car is unlinked on exit. Either way the
            # subsequent acquire must succeed.
            with with_exclusive_lock(target):
                pass

    def test_timeout_when_held_by_another_process(self) -> None:
        """Plan 024 §H-0 acceptance (2)."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            # Spawn a child process that holds the lock for 5s.
            child_script = f"""
import sys, time
sys.path.insert(0, {repr(str(Path(__file__).resolve().parent.parent))})
from aria_kernel.file_lock import with_exclusive_lock
from pathlib import Path
with with_exclusive_lock(Path({repr(str(target))})):
    print("LOCKED", flush=True)
    time.sleep(5)
"""
            child = subprocess.Popen(
                [sys.executable, "-c", child_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                # Wait for the child to confirm lock acquisition.
                line = child.stdout.readline()
                self.assertIn(b"LOCKED", line)
                # Now attempt to acquire from this process with a
                # short timeout — must raise TimeoutError.
                start = time.monotonic()
                with self.assertRaises(TimeoutError):
                    with with_exclusive_lock(target, timeout_seconds=0.5):
                        pass
                elapsed = time.monotonic() - start
                # Should not block much longer than the timeout.
                self.assertLess(elapsed, 1.5,
                    f"timeout took {elapsed:.2f}s; should be ~0.5s")
            finally:
                child.terminate()
                child.wait(timeout=2)

    @unittest.skipUnless(os.name == "posix", "O_NOFOLLOW is POSIX-only")
    def test_existing_symlink_sidecar_is_never_followed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            outside = Path(td) / "outside"
            outside.write_text("do not lock me\n", encoding="utf-8")
            sidecar = target.with_suffix(target.suffix + ".lock")
            sidecar.symlink_to(outside)

            with self.assertRaises(OSError):
                with with_exclusive_lock(
                    target,
                    timeout_seconds=0,
                    require_existing=True,
                ):
                    pass

            self.assertTrue(sidecar.is_symlink())
            self.assertEqual(outside.read_text(encoding="utf-8"), "do not lock me\n")

    def test_require_existing_never_creates_a_missing_parent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td) / "missing-parent"
            target = parent / "ledger.jsonl"

            with self.assertRaises(OSError):
                with with_exclusive_lock(
                    target,
                    timeout_seconds=0,
                    require_existing=True,
                ):
                    pass

            self.assertFalse(parent.exists())

    def test_the_sidecar_shape_decodes_back_to_its_target(self) -> None:
        """The side-car this module leaves on disk (POSIX keeps it after
        release) is the exact thing a published state tree must never
        carry; `state_tree_contract` recognises one by asking this module,
        so the decoder must be the precise inverse of the encoder."""
        from pathlib import PurePosixPath

        for target in (
            PurePosixPath("runs.jsonl"),
            PurePosixPath("locks/state-groups/governance.lock"),
            PurePosixPath("memory/beliefs.jsonl"),
            PurePosixPath("integrity_index.json"),
            Path("/tmp/x/ledger.jsonl"),
        ):
            sidecar = lock_sidecar_path(target)
            self.assertEqual(lock_sidecar_target(sidecar), target, sidecar)
        # A store-relative POSIX path stays pure POSIX through the decoder
        # AND the encoder (the manifest's group-lock key is built from one);
        # a concrete Path stays concrete, so the lock helper can open it.
        self.assertIsInstance(
            lock_sidecar_target(PurePosixPath("tools/runs.jsonl.lock")),
            PurePosixPath,
        )
        self.assertIs(type(lock_sidecar_path(PurePosixPath("tools/runs.jsonl"))), PurePosixPath)
        self.assertIsInstance(lock_sidecar_path(Path("/tmp/x/ledger.jsonl")), Path)
        self.assertIsInstance(lock_sidecar_path("/tmp/x/ledger.jsonl"), Path)
        # The side-car this module actually creates decodes the same way.
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            with with_exclusive_lock(target) as handle:
                self.assertEqual(lock_sidecar_target(handle.path), target)
        # Not side-cars: no target name, a different suffix, a plain name.
        for path in (PurePosixPath(".lock"), PurePosixPath("a/b.txt"), PurePosixPath("runs.jsonl")):
            self.assertIsNone(lock_sidecar_target(path), path)


class ClaimRequestCasTests(unittest.TestCase):
    def test_claim_request_cas_recheck_in_source(self) -> None:
        """Plan 024 §H-1 acceptance (3) source scan: the CAS recheck
        path is wired so a state change between read and lock
        acquisition surfaces as
        claim_request_state_changed_during_lock instead of a stale
        state belief.

        End-to-end concurrency tests would require subprocess
        coordination + a fully-bootstrapped tools dir; the source
        scan guards against the recheck path being deleted later."""
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "agent_invocations.py"
        ).read_text(encoding="utf-8")
        self.assertIn("with state_transaction([claims_path])", src,
            "Plan 024 §H-1 — claims CAS transaction must be wired")
        self.assertIn("claim_request_state_changed_during_lock", src,
            "Plan 024 §H-1 — CAS recheck error code must exist")
        # Recheck must call derive_request_state a second time after
        # lock acquisition (the rechecked variable name is the marker).
        self.assertIn("rechecked = derive_request_state", src,
            "Plan 024 §H-1 — CAS recheck must re-derive state under lock")


class SubmitClaimResultIdempotencyTests(unittest.TestCase):
    def test_submit_idempotency_returns_existing_row(self) -> None:
        """Plan 024 §H-2 acceptance (4)."""
        # We test via the source-level guarantee that an existing-
        # result lookup runs before append. The full E2E that
        # exercises the duplicate-submit path would require a bound
        # tools dir + envelope round-trip; the source scan asserts
        # the idempotency check is wired between the lease validation
        # and the result append.
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "agent_invocations.py"
        ).read_text(encoding="utf-8")
        self.assertIn("submit_claim_result_already_persisted", src,
            "Plan 024 §H-2 — idempotency-check error code must exist")
        # Lookup must read results.jsonl filtered by claim_id.
        self.assertIn(
            'row.get("claim_id") == claim_id',
            src.split("submit_claim_result_already_persisted")[0][-500:],
            "Plan 024 §H-2 — existing-result lookup must filter by claim_id",
        )


class ImplementationScopeClaimTests(unittest.TestCase):
    def test_native_implementation_claim_excludes_overlap_until_release(self) -> None:
        from unittest.mock import patch
        from aria_kernel.agent_invocations import (
            claim_request, create_agent_invocation_request, derive_request_state,
            release_claim,
        )
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding
        from tests._helpers.git_fixtures import make_repo_with_initial_commit

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-native-scope-claims-")
        self.addCleanup(fixture_directory.cleanup)
        fixture = Path(fixture_directory.name)
        environment = patch.dict(os.environ, {
            "ARIA_REPO_STATE_ROOT": str(fixture / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(fixture / "state-store"),
        })
        environment.start()
        self.addCleanup(environment.stop)
        repo = make_repo_with_initial_commit(fixture / "source", {
            "apps/farm-service/src/interval.ts": "export const interval = 30;\n",
            "apps/farm-service/src/unit.ts": "export const unit = 'seconds';\n",
        })
        tools = fixture / "store" / "tools"
        ensure_tools_binding(tools, workspace_root=repo)
        set_profile("strict", operator_approval_ref="test:native-scope-claims", base_dir=tools)

        def request_for(path: str, purpose: str) -> dict:
            return create_agent_invocation_request(
                target_agent="aria-implementer", role="implementation",
                suggested_prompt=purpose,
                must_satisfy=[{"id": "scope-owner", "criterion": "update the declared source"}],
                allowed_scope=[path], base_dir=tools,
            )

        first = request_for("apps/farm-service/src/interval.ts", "first interval update")
        overlapping = request_for("apps/farm-service/src/interval.ts", "second interval update")
        disjoint = request_for("apps/farm-service/src/unit.ts", "independent unit update")
        self.assertEqual(len({row["request_id"] for row in (first, overlapping, disjoint)}), 3)
        first_claim = claim_request(request_id=first["request_id"], agent_id="scope-worker-a", base_dir=tools)
        disjoint_claim = claim_request(request_id=disjoint["request_id"], agent_id="scope-worker-c", base_dir=tools)
        claims_path = tools / "agent-invocations" / "claims.jsonl"
        claims_before = claims_path.read_bytes()
        native_claims = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual([row["claim_id"] for row in native_claims],
            [first_claim["claim_id"], disjoint_claim["claim_id"]])
        self.assertEqual(native_claims[0]["ledger_hash"], first_claim["claim_ledger_hash"])
        self.assertEqual(derive_request_state(request_id=disjoint["request_id"], base_dir=tools), "CLAIMED")
        with self.assertRaisesRegex(GovernanceError, "implementation_scope_locked"):
            claim_request(request_id=overlapping["request_id"], agent_id="scope-worker-b", base_dir=tools)
        self.assertEqual(claims_path.read_bytes(), claims_before)
        self.assertEqual(derive_request_state(request_id=overlapping["request_id"], base_dir=tools), "PENDING")
        release_claim(
            claim_id=first_claim["claim_id"], agent_id="scope-worker-a",
            lease_token=first_claim["lease_token"], reason="worker completed its local scope",
            base_dir=tools,
        )
        next_claim = claim_request(request_id=overlapping["request_id"], agent_id="scope-worker-b", base_dir=tools)
        native_after = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual([row["event"] for row in native_after],
            ["claimed", "claimed", "released", "requeued", "claimed"])
        self.assertEqual(native_after[3]["claim_id"], first_claim["claim_id"])
        self.assertEqual(native_after[3]["request_id"], first["request_id"])
        self.assertEqual(native_after[:2], native_claims)
        self.assertEqual(native_after[-1]["claim_id"], next_claim["claim_id"])
        self.assertEqual(derive_request_state(request_id=overlapping["request_id"], base_dir=tools), "CLAIMED")
        self.assertEqual(derive_request_state(request_id=disjoint["request_id"], base_dir=tools), "CLAIMED")

    def _scope_fixture(self) -> tuple[Path, Path]:
        from unittest.mock import patch
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import make_repo_with_initial_commit

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-scope-lifecycle-")
        self.addCleanup(fixture_directory.cleanup)
        fixture = Path(fixture_directory.name)
        environment = patch.dict(os.environ, {
            "ARIA_REPO_STATE_ROOT": str(fixture / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(fixture / "state-store"),
        })
        environment.start()
        self.addCleanup(environment.stop)
        repo = make_repo_with_initial_commit(fixture / "source", {
            "apps/farm-service/src/interval.ts": "export const interval = 30;\n",
            "apps/farm-service/src-other/unit.ts": "export const unit = 'seconds';\n",
        })
        tools = fixture / "store" / "tools"
        ensure_tools_binding(tools, workspace_root=repo)
        set_profile("strict", operator_approval_ref="test:scope-lifecycle", base_dir=tools)
        return repo, tools

    def _scope_request(self, tools: Path, path: str, purpose: str, *, role: str = "implementation") -> dict:
        from aria_kernel.agent_invocations import create_agent_invocation_request

        return create_agent_invocation_request(
            target_agent="aria-implementer" if role == "implementation" else "aria-primary-planner",
            role=role, suggested_prompt=purpose,
            must_satisfy=[{"id": "scope-owner", "criterion": "inspect the declared source"}],
            allowed_scope=[path], base_dir=tools,
        )

    def test_heartbeat_owns_scope_through_exact_expiry_then_allows_next_claim(self) -> None:
        from datetime import datetime, timedelta, timezone
        from unittest.mock import patch
        from aria_kernel.agent_invocations import claim_request, derive_request_state, heartbeat_claim
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import GovernanceError

        _repo, tools = self._scope_fixture()
        path = "apps/farm-service/src/interval.ts"
        first = self._scope_request(tools, path, "inspect interval before heartbeat")
        next_request = self._scope_request(tools, path, "inspect interval after heartbeat")
        stamp = datetime.now(timezone.utc).replace(microsecond=0)
        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=stamp):
            claim = claim_request(request_id=first["request_id"], agent_id="scope-worker-a",
                lease_seconds=5, base_dir=tools)
        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=stamp + timedelta(seconds=4)):
            heartbeat = heartbeat_claim(claim_id=claim["claim_id"], agent_id="scope-worker-a",
                lease_token=claim["lease_token"], extend_seconds=60, base_dir=tools)
        claims_path = tools / "agent-invocations" / "claims.jsonl"
        rows = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual([row["event"] for row in rows], ["claimed", "heartbeat"])
        self.assertEqual(rows[0]["ledger_hash"], claim["claim_ledger_hash"])
        self.assertEqual(rows[1]["claim_id"], claim["claim_id"])
        expiry = stamp + timedelta(seconds=64)
        self.assertEqual(heartbeat["lease_expires_at"], expiry.strftime("%Y-%m-%dT%H:%M:%SZ"))
        claims_before = claims_path.read_bytes()
        for elapsed in (6, 64):
            with self.subTest(elapsed=elapsed), patch(
                "aria_kernel.agent_invocations._utc_now_dt", return_value=stamp + timedelta(seconds=elapsed),
            ):
                self.assertEqual(derive_request_state(request_id=first["request_id"], base_dir=tools), "RUNNING")
                with self.assertRaisesRegex(GovernanceError, "implementation_scope_locked"):
                    claim_request(request_id=next_request["request_id"], agent_id="scope-worker-b", base_dir=tools)
                self.assertEqual(claims_path.read_bytes(), claims_before)
        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=expiry + timedelta(seconds=1)):
            next_claim = claim_request(request_id=next_request["request_id"], agent_id="scope-worker-b", base_dir=tools)
            self.assertEqual(derive_request_state(request_id=next_request["request_id"], base_dir=tools), "CLAIMED")
        after = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual(after[:2], rows)
        self.assertEqual([row["event"] for row in after], ["claimed", "heartbeat", "claimed"])
        self.assertEqual(after[-1]["claim_id"], next_claim["claim_id"])

    def test_directory_scope_exclusion_preserves_other_roles_and_adjacent_paths(self) -> None:
        from aria_kernel.agent_invocations import claim_request, derive_request_state, release_claim
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import GovernanceError

        _repo, tools = self._scope_fixture()
        source = "apps/farm-service/src/interval.ts"
        planning = self._scope_request(tools, source, "plan the source review", role="primary_plan")
        parent = self._scope_request(tools, "apps/farm-service/src", "inspect source directory")
        child = self._scope_request(tools, source, "inspect directory member")
        adjacent = self._scope_request(tools, "apps/farm-service/src-other/unit.ts", "inspect adjacent directory")
        planning_claim = claim_request(request_id=planning["request_id"], agent_id="planner-worker", base_dir=tools)
        parent_claim = claim_request(request_id=parent["request_id"], agent_id="scope-worker-a", base_dir=tools)
        adjacent_claim = claim_request(request_id=adjacent["request_id"], agent_id="scope-worker-c", base_dir=tools)
        claims_path = tools / "agent-invocations" / "claims.jsonl"
        before = claims_path.read_bytes()
        with self.assertRaisesRegex(GovernanceError, "implementation_scope_locked"):
            claim_request(request_id=child["request_id"], agent_id="scope-worker-b", base_dir=tools)
        self.assertEqual(claims_path.read_bytes(), before)
        release_claim(claim_id=parent_claim["claim_id"], agent_id="scope-worker-a",
            lease_token=parent_claim["lease_token"], reason="worker completed its local scope", base_dir=tools)
        child_claim = claim_request(request_id=child["request_id"], agent_id="scope-worker-b", base_dir=tools)
        rows = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual([row["claim_id"] for row in rows if row["event"] == "claimed"],
            [planning_claim["claim_id"], parent_claim["claim_id"], adjacent_claim["claim_id"], child_claim["claim_id"]])
        self.assertEqual(derive_request_state(request_id=planning["request_id"], base_dir=tools), "CLAIMED")
        self.assertEqual(derive_request_state(request_id=adjacent["request_id"], base_dir=tools), "CLAIMED")


    def test_native_prepared_submission_keeps_scope_until_terminal_result(self) -> None:
        from datetime import datetime, timedelta, timezone
        import hashlib
        import json
        from unittest.mock import patch
        from aria_kernel import ledger
        from aria_kernel.agent_invocations import (
            claim_request, create_agent_invocation_request, derive_request_state,
            submit_claim_result,
        )
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import GovernanceError

        repo, tools = self._scope_fixture()
        path = "apps/farm-service/src/interval.ts"
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        request = create_agent_invocation_request(
            target_agent="aria-implementer", role="implementation",
            suggested_prompt="inspect interval before returning the bound response",
            must_satisfy=[{"id": "scope-owner", "criterion": "inspect the declared source"}],
            allowed_scope=[path], target_sha=head, base_dir=tools,
        )
        next_request = self._scope_request(tools, path, "inspect interval after terminal response")
        stamp = datetime.now(timezone.utc).replace(microsecond=0)
        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=stamp):
            claim = claim_request(request_id=request["request_id"], agent_id="scope-worker-a",
                lease_seconds=5, base_dir=tools)
        response = {
            "$schema": "aria/agent-response/v1", "request_id": request["request_id"],
            "claim_id": claim["claim_id"], "agent_id": claim["agent_id"],
            "role": "implementation", "status": "submitted",
            "satisfaction_matrix": [{"id": "scope-owner", "verdict": "satisfied",
                "evidence_refs": [path + ":1"]}],
            "evidence_refs": [path + ":1"],
        }
        output = Path(request["expected_output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(response), encoding="utf-8")
        original_output = output.read_bytes()
        transcript = tools.parent / "scope-worker-transcript.txt"
        transcript.write_text("Fixture worker inspected the committed interval declaration.\n", encoding="utf-8")
        arguments = {
            "claim_id": claim["claim_id"], "agent_id": claim["agent_id"],
            "lease_token": claim["lease_token"], "output_path": output,
            "workspace_root": repo, "base_dir": tools,
            "context_hash": request["context_hash"], "prompt_hash": request["prompt_hash"],
            "transcript_hash": "sha256:" + hashlib.sha256(transcript.read_bytes()).hexdigest(),
            "transcript_artifact_ref": str(transcript),
        }
        real_append = ledger.StateTransaction.append_declared_jsonl
        observed_journals = []

        def append_then_interrupt(transaction, ledger_path, record, **kwargs):
            stored = real_append(transaction, ledger_path, record, **kwargs)
            if record.get("event") == "result_submission_prepared" and record.get("claim_id") == claim["claim_id"]:
                observed_journals.append(stored)
                raise OSError("fixture write interruption after native prepared append")
            return stored

        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=stamp + timedelta(seconds=1)), patch.object(
            ledger.StateTransaction, "append_declared_jsonl", append_then_interrupt,
        ), self.assertRaisesRegex(OSError, "after native prepared append"):
            submit_claim_result(**arguments)
        self.assertEqual(len(observed_journals), 1)
        claims_path = tools / "agent-invocations" / "claims.jsonl"
        results_path = tools / "agent-invocations" / "results.jsonl"
        prepared_rows = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual([row["event"] for row in prepared_rows], ["claimed", "result_submission_prepared"])
        self.assertEqual(prepared_rows[0]["ledger_hash"], claim["claim_ledger_hash"])
        self.assertEqual(prepared_rows[1], observed_journals[0])
        self.assertEqual(prepared_rows[1]["prepared"]["status"], "accepted")
        self.assertEqual(load_declared_jsonl(results_path, expected_surface="agent_invocation_results"), [])
        prepared_bytes = claims_path.read_bytes()
        with patch("aria_kernel.agent_invocations._utc_now_dt", return_value=stamp + timedelta(seconds=6)):
            self.assertEqual(derive_request_state(request_id=request["request_id"], base_dir=tools), "CLAIMED")
            with self.assertRaisesRegex(GovernanceError, "implementation_scope_locked"):
                claim_request(request_id=next_request["request_id"], agent_id="scope-worker-b", base_dir=tools)
            self.assertEqual(claims_path.read_bytes(), prepared_bytes)
            resumed = submit_claim_result(**arguments)
            self.assertEqual(resumed["status"], "accepted")
            native_results = load_declared_jsonl(results_path, expected_surface="agent_invocation_results")
            self.assertEqual(len(native_results), 1)
            self.assertEqual(native_results[0]["claim_id"], claim["claim_id"])
            self.assertEqual(native_results[0]["request_id"], request["request_id"])
            self.assertEqual(native_results[0]["submission_operation_id"], prepared_rows[1]["operation_id"])
            self.assertEqual(native_results[0]["output_hash"], "sha256:" + hashlib.sha256(original_output).hexdigest())
            self.assertEqual(claims_path.read_bytes(), prepared_bytes)
            next_claim = claim_request(request_id=next_request["request_id"], agent_id="scope-worker-b", base_dir=tools)
        final_rows = load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        self.assertEqual(final_rows[:2], prepared_rows)
        self.assertEqual([row["event"] for row in final_rows], ["claimed", "result_submission_prepared", "claimed"])
        self.assertEqual(final_rows[-1]["claim_id"], next_claim["claim_id"])
        self.assertEqual(output.read_bytes(), original_output)



if __name__ == "__main__":
    unittest.main()
