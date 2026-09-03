"""Plan 025 §A.1 — submit_claim_result envelope-hash drift gate tests.

Closes: aria-findings/F-006.json#F-006

The pre-Plan-025 idempotency check on results.jsonl was claim_id-only:
any second submit_claim_result call with a matching claim_id returned
{idempotent: True, row: existing} regardless of whether the second
envelope was byte-identical or a drifted payload. The drift case let
an attacker (or an honest worker re-running with a mutated envelope)
silently overwrite-by-shadow an accepted result.

Plan 025 §A.1 promotes the dedup key from claim_id alone to
(claim_id, envelope_evidence_hash) and wraps the lookup +
comparison + every results.jsonl mutation inside
with_exclusive_lock(results_path). Three governance reason codes:

* submit_claim_result_already_persisted  — byte-identical replay
* submit_claim_result_duplicate_with_drift — same claim_id, different
  envelope hash; raises GovernanceError + emits
  agent_result_duplicate_with_drift governance event
* submit_claim_result_legacy_row_drift_undecidable — existing row
  lacks envelope_evidence_hash field (legacy data); raises
  GovernanceError + emits
  agent_result_legacy_row_drift_undecidable governance event;
  operator runs the §A.1 backfill migration

This test suite walks all three plus three orthogonal cases:
concurrent submits, lock acquisition timeout, and dict-key reorder
canonical-JSON stability.
"""
from __future__ import annotations

import json
import hashlib
import multiprocessing
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    submit_claim_result,
)
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.ledger import load_jsonl, rewrite_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture, sha256_file


def _seed_repo() -> Path:
    """Create a tempdir that looks like a repo root."""
    repo = Path(tempfile.mkdtemp(prefix="aria-plan-025-a1-"))
    (repo / "src.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "aria-test@example.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=repo, check=True)
    subprocess.run(["git", "add", "src.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "fixture: evidence"], cwd=repo, check=True)
    return repo


def _governance_path(tools_dir: Path) -> Path:
    return tools_dir / "governance.jsonl"


def _governance_kinds(tools_dir: Path) -> list[str]:
    rows = load_jsonl(_governance_path(tools_dir))
    return [row.get("kind") for row in rows]


class _SubmitFixture(unittest.TestCase):
    """Shared setup: create request, claim it, build a valid envelope."""

    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        self.target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo,
            text=True,
        ).strip()
        self.request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="validate F-006 envelope drift",
            must_satisfy=[
                {"id": "F-006-evidence", "criterion": "F-006 envelope drift gated"},
            ],
            allowed_scope=["**"],
            convergence_id="conv-plan-025-a1",
            target_sha=self.target_sha,
            base_dir=self.tools,
        )
        self.claim = claim_request(
            request_id=self.request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def _envelope(
        self,
        *,
        verdict: str = "satisfied",
        confidence: float = 0.92,
        evidence_refs: list[str] | None = None,
    ) -> dict:
        return {
            "$schema": "aria/agent-response/v1",
            "request_id": self.request["request_id"],
            "claim_id": self.claim["claim_id"],
            "agent_id": self.claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "F-006-evidence",
                    "verdict": verdict,
                    "evidence_refs": evidence_refs or ["src.txt:1"],
                },
            ],
            "evidence_refs": evidence_refs or ["src.txt:1"],
            "details": {"verdict": "true_positive", "confidence": confidence},
        }

    def _write_envelope(self, envelope: dict) -> Path:
        out_path = Path(self.request["expected_output_path"])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(envelope), encoding="utf-8")
        return out_path

    def _submit(self, out_path: Path, *, lock_timeout_seconds: float | None = None) -> dict:
        transcript = out_path.with_suffix(".transcript.txt")
        if not transcript.exists():
            transcript.write_text(
                f"fixture transcript for {self.claim['claim_id']}\n",
                encoding="utf-8",
            )
        return submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id=self.claim["agent_id"],
            lease_token=self.claim["lease_token"],
            output_path=out_path,
            workspace_root=self.repo,
            base_dir=self.tools,
            lock_timeout_seconds=lock_timeout_seconds,
            context_hash=str(self.request["context_hash"]),
            prompt_hash=str(self.request["prompt_hash"]),
            transcript_hash=sha256_file(transcript),
            transcript_artifact_ref=transcript.resolve().as_posix(),
        )

    def _results_rows_for_claim(self) -> list[dict]:
        results = load_jsonl(self.tools / "agent-invocations" / "results.jsonl")
        return [row for row in results if row.get("claim_id") == self.claim["claim_id"]]


class ByteIdenticalReplayTests(_SubmitFixture):
    def test_byte_identical_envelope_returns_idempotent(self) -> None:
        """Plan 025 §A.1: same envelope twice -> second call is idempotent."""
        envelope = self._envelope()
        out = self._write_envelope(envelope)

        first = self._submit(out)
        self.assertEqual(first["status"], "accepted", first)

        second = self._submit(out)
        self.assertEqual(second["status"], "idempotent", second)
        self.assertTrue(second.get("idempotent"))

        # Exactly one persisted row.
        rows = self._results_rows_for_claim()
        self.assertEqual(len(rows), 1, rows)

        # Governance carries the idempotent_replay event.
        kinds = _governance_kinds(self.tools)
        self.assertIn("agent_result_idempotent_replay", kinds)


class DriftEnvelopeRaisesTests(_SubmitFixture):
    def test_drift_envelope_raises_with_reason_code(self) -> None:
        """Plan 025 §A.1: same claim_id, different envelope -> drift raise."""
        envelope_1 = self._envelope(verdict="satisfied")
        out_1 = self._write_envelope(envelope_1)
        first = self._submit(out_1)
        self.assertEqual(first["status"], "accepted", first)

        # Mutate the satisfaction_matrix verdict — semantically meaningful
        # drift, not a cosmetic key reorder.
        envelope_2 = self._envelope(verdict="unsatisfied")
        out_2 = self._write_envelope(envelope_2)
        with self.assertRaises(GovernanceError) as cm:
            self._submit(out_2)
        self.assertIn(
            "submit_claim_result_duplicate_with_drift",
            str(cm.exception),
            cm.exception,
        )

        # The second submit raised; the existing row is still the only row.
        rows = self._results_rows_for_claim()
        self.assertEqual(len(rows), 1, rows)

        # Governance event carries differing hashes.
        gov_rows = load_jsonl(_governance_path(self.tools))
        drift_events = [
            row for row in gov_rows
            if row.get("kind") == "agent_result_duplicate_with_drift"
        ]
        self.assertEqual(len(drift_events), 1, drift_events)
        details = drift_events[0]["details"]
        self.assertNotEqual(details["existing_hash"], details["submitted_hash"])
        self.assertEqual(details["claim_id"], self.claim["claim_id"])


# Module-level helper for multiprocessing.Process — must be picklable.
def _concurrent_submit_worker(
    *,
    repo_root: str,
    tools_dir: str,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    envelope_path: str,
    transcript_path: str,
    context_hash: str,
    prompt_hash: str,
    result_queue: multiprocessing.Queue,  # type: ignore[type-arg]
) -> None:
    # Plan ARIA-V2 ORPHAN-MEDIUM-075 — outer try wraps the inner import
    # + invocation so a spawn-bootstrap import crash (e.g. transient
    # filesystem error in cold-import of aria_kernel.*) still puts an
    # outcome on the queue. Pre-fix the import failure killed the
    # child before reaching the inner ``try``; the parent saw an
    # empty queue and the test failed with ``outcomes == []`` instead
    # of a structured error report. Tier-1: making the child's crash
    # mode reach the audit channel is architecturally correct (the
    # queue exists to record outcomes, not to be bypassed on crash).
    try:
        from aria_kernel.agent_invocations import submit_claim_result as _submit
        from aria_kernel.tool_registry import GovernanceError as _GovError
    except BaseException as exc:  # noqa: BLE001 — spawn-import surface
        try:
            result_queue.put(
                (
                    "unexpected",
                    f"import_failed:{type(exc).__name__}: {exc}",
                    False,
                ),
            )
        except BaseException:  # noqa: BLE001 — queue itself broken
            pass
        return

    try:
        outcome = _submit(
            claim_id=claim_id,
            agent_id=agent_id,
            lease_token=lease_token,
            output_path=Path(envelope_path),
            workspace_root=Path(repo_root),
            base_dir=Path(tools_dir),
            context_hash=context_hash,
            prompt_hash=prompt_hash,
            transcript_hash="sha256:" + hashlib.sha256(Path(transcript_path).read_bytes()).hexdigest(),
            transcript_artifact_ref=Path(transcript_path).resolve().as_posix(),
        )
        result_queue.put(("ok", outcome["status"], outcome.get("idempotent", False)))
    except _GovError as exc:
        result_queue.put(("error", str(exc), False))
    except BaseException as exc:  # noqa: BLE001 — surface every failure mode
        try:
            result_queue.put(
                (
                    "unexpected",
                    f"{type(exc).__name__}: {exc}",
                    False,
                ),
            )
        except BaseException:  # noqa: BLE001 — queue broken; nothing more we can do
            pass


class ConcurrentSubmitRaceTests(_SubmitFixture):
    def test_concurrent_submit_race_5_subprocesses(self) -> None:
        """Plan 025 §A.1: 5 concurrent identical submits -> 1 accepted, others
        either idempotent or surfaced as a Plan 025 §A.1 governance error.

        The load-bearing Plan 025 §A.1 invariants under test:
          (1) Exactly ONE child returns status='accepted' (the lock-bound
              dedup admits exactly one writer).
          (2) results.jsonl carries exactly ONE row for the claim
              (no double-append from racing readers).
          (3) NO child returns a Plan 025 §A.1 reason code that contradicts
              the invariants (no submit_claim_result_duplicate_with_drift,
              no submit_claim_result_legacy_row_drift_undecidable).

        ORPHAN-062 (also tracked): tool_registry._atomic_write_json uses a
        single shared `<file>.tmp` path for the integrity_index.json
        rename, so concurrent writers (anywhere in the kernel — not
        Plan 025 specific) can FileNotFoundError on the rename of the
        SECOND-rename-loser's tmp file. This is a pre-existing
        tool_registry race surface that Plan 025 §A.1 does not address;
        the test tolerates that specific 'unexpected' outcome (assertion
        is on Plan 025 §A.1 invariants, not on tool_registry index
        atomicity). Fixing the index race is outside Plan 025 §A.1's
        scope per architectural-arbiter (the §A.1 lock is on
        results.jsonl; the index race lives one ledger over).
        """
        envelope = self._envelope()
        out = self._write_envelope(envelope)
        transcript = out.with_suffix(".transcript.txt")
        transcript.write_text(
            f"fixture transcript for {self.claim['claim_id']}\n",
            encoding="utf-8",
        )

        # spawn-mode keeps the test deterministic across POSIX +
        # Windows — fork copies module state so the children never
        # re-import; spawn fully re-imports aria_kernel.
        ctx = multiprocessing.get_context("spawn")
        result_queue = ctx.Queue()
        procs: list[multiprocessing.Process] = []
        for _ in range(5):
            p = ctx.Process(
                target=_concurrent_submit_worker,
                kwargs={
                    "repo_root": str(self.repo),
                    "tools_dir": str(self.tools),
                    "claim_id": self.claim["claim_id"],
                    "agent_id": self.claim["agent_id"],
                    "lease_token": self.claim["lease_token"],
                    "envelope_path": str(out),
                    "transcript_path": str(transcript),
                    "context_hash": str(self.request["context_hash"]),
                    "prompt_hash": str(self.request["prompt_hash"]),
                    "result_queue": result_queue,
                },
            )
            procs.append(p)
            p.start()
        for p in procs:
            p.join(timeout=30)
            self.assertFalse(p.is_alive(), "concurrent submit child hung")
        # Plan ARIA-V2 ORPHAN-MEDIUM-075 — surface child exit codes so a
        # silent crash (SIGKILL, OOM, segfault, OS-level abort) cannot
        # produce an opaque ``outcomes == []`` failure. A non-zero
        # exitcode means the child died WITHOUT reaching the try block's
        # broad ``except``, which is itself architecturally meaningful
        # information operators need at audit time.
        exit_codes = [p.exitcode for p in procs]
        self.assertTrue(
            all(code == 0 for code in exit_codes),
            msg=f"concurrent submit child(ren) exited non-zero: {exit_codes}",
        )

        # Plan ARIA-V2 ORPHAN-MEDIUM-075 fix — ``multiprocessing.Queue.empty()``
        # is unreliable across pipe-buffered IPC: under full-suite timing
        # pressure the parent observes ``empty() == True`` BEFORE the
        # children's pipe-flush completes, leaving ``outcomes == []``
        # even after every child ``p.join(timeout=30)`` returned. The
        # architecturally correct primitive is blocking ``get(timeout=N)``
        # called exactly ``len(procs)`` times — each call drains one
        # pipe message and returns once the bytes are on the parent
        # side. Pipes are FIFO + acknowledged so 5 puts produce 5 gets.
        import queue as _stdlib_queue
        outcomes: list[tuple[str, str, bool]] = []
        for _ in range(len(procs)):
            try:
                outcomes.append(result_queue.get(timeout=10))
            except _stdlib_queue.Empty:
                # A timeout here means a child genuinely failed to put
                # anything on the queue — a real crash-before-try in
                # the spawn'd worker. Surface the partial set so the
                # subsequent assertion gives operators full context
                # (Plan-026R debug discipline — don't truncate evidence).
                break
        self.assertEqual(len(outcomes), 5, outcomes)

        accepted = [o for o in outcomes if o[0] == "ok" and o[1] == "accepted"]
        idempotent = [o for o in outcomes if o[0] == "ok" and o[1] == "idempotent"]
        plan_025_errors = [
            o for o in outcomes
            if o[0] == "error" and (
                "submit_claim_result_duplicate_with_drift" in o[1]
                or "submit_claim_result_legacy_row_drift_undecidable" in o[1]
            )
        ]
        # Plan 025 §A.1 invariants:
        self.assertEqual(len(accepted), 1, outcomes)
        self.assertEqual(plan_025_errors, [], outcomes)
        # Every child either landed accepted, idempotent, or hit the
        # ORPHAN-062 index race (pre-existing tool_registry surface).
        plan_025_consistent = (
            len(accepted) + len(idempotent)
            + sum(1 for o in outcomes if o[0] == "unexpected" and "FileNotFoundError" in o[1])
        )
        self.assertEqual(plan_025_consistent, 5, outcomes)
        # Single persisted row for the claim — Plan 025 §A.1's main
        # mutual-exclusion invariant.
        rows = self._results_rows_for_claim()
        self.assertEqual(len(rows), 1, rows)


class LockTimeoutTests(_SubmitFixture):
    def test_lock_acquire_timeout_raises_TimeoutError(self) -> None:
        """Plan 025 §A.1: results.jsonl lock contention surfaces as TimeoutError.

        The architectural shape: submit_claim_result accepts
        `lock_timeout_seconds` so the lock contention behaviour is
        callable-level configurable rather than module-attribute
        monkey-patched. The test exercises the explicit parameter; the
        TimeoutError surfaces unmodified from with_exclusive_lock.
        """
        envelope = self._envelope()
        out = self._write_envelope(envelope)
        # Make sure the parent path of results.jsonl exists so the lock
        # side-car can be created by the child immediately.
        results_path = self.tools / "agent-invocations" / "results.jsonl"
        results_path.parent.mkdir(parents=True, exist_ok=True)

        # Spawn a child that holds the results.jsonl lock for 5s.
        kernel_root = str(Path(__file__).resolve().parent.parent)
        child_script = (
            f"import sys, time\n"
            f"sys.path.insert(0, {kernel_root!r})\n"
            f"from aria_kernel.file_lock import with_exclusive_lock\n"
            f"from pathlib import Path\n"
            f"with with_exclusive_lock(Path({str(results_path)!r})):\n"
            f"    print('LOCKED', flush=True)\n"
            f"    time.sleep(5)\n"
        )
        child = subprocess.Popen(
            [sys.executable, "-c", child_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            line = child.stdout.readline()
            self.assertIn(b"LOCKED", line)

            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                self._submit(out, lock_timeout_seconds=0.5)
            elapsed = time.monotonic() - start
            self.assertLess(
                elapsed,
                2.0,
                f"timeout took {elapsed:.2f}s; should be <2s with 0.5s lock_timeout",
            )

            # No partial write: results.jsonl carries no row for this claim.
            self.assertEqual(self._results_rows_for_claim(), [])
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                child.kill()


class LegacyRowDriftUndecidableTests(_SubmitFixture):
    def test_legacy_row_drift_undecidable_explicit_error(self) -> None:
        """Plan 025 §A.1: existing row missing envelope_evidence_hash -> raise."""
        # Hand-write a legacy results.jsonl row for our claim that lacks
        # the envelope_evidence_hash field. We bypass append_jsonl's hash
        # chain by writing the row directly so the field is genuinely
        # absent (mimicking pre-Plan-025 production data).
        results_path = self.tools / "agent-invocations" / "results.jsonl"
        legacy_row = {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "claim_id": self.claim["claim_id"],
            "request_id": self.request["request_id"],
            "agent_id": self.claim["agent_id"],
            "role": "evidence_judgment",
            "status": "accepted",
            "output_path": "legacy/output.json",
            "output_hash": "sha256:legacy",
            "checked_evidence_count": 1,
            "submitted_at": "2026-04-01T12:00:00Z",
        }
        # Use append_jsonl so the hash chain stays valid for any
        # downstream loader; the row itself still lacks
        # envelope_evidence_hash because we don't include it.
        append_declared_fixture(
            results_path,
            legacy_row,
            expected_surface="agent_invocation_results",
        )

        envelope = self._envelope()
        out = self._write_envelope(envelope)
        with self.assertRaises(GovernanceError) as cm:
            self._submit(out)
        self.assertIn(
            "submit_claim_result_legacy_row_drift_undecidable",
            str(cm.exception),
        )
        self.assertIn(
            "run migration plan-025-A1-backfill-envelope-hash",
            str(cm.exception),
        )

        # Governance event landed.
        kinds = _governance_kinds(self.tools)
        self.assertIn("agent_result_legacy_row_drift_undecidable", kinds)


class CanonicalJsonDictReorderTests(_SubmitFixture):
    def test_envelope_hash_dict_key_reorder_stays_idempotent(self) -> None:
        """Plan 025 §A.1: dict-key reorder is canonical-JSON equivalent.

        envelope_hash uses json.dumps(sort_keys=True), so two envelopes
        that differ only in top-level dict key order produce the same
        sha256 digest. The second submit therefore takes the
        byte-identical idempotent path, NOT the drift path.

        (List-element reorder is genuine drift — sort_keys does not
        sort list contents — and is covered by
        DriftEnvelopeRaisesTests.test_drift_envelope_raises_with_reason_code.)
        """
        # Build the original envelope and compute the file path.
        envelope_1 = self._envelope()
        out = self._write_envelope(envelope_1)
        first = self._submit(out)
        self.assertEqual(first["status"], "accepted", first)

        # Re-write the SAME envelope content with mutated top-level dict
        # key order. json.dumps without sort_keys preserves insertion
        # order, so the on-disk bytes differ even though the canonical
        # hash matches.
        reordered = {
            "details": envelope_1["details"],
            "evidence_refs": envelope_1["evidence_refs"],
            "satisfaction_matrix": envelope_1["satisfaction_matrix"],
            "status": envelope_1["status"],
            "role": envelope_1["role"],
            "agent_id": envelope_1["agent_id"],
            "claim_id": envelope_1["claim_id"],
            "request_id": envelope_1["request_id"],
            "$schema": envelope_1["$schema"],
        }
        # Sanity: the on-disk bytes really do differ (insertion order).
        original_bytes = json.dumps(envelope_1).encode("utf-8")
        reordered_bytes = json.dumps(reordered).encode("utf-8")
        self.assertNotEqual(original_bytes, reordered_bytes)
        out.write_text(json.dumps(reordered), encoding="utf-8")

        second = self._submit(out)
        self.assertEqual(second["status"], "idempotent", second)
        self.assertTrue(second.get("idempotent"))

        # Single persisted row.
        rows = self._results_rows_for_claim()
        self.assertEqual(len(rows), 1, rows)


if __name__ == "__main__":
    unittest.main()
