"""ARIA-HIGH-124 — the implementation is delivered by the executor, outside the sandbox.

Module-seam pins for ``implementation_delivery`` (the end-to-end chain through
the real executor child is ``tests/test_executor_implementation_identity.py``):

* the stamp writes every kernel field on the record ``implementation_record``
  reads, overrides a differing agent value and records the difference — and
  records nothing when the agent supplied nothing or the same value;
* every pre-gate refusal is by name and runs no gate, no push, no `gh`: no
  publication, a refused publication, a branch the publication did not
  adopt, a branch with no commit on it, incomplete ids;
* (round 4) the published tip's IDENTITY is verified before any external
  effect: a commit the request's registered key did not sign — the agent's
  own, or none at all — is refused ``commit_identity:commit_unverified``
  with nothing pushed and no PR, and ``ARIA_DRY_RUN`` does not excuse the
  check the way it excuses the bridge's later replay;
* the refusal vocabulary is closed (an unknown stage is a programming error);
* the release reasons the executor releases under are the kernel's own
  spellings, classified request-class (the delivery) and harness-class (the
  credential), and the executor's refusal tables carry the same literals.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aria_kernel import implementation_delivery as delivery
from aria_kernel.git_containment import QuarantinePublication
from aria_kernel.implementation_delivery import (
    DELIVERY_STAGES,
    KERNEL_STAMPED_DELIVERY_FIELDS,
    ImplementationDelivery,
    ImplementationDeliveryRefusal,
    deliver_implementation,
    stamp_implementation_delivery,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

BRANCH = "aria-impl-0123abcd0123abcd"
IDS = {"proposal_id": "proposal-1", "change_id": "chg-1", "branch": BRANCH, "base_sha": "0" * 40}
CYCLE_ID = "cyc-aria-high-124"
# A fingerprint shaped like a real one, for the refusals decided BEFORE the
# identity stage (the publication's facts): those never reach a verifier.
UNUSED_FINGERPRINT = "SHA256:" + "A" * 43


def _mint_signing_key(directory: Path, name: str) -> tuple[Path, str, str]:
    """(private key path, public key line, fingerprint) — the shape
    ``gh_token_factory.mint_signing_key`` produces, made here directly so
    the pin owns both halves: the key the kernel registers, and the one the
    agent could mint for itself under its own writable HOME."""
    from aria_kernel.knowledge_graph import fingerprint_of_public_key

    key = directory / name
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", str(key)], check=True)
    public = key.with_suffix(".pub").read_text(encoding="utf-8").strip()
    return key, public, fingerprint_of_public_key(public)


def _commit_signed_with(repo: Path, key: Path | None, *, message: str, path: str, body: str) -> str:
    """One commit on the current branch, signed with ``key`` (None: unsigned)."""
    (repo / path).write_text(body, encoding="utf-8")
    _git(["add", path], cwd=repo)
    signing = ["-c", "gpg.format=ssh", "-c", f"user.signingkey={key}", "-c", "commit.gpgsign=true"] if key else []
    _git([*signing, "commit", "-q", "-m", message], cwd=repo)
    return _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()


def _delivery(**overrides: object) -> ImplementationDelivery:
    fields = dict(
        branch=BRANCH, branch_tip_sha="a" * 40, base_branch_sha="0" * 40, diff_hash="sha256:" + "b" * 64,
        pr_url="https://github.com/fixture/r/pull/7", pr_number=7, validation_gate_ref="sha256:" + "c" * 64,
        validation_results=({"command": "npx nx affected --target=test", "exit_code": 0},),
    )
    fields.update(overrides)
    return ImplementationDelivery(**fields)


def _published(branch: str = BRANCH, *, adopted: str | None = BRANCH, refusal: str | None = None) -> QuarantinePublication:
    return QuarantinePublication(3, 0, (), (branch,) if branch else (), (), refusal=refusal, head_adopted=adopted)


class StampTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-stamp-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _governance(self, kind: str) -> list[dict]:
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        return [row for row in rows if row.get("kind") == kind]

    def test_every_kernel_field_lands_on_the_nested_record_and_nothing_is_recorded(self) -> None:
        envelope = {"details": {"implementation": {}}}
        changed = stamp_implementation_delivery(envelope, delivery=_delivery(), request_id="AIR-1", claim_id="c-1",
                                                base_dir=self.tools)
        self.assertTrue(changed)
        record = envelope["details"]["implementation"]
        self.assertEqual({name: record[name] for name in KERNEL_STAMPED_DELIVERY_FIELDS}, _delivery().record_fields())
        self.assertEqual(self._governance(delivery.IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT), [])
        # Idempotent: the same facts again change nothing and record nothing.
        self.assertFalse(stamp_implementation_delivery(envelope, delivery=_delivery(), request_id="AIR-1", claim_id="c-1",
                                                       base_dir=self.tools))
        self.assertEqual(self._governance(delivery.IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT), [])

    def test_a_flat_legacy_record_is_stamped_flat_and_a_missing_details_is_installed(self) -> None:
        envelope: dict = {}
        stamp_implementation_delivery(envelope, delivery=_delivery(), request_id="AIR-1", claim_id="c-1", base_dir=self.tools)
        self.assertEqual(envelope["details"]["pr_url"], "https://github.com/fixture/r/pull/7")
        self.assertNotIn("implementation", envelope["details"])

    def test_an_agent_value_that_differs_is_replaced_and_recorded_with_both_sides(self) -> None:
        envelope = {"details": {"implementation": {
            "pr_url": "https://github.com/fixture/forged/pull/1", "branch_tip_sha": "f" * 40, "pr_number": 1,
            "validation_results": [{"command": "echo ok", "exit_code": 0}],
            # The same value the kernel holds: not an override.
            "branch": BRANCH,
        }}}
        stamp_implementation_delivery(envelope, delivery=_delivery(), request_id="AIR-1", claim_id="c-1", base_dir=self.tools)
        record = envelope["details"]["implementation"]
        self.assertEqual(record["pr_url"], "https://github.com/fixture/r/pull/7")
        self.assertEqual(record["branch_tip_sha"], "a" * 40)
        self.assertEqual(record["pr_number"], 7)
        self.assertEqual(record["validation_results"], [{"command": "npx nx affected --target=test", "exit_code": 0}])
        rows = self._governance(delivery.IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT)
        self.assertEqual(len(rows), 1, rows)
        details = rows[0]["details"]
        self.assertEqual((details["request_id"], details["claim_id"]), ("AIR-1", "c-1"))
        self.assertEqual(details["agent_supplied"], {
            "pr_url": "https://github.com/fixture/forged/pull/1", "branch_tip_sha": "f" * 40, "pr_number": "1",
            "validation_results": "<list of 1>",
        })
        self.assertEqual(details["kernel"], {"pr_url": "https://github.com/fixture/r/pull/7", "branch_tip_sha": "a" * 40, "pr_number": 7})
        self.assertNotIn("branch", details["agent_supplied"], "an equal value is not an override")


class RefusalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-deliver-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.base = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.ids = {**IDS, "base_sha": self.base}

    def _deliver(self, publication: QuarantinePublication | None, ids: dict | None = None) -> ImplementationDeliveryRefusal:
        with self.assertRaises(ImplementationDeliveryRefusal) as refused:
            deliver_implementation(
                request_id="AIR-1", claim_id="claim-1", agent_id="aria-implementer", cycle_id=CYCLE_ID,
                signer_key_fp=UNUSED_FINGERPRINT, implementation_ids=ids or self.ids,
                envelope={}, output_path=self.root / "envelope.json",
                workspace_root=self.repo, base_dir=self.tools, publication=publication, profile=None,
            )
        return refused.exception

    def test_pre_gate_refusals_are_by_name_and_touch_no_ledger(self) -> None:
        cases = [
            (None, self.ids, "publication_missing"),
            (_published(refusal="git_unavailable:OSError"), self.ids, "publication_refused:git_unavailable:OSError"),
            (_published("", adopted=None), self.ids, "branch_not_published:refs_published=[]:discarded=none"),
            (_published(adopted=None), self.ids, f"branch_not_published:refs_published=['{BRANCH}']:discarded=none"),
            # ARIA-HIGH-124 (round 2) — the agent committed nothing: the
            # publication discarded the kernel's seed by name and the
            # delivery refuses with that name, before any git of its own.
            (QuarantinePublication(0, 0, (), (), ((BRANCH, "branch_unadvanced"),)), self.ids,
             f"branch_not_published:refs_published=[]:discarded={BRANCH}=branch_unadvanced"),
            (_published(), {**self.ids, "change_id": ""}, "implementation_ids_incomplete"),
        ]
        for publication, ids, reason in cases:
            with self.subTest(reason=reason):
                refused = self._deliver(publication, ids)
                self.assertEqual((refused.stage, refused.reason), ("branch_publication", reason))
        # A published branch with no commit past the base (the ref exists,
        # the agent added nothing): refused before the gate.
        _git(["branch", BRANCH, self.base], cwd=self.repo)
        refused = self._deliver(_published())
        self.assertEqual((refused.stage, refused.reason), ("branch_publication", "branch_has_no_commit"))
        # Nothing was gated, pushed or opened: no apply, no effects ledger.
        self.assertFalse((self.tools / "apply").exists())
        self.assertFalse((self.tools / "recovery").exists())
        self.assertFalse((self.tools / "pr-lifecycle.jsonl").exists())

    def test_an_unknown_stage_is_a_programming_error(self) -> None:
        with self.assertRaises(ValueError):
            ImplementationDeliveryRefusal("somewhere", "why")
        # (round 2) the change ledger's verdict refuses a scope drift or an
        # undeclared shortfall before anything is pushed or opened; (round
        # 3) it comes BEFORE the gate, so an out-of-scope tip's own suite
        # never executes, and the `admission` — the job's window, the
        # validation sandbox — is decided before anything runs at all.
        self.assertEqual(DELIVERY_STAGES, ("branch_publication", "commit_identity", "admission", "change_ledger",
                                           "result_admissible", "apply_gate", "credential", "push", "pr_open"))
        self.assertEqual(delivery.ADMISSION_STAGE, "admission")
        # (round 6) the credential is minted AFTER the gate and BEFORE the
        # push — where it is consumed; a lane that cannot mint there is the
        # host's, released like the admission.
        self.assertEqual(delivery.CREDENTIAL_STAGE, "credential")
        self.assertEqual(delivery.HOST_STAGES, ("admission", "credential"))
        self.assertLess(DELIVERY_STAGES.index("apply_gate"), DELIVERY_STAGES.index("credential"))
        self.assertLess(DELIVERY_STAGES.index("credential"), DELIVERY_STAGES.index("push"))
        # (round 4) the tip's identity is decided BEFORE the admission, so
        # nothing external stands on a commit the kernel's key did not make.
        self.assertEqual(delivery.COMMIT_IDENTITY_STAGE, "commit_identity")
        self.assertLess(DELIVERY_STAGES.index("commit_identity"), DELIVERY_STAGES.index("push"))
        self.assertLess(DELIVERY_STAGES.index("commit_identity"), DELIVERY_STAGES.index("pr_open"))
        self.assertLess(DELIVERY_STAGES.index("commit_identity"), DELIVERY_STAGES.index(delivery.ADMISSION_STAGE))
        # (round 5) the RESULT is decided — the submit's own chain — after
        # the scope verdict and BEFORE the suite runs, the push and the PR:
        # an envelope the kernel will reject spends no suite and no authority.
        self.assertEqual(delivery.RESULT_ADMISSIBLE_STAGE, "result_admissible")
        self.assertLess(DELIVERY_STAGES.index("change_ledger"), DELIVERY_STAGES.index("result_admissible"))
        self.assertLess(DELIVERY_STAGES.index("result_admissible"), DELIVERY_STAGES.index("apply_gate"))

    def test_the_agents_dispositions_are_read_off_the_outcome_record_strings_only(self) -> None:
        # ARIA-HIGH-124 (round 2) — the one delivery fact the agent
        # contributes, read through the same record reading the stamp and
        # the bridge use; anything that is not `{path: sentence}` is dropped.
        self.assertEqual(delivery.agent_dispositions({}), {})
        self.assertEqual(delivery.agent_dispositions({"details": {"implementation": {}}}), {})
        self.assertEqual(delivery.agent_dispositions({"details": {"implementation": {
            delivery.AGENT_DISPOSITIONS_FIELD: {"src/a.ts": "reviewed, no change needed: covered by b", 3: "x", "src/b.ts": ["not a sentence"]},
        }}}), {"src/a.ts": "reviewed, no change needed: covered by b"})
        # The legacy flat record reads the same way.
        self.assertEqual(delivery.agent_dispositions({"details": {delivery.AGENT_DISPOSITIONS_FIELD: {"src/a.ts": "why"}}}),
                         {"src/a.ts": "why"})
        self.assertEqual(delivery.agent_dispositions({"details": {"implementation": {delivery.AGENT_DISPOSITIONS_FIELD: "prose"}}}), {})


class _DeliveredBranch(unittest.TestCase):
    """A published implementation branch whose tip the kernel's own key
    signed, and a registry that says so — what every stage past the
    publication's facts stands on."""

    def setUp(self) -> None:
        from aria_kernel.knowledge_graph import register_convention_signer

        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-deliver-branch-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.base = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.keys = self.root / "keys"
        self.keys.mkdir()
        # The key the executor mints and REGISTERS for this request's cycle,
        # and the key an agent could make for itself (its HOME is writable).
        self.kernel_key, kernel_public, self.kernel_fingerprint = _mint_signing_key(self.keys, "cycle")
        self.agent_key, _agent_public, self.agent_fingerprint = _mint_signing_key(self.keys, "agent-own")
        register_convention_signer(
            cycle_id=CYCLE_ID, signer_key_fp=self.kernel_fingerprint, public_key=kernel_public, base_dir=self.tools,
        )
        # A branch with a commit past the base: the publication's facts hold,
        # so the tip's identity is the first thing the delivery decides.
        _git(["switch", "-q", "-c", BRANCH], cwd=self.repo)
        self.tip = _commit_signed_with(
            self.repo, self.kernel_key, message="feat: flip", path="src/app.ts",
            body="export const app = false;\n",
        )
        self.ids = {**IDS, "base_sha": self.base}

    def _deliver(self, *, signer_key_fp: str | None = None, **overrides: object) -> ImplementationDeliveryRefusal:
        arguments: dict[str, object] = dict(
            request_id="AIR-1", claim_id="claim-1", agent_id="aria-implementer", cycle_id=CYCLE_ID,
            signer_key_fp=self.kernel_fingerprint if signer_key_fp is None else signer_key_fp,
            implementation_ids=self.ids, envelope={}, output_path=self.root / "envelope.json",
            workspace_root=self.repo, base_dir=self.tools,
            publication=_published(), profile=None,
        )
        arguments.update(overrides)
        with self.assertRaises(ImplementationDeliveryRefusal) as refused:
            deliver_implementation(**arguments)  # type: ignore[arg-type]
        return refused.exception

    def _assert_nothing_external_happened(self) -> None:
        """No gate, no recorded run, no push intent, no PR: the stages below
        the refusal never ran."""
        self.assertFalse((self.tools / "apply").exists())
        self.assertFalse((self.tools / "recovery").exists())
        self.assertFalse((self.tools / "validation").exists())
        self.assertFalse((self.tools / "change-ledger").exists())
        self.assertFalse((self.tools / "pr-lifecycle.jsonl").exists())


class CommitIdentityTests(_DeliveredBranch):
    """ARIA-HIGH-124 (round 4) — the executor lends its external-write
    authority only to a commit the kernel's own key made.

    Until round 4 the delivery pushed ``refs/heads/aria-impl-*`` to origin
    with the delivery credential and opened the ``[ARIA-AUTO]`` PR, and the
    SUBMIT's bridge asked afterwards whether the commit verified: an agent
    that signed with a key it wrote itself (``git commit -m x
    --gpg-sign=<its own key>`` was admitted by the command policy) got a
    live PR on a branch the plan never adopted — the request derived a
    non-terminal state, the plan stayed IMPLEMENTATION_REQUESTED, and a
    later cycle could request the same plan into a second branch and PR.
    The verifier is the SAME one the bridge runs; it just runs before the
    first external effect now."""

    def test_a_tip_signed_with_a_key_the_kernel_never_held_is_refused_before_anything_external(self) -> None:
        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        _commit_signed_with(self.repo, self.agent_key, message="feat: flip", path="src/app.ts",
                            body="export const app = false;\n")
        refused = self._deliver()
        self.assertEqual(refused.stage, delivery.COMMIT_IDENTITY_STAGE)
        self.assertTrue(refused.reason.startswith("commit_unverified:commit_signature_unverified"), refused.reason)
        self._assert_nothing_external_happened()

    def test_an_unsigned_tip_is_refused_the_same_way(self) -> None:
        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        _commit_signed_with(self.repo, None, message="feat: flip", path="src/app.ts",
                            body="export const app = false;\n")
        refused = self._deliver()
        self.assertEqual(refused.stage, delivery.COMMIT_IDENTITY_STAGE)
        self.assertIn("commit_signature_unverified", refused.reason)
        self._assert_nothing_external_happened()

    def test_a_fingerprint_of_another_cycle_or_no_fingerprint_is_refused(self) -> None:
        from aria_kernel.knowledge_graph import register_convention_signer

        other_key, other_public, other_fingerprint = _mint_signing_key(self.keys, "other-cycle")
        register_convention_signer(
            cycle_id="cyc-someone-else", signer_key_fp=other_fingerprint, public_key=other_public, base_dir=self.tools,
        )
        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        _commit_signed_with(self.repo, other_key, message="feat: flip", path="src/app.ts",
                            body="export const app = false;\n")
        # A key registered under another cycle verifies the signature and is
        # still not this request's identity.
        refused = self._deliver(signer_key_fp=other_fingerprint)
        self.assertEqual(refused.stage, delivery.COMMIT_IDENTITY_STAGE)
        self.assertIn("is registered under cycle", refused.reason)
        # An unregistered fingerprint, and none at all.
        self.assertEqual(self._deliver(signer_key_fp=self.agent_fingerprint).stage, delivery.COMMIT_IDENTITY_STAGE)
        self.assertEqual(self._deliver(signer_key_fp="").stage, delivery.COMMIT_IDENTITY_STAGE)
        self._assert_nothing_external_happened()

    def test_dry_run_does_not_excuse_the_delivery_s_verification(self) -> None:
        # The bridge's replay path short-circuits `git verify-commit` under
        # ARIA_DRY_RUN (a mocked environment has no repository carrying the
        # commit). The delivery HOLDS that repository and is about to push
        # under the App's identity, so it asks for the real answer.
        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        _commit_signed_with(self.repo, self.agent_key, message="feat: flip", path="src/app.ts",
                            body="export const app = false;\n")
        with mock.patch.dict("os.environ", {"ARIA_DRY_RUN": "true"}):
            refused = self._deliver()
        self.assertEqual(refused.stage, delivery.COMMIT_IDENTITY_STAGE)
        self.assertEqual(self._governance_kinds("commit_signature_verify_skipped_dry_run"), [])
        self._assert_nothing_external_happened()

    def test_the_kernels_own_tip_passes_the_stage_and_the_delivery_moves_on(self) -> None:
        # The positive half: the same call on the commit the registered key
        # signed stops at a LATER stage (nothing is staged here, so the
        # gate refuses), never at the identity.
        refused = self._deliver()
        self.assertNotEqual(refused.stage, delivery.COMMIT_IDENTITY_STAGE)

    def _governance_kinds(self, kind: str) -> list[dict]:
        path = self.tools / "governance.jsonl"
        if not path.is_file():
            return []
        return [row for row in load_declared_jsonl(path, expected_surface="tools_governance") if row.get("kind") == kind]


class AdmissionTests(_DeliveredBranch):
    """ARIA-HIGH-124 (round 3) — the delivery is priced and admitted before it runs."""

    def setUp(self) -> None:
        from aria_kernel.implementation_safety import sandbox_backend

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        super().setUp()

    def test_the_delivery_refuses_deadline_insufficient_by_name_with_nothing_pushed(self) -> None:
        # The delivery's worst case for its staged suite (none staged here:
        # the canonical shape) does not fit what remains before the job's
        # deadline: refused at the admission, before a command runs, a row
        # is written, or anything is pushed/opened. Before round 3 the
        # delivery never read the deadline at all.
        import time

        from aria_kernel.implementation_delivery import (
            IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
            delivery_admission_refusal,
            delivery_worst_case_seconds,
        )
        from aria_kernel.implementation_safety import CANONICAL_VALIDATION_TIMEOUT_MS
        from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        worst_case = delivery_worst_case_seconds(
            validation_commands=CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, validation_timeout_ms=CANONICAL_VALIDATION_TIMEOUT_MS,
        )
        self.assertLess(worst_case, IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS)
        refused = self._deliver(job_deadline_epoch=time.time() + worst_case - 60)
        self.assertEqual(refused.stage, delivery.ADMISSION_STAGE)
        self.assertRegex(refused.reason, rf"^deadline_insufficient:remaining=\d+s:worst_case={worst_case}s$")
        self.assertFalse((self.tools / "apply").exists())
        self.assertFalse((self.tools / "recovery").exists())
        self.assertFalse((self.tools / "validation").exists())
        self.assertFalse((self.tools / "change-ledger").exists())
        # The same admission, asked the way the executor asks it before the
        # spawn and before the publication: the extra seconds are what the
        # caller still runs after the delivery.
        self.assertIsNone(delivery_admission_refusal(
            workspace_root=self.repo, base_dir=self.tools, proposal_id=IDS["proposal_id"],
            job_deadline_epoch=None,
        ))
        self.assertIsNone(delivery_admission_refusal(
            workspace_root=self.repo, base_dir=self.tools, proposal_id=IDS["proposal_id"],
            job_deadline_epoch=1000.0 + worst_case + 500, extra_seconds=500, now=1000.0,
        ))
        self.assertEqual(delivery_admission_refusal(
            workspace_root=self.repo, base_dir=self.tools, proposal_id=IDS["proposal_id"],
            job_deadline_epoch=1000.0 + worst_case + 499, extra_seconds=500, now=1000.0,
        ), f"deadline_insufficient:remaining={worst_case + 499}s:worst_case={worst_case + 500}s")
        # A window that holds it admits; the delivery then stops at the
        # gate's own refusal (nothing was staged), never at the admission.
        self.assertNotEqual(
            self._deliver(job_deadline_epoch=time.time() + worst_case + 60).stage, delivery.ADMISSION_STAGE,
        )

    def test_the_executor_decides_the_window_before_it_publishes_the_quarantine(self) -> None:
        # The executor asks the same admission twice: before the spawn (the
        # CLI at its cap, the publication and everything after it must
        # fit) and again in the `finally` around the spawn, BEFORE
        # `_publish_sandbox_commits` — a window that cannot hold the
        # delivery discards the quarantine (`implementation_quarantine_discarded`)
        # rather than publishing a branch its retry would collide with, and
        # releases harness-class. Read from the executor's source: the
        # publication is guarded by that decision, and the delivery's own
        # admission reads the same deadline.
        import ci_executor

        source = (_POC_DIR / "ci_executor.py").read_text(encoding="utf-8")
        finally_block = source.split("        finally:\n            _quarantine_publication = None\n", 1)[1].split("        if cli_exit != 0:", 1)[0]
        self.assertIn("_publication_window_refusal = delivery_admission_refusal(", finally_block)
        self.assertIn("if _publication_window_refusal is None:\n                    _quarantine_publication = _publish_sandbox_commits(", finally_block)
        self.assertIn("IMPLEMENTATION_QUARANTINE_DISCARDED_EVENT", finally_block)
        self.assertIn('"decided": "before_publication"', finally_block)
        self.assertEqual(ci_executor.IMPLEMENTATION_QUARANTINE_DISCARDED_EVENT, "implementation_quarantine_discarded")
        self.assertIn('"decided": "before_spawn"', source)
        self.assertIn("job_deadline_epoch=float(_deadline_epoch) if _deadline_epoch else None,\n                )\n            except ImplementationDeliveryRefusal as exc:", source)
        self.assertIn("if exc.stage in HOST_STAGES:", source)
        self.assertEqual((ci_executor.DELIVERY_WINDOW_REFUSAL.release_reason, ci_executor.DELIVERY_WINDOW_REFUSAL.failure_class,
                          ci_executor.DELIVERY_WINDOW_REFUSAL.retryable),
                         ("implementation_delivery_unavailable", "harness_unavailable", True))

    def test_the_validation_sandbox_contains_every_command_and_never_binds_the_store(self) -> None:
        # The wrapper the gate puts around every command: the same builder
        # the agent's spawn uses — the workspace writable, READONLY_PATHS
        # read-only, the network unshared, the sandbox's own /tmp and HOME,
        # no broker — plus the command's executable resolved OUTSIDE on the
        # validation environment's PATH and bound read-only; the store is
        # never a bind, and an executable that would bind it is refused.
        import os

        from aria_kernel.implementation_safety import (
            SANDBOX_HOME,
            SandboxUnavailable,
            validation_executable_binds,
            wrap_validation_in_sandbox,
        )
        from aria_kernel.validation_env import build_validation_env

        toolchain = self.root / "toolchain" / "node-22" / "bin"
        toolchain.mkdir(parents=True)
        (toolchain / "npx").write_text("#!/bin/sh\necho npx\n", encoding="utf-8")
        (toolchain / "npx").chmod(0o755)
        (self.root / "toolchain" / "node-22" / "lib").mkdir()
        environment = build_validation_env({**os.environ, "PATH": f"{toolchain}:{os.defpath}"}).env
        argv = wrap_validation_in_sandbox(
            ["npx", "nx", "affected", "--target=test"], workspace_root=self.repo, git=None,
            environment=environment, store=self.tools,
        )
        self.assertEqual(argv[0], "bwrap")
        self.assertEqual(argv[argv.index("--") + 1:], ["npx", "nx", "affected", "--target=test"])
        self.assertIn("--unshare-net", argv)
        sources = {argv[i + 1] for i, token in enumerate(argv) if token in ("--bind", "--ro-bind")}
        self.assertIn(str(self.repo), sources)
        # The toolchain PREFIX (its `lib/` beside `bin/`), read-only.
        self.assertIn(str(self.root / "toolchain" / "node-22"), sources)
        self.assertEqual(argv[argv.index("--ro-bind", argv.index(str(self.root / "toolchain" / "node-22")) - 1)], "--ro-bind")
        self.assertNotIn(str(self.tools), sources)
        self.assertIn("HOME", argv)
        self.assertEqual(argv[argv.index("HOME") + 1], SANDBOX_HOME)
        self.assertNotIn("ARIA_HOOK_BROKER_SOCKET", argv)
        self.assertNotIn("ARIA_MCP_BROKER_SOCKET", argv)
        # (round 5) the workspace's keys dir is an EMPTY tmpfs inside — the
        # last mount over the workspace, so it shadows the `aria-debts/`
        # ro-bind — whether or not a git containment was derived (`git=None`
        # here: the main-checkout shape) and whether or not the directory
        # existed (the builder makes it: bwrap cannot create a mountpoint
        # under a read-only bind). Until round 5 the read-only git shape
        # carried no mask and the suite could read the token and the key.
        from aria_kernel.gh_token_factory import signing_keys_dir

        keys_dir = self.repo / "aria-debts" / "keys"
        self.assertTrue(keys_dir.is_dir())
        self.assertEqual(keys_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(signing_keys_dir(self.repo), keys_dir)
        masks = [argv[i + 1] for i, token in enumerate(argv) if token == "--tmpfs"]
        self.assertIn(str(keys_dir), masks)
        self.assertGreater(argv.index(str(keys_dir)), argv.index(str(self.repo)), "the mask comes after the workspace bind")
        self.assertLess(argv.index(str(keys_dir)), argv.index("--"))
        self.assertEqual(
            validation_executable_binds("npx", environment=environment, workspace=self.repo, store=self.tools),
            (self.root / "toolchain" / "node-22",),
        )
        # Refused by name: an executable nothing resolves, a PATH entry that
        # would bind the store, a prefix that contains the workspace.
        with self.assertRaisesRegex(SandboxUnavailable, "validation_executable_unresolvable:nothing-here"):
            validation_executable_binds("nothing-here", environment=environment, workspace=self.repo, store=self.tools)
        store_bin = self.tools / "bin"
        store_bin.mkdir()
        (store_bin / "npm").write_text("#!/bin/sh\n", encoding="utf-8")
        (store_bin / "npm").chmod(0o755)
        with self.assertRaisesRegex(SandboxUnavailable, "validation_toolchain_prefix_contains_store"):
            validation_executable_binds("npm", environment={"PATH": str(store_bin)}, workspace=self.repo, store=self.tools)
        above = self.root / "bin"
        above.mkdir()
        (above / "npm").write_text("#!/bin/sh\n", encoding="utf-8")
        (above / "npm").chmod(0o755)
        with self.assertRaisesRegex(SandboxUnavailable, "validation_toolchain_prefix_contains_workspace"):
            validation_executable_binds("npm", environment={"PATH": str(above)}, workspace=self.repo, store=self.tools)
        # A system executable needs no bind of its own.
        self.assertEqual(validation_executable_binds("sh", environment={"PATH": "/bin:/usr/bin"}, workspace=self.repo, store=self.tools), ())

    def test_run_validation_commands_spawns_every_command_through_the_wrapper(self) -> None:
        # The seam: `run_validation_commands` hands every command's argv
        # (and the environment it spawns with) to the wrapper and executes
        # what comes back; the hash-bound log records the wrapped argv.
        import sys

        from aria_kernel.change_ledger import emit_change_planned
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.validation import run_validation_commands
        from aria_kernel.validation_runs_ledger import _validation_log_path, verify_validation_run

        set_profile("strict", operator_approval_ref="test:wrapper", base_dir=self.tools, set_by="operator", scheduler_ceiling="strict")
        emit_change_planned(
            plan_id="plan-w", finding_id="F-1", intended_affected_files=["src/app.ts"],
            intended_validation_refs=["npm run type-check"], architectural_tier=1, base_dir=self.tools,
        )
        head = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        seen: list[tuple[list[str], str | None]] = []

        def wrap(argv: list[str], environment) -> list[str]:
            seen.append((list(argv), environment.get("PATH")))
            return [sys.executable, "-c", "import sys; print('wrapped', sys.argv[1:])", *argv]

        from aria_kernel.ledger import load_declared_jsonl

        change_id = load_declared_jsonl(self.tools / "change-ledger" / "planned.jsonl", expected_surface="change_planned")[-1]["change_id"]
        group = run_validation_commands(
            commands=["npm run type-check", "npx nx affected --target=lint"], workspace_root=self.repo,
            change_id=change_id, commit_sha=head, runner_identity="test", base_dir=self.tools,
            timeout_ms=60_000, spawn_wrapper=wrap,
        )
        self.assertEqual([argv for argv, _path in seen], [["npm", "run", "type-check"], ["npx", "nx", "affected", "--target=lint"]])
        self.assertTrue(all(path for _argv, path in seen))
        self.assertEqual(group["status"], "ok")
        for run_id, command in zip(group["validation_run_ids"], ["npm run type-check", "npx nx affected --target=lint"]):
            row = verify_validation_run(run_id, base_dir=self.tools)
            log = Path(_validation_log_path(row, base_dir=self.tools)).read_text(encoding="utf-8")
            self.assertIn(f"argv: [{sys.executable!r}, '-c'", log)
            self.assertIn(f"wrapped {command.split()!r}", log)
            self.assertEqual(row["exit_code"], 0)


class ResultAdmissibilityTests(_DeliveredBranch):
    """ARIA-HIGH-124 (round 5) — the kernel decides the envelope BEFORE the
    delivery spends any authority.

    Until round 5 the first time the kernel decided an implementation
    envelope was inside the submit — after the push and the PR. The
    delivery now runs the submit's own chain (``judge_claim_submission``)
    against the published tip, after the scope verdict and before the
    suite, the push and the ``gh`` call; the parity pin below submits the
    same envelope through ``submit_claim_result`` and reads the same codes.
    """

    def setUp(self) -> None:
        from aria_kernel.agent_invocations import claim_request
        from aria_kernel.change_ledger import emit_change_planned
        from aria_kernel.implementation_safety import sandbox_backend
        from tests._helpers.production_shaped import production_implementation_request

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        super().setUp()
        # A request minted by production's bridge (the strict view needs
        # its must_satisfy and allowed_scope), claimed the way the executor
        # claims it, and a planned change that intends the file the tip
        # touched, so the scope verdict admits the diff and the decision is
        # the next thing the delivery asks.
        self.request = production_implementation_request(
            tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-admissible",
            allowed_path="src/app.ts", base_sha=self.base,
        )
        self.claim = claim_request(request_id=self.request["request_id"], agent_id="aria-implementer", base_dir=self.tools)
        planned = emit_change_planned(
            plan_id="plan-admissible", finding_id="F-admissible", intended_affected_files=["src/app.ts"],
            intended_validation_refs=[], architectural_tier=1, base_dir=self.tools,
        )
        self.ids = {**self.ids, "change_id": planned["change_id"]}
        self.output = Path(self.request["expected_output_path"])

    def _envelope(self, *, evidence_ref: str) -> dict:
        matrix = [{"id": item["id"], "verdict": "satisfied", "evidence_refs": [evidence_ref]}
                  for item in self.request["must_satisfy"]]
        return {
            "$schema": "aria/agent-response/v1", "request_id": self.request["request_id"],
            "claim_id": self.claim["claim_id"], "agent_id": self.claim["agent_id"], "role": "implementation",
            "status": "submitted", "satisfaction_matrix": matrix, "evidence_refs": [evidence_ref],
            "details": {"implementation": {}},
        }

    def _deliver_envelope(self, envelope: dict, **overrides: object) -> ImplementationDeliveryRefusal:
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text(json.dumps(envelope), encoding="utf-8")
        return self._deliver(
            request_id=self.request["request_id"], claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
            envelope=envelope, output_path=self.output, **overrides,
        )

    def _assert_nothing_ran_after_the_decision(self) -> None:
        self.assertFalse((self.tools / "apply").exists(), "the suite ran for an envelope the kernel rejects")
        self.assertFalse((self.tools / "validation").exists())
        self.assertFalse((self.tools / "recovery").exists())
        self.assertFalse((self.tools / "pr-lifecycle.jsonl").exists())
        self.assertFalse((self.tools / "change-ledger" / "committed.jsonl").exists())

    def test_an_envelope_the_kernel_would_reject_is_refused_before_the_suite_the_push_and_the_pr(self) -> None:
        from aria_kernel.agent_invocations import submit_claim_result

        envelope = self._envelope(evidence_ref="src/app.ts:4000")
        refused = self._deliver_envelope(envelope)
        self.assertEqual(refused.stage, delivery.RESULT_ADMISSIBLE_STAGE)
        self.assertTrue(refused.reason.startswith("result_rejected:agent_evidence_line_missing:reasons="), refused.reason)
        self._assert_nothing_ran_after_the_decision()
        # PARITY: the submit, on the same envelope at the same worktree,
        # decides the same thing with the same codes — one chain, two
        # call sites.
        submitted = submit_claim_result(
            claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"], lease_token=self.claim["lease_token"],
            output_path=self.output, workspace_root=self.repo, base_dir=self.tools, evidence_target_sha="auto",
        )
        self.assertEqual(submitted["status"], "rejected")
        self.assertEqual(set(submitted["rejection_codes"]), {"agent_evidence_line_missing"})
        self.assertEqual(len(submitted["rejection_codes"]), len(self.request["must_satisfy"]) + 1)

    def test_an_admissible_envelope_passes_the_stage_and_the_delivery_moves_on(self) -> None:
        # The positive half: the evidence cites a line the file has; the
        # delivery stops at the gate (nothing is staged), never at the
        # decision. `judge_claim_submission` itself admits it, and writes
        # nothing doing so.
        from aria_kernel.agent_invocations import find_request, judge_claim_submission

        envelope = self._envelope(evidence_ref="src/app.ts:1")
        before = sorted(str(path.relative_to(self.tools)) for path in self.tools.rglob("*") if path.is_file())
        judgment = judge_claim_submission(
            root=self.tools, claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
            request=find_request(self.tools, self.request["request_id"]), envelope=envelope, output=self.output,
            workspace_root=self.repo, evidence_target_sha="auto",
        )
        self.assertTrue(judgment.admitted, judgment)
        self.assertFalse(judgment.undecided)
        self.assertIsNotNone(judgment.compliance)
        after = sorted(str(path.relative_to(self.tools)) for path in self.tools.rglob("*") if path.is_file())
        self.assertEqual(before, after, "the judgment writes nothing")
        refused = self._deliver_envelope(envelope)
        self.assertEqual(refused.stage, "apply_gate", refused.reason)
        self.assertTrue(refused.reason.startswith("gate_refused:"), refused.reason)

    def test_a_decision_the_kernel_could_not_reach_is_the_hosts(self) -> None:
        # Every code a verification-unavailable one: the submit would journal
        # no row and the executor would release harness-class; the delivery
        # refuses at the `admission` stage, which the executor releases the
        # same way.
        from aria_kernel import agent_invocations
        from aria_kernel.agent_invocations import ClaimSubmissionJudgment
        from aria_kernel.evidence_validator import AGENT_EVIDENCE_VERIFICATION_UNAVAILABLE_CODE

        undecided = ClaimSubmissionJudgment(
            reasons=("evidence: probe did not answer",), rejection_codes=(AGENT_EVIDENCE_VERIFICATION_UNAVAILABLE_CODE,),
            revalidation={"errors": [], "checked_refs": []}, compliance=None,
        )
        self.assertTrue(undecided.undecided)
        with mock.patch.object(agent_invocations, "judge_claim_submission", return_value=undecided):
            refused = self._deliver_envelope(self._envelope(evidence_ref="src/app.ts:1"))
        self.assertEqual(refused.stage, delivery.ADMISSION_STAGE)
        self.assertEqual(refused.reason, f"evidence_verification_unavailable:{AGENT_EVIDENCE_VERIFICATION_UNAVAILABLE_CODE}")
        self._assert_nothing_ran_after_the_decision()

    def test_a_request_row_the_kernel_cannot_read_is_refused_at_the_decision(self) -> None:
        # The request row is the kernel's reading (`find_request`), never the
        # executor's copy: a request the ledger does not hold refuses here.
        refused = self._deliver(envelope=self._envelope(evidence_ref="src/app.ts:1"), output_path=self.output,
                                request_id="AIR-nobody", claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"])
        self.assertEqual(refused.stage, delivery.RESULT_ADMISSIBLE_STAGE)
        self.assertTrue(refused.reason.startswith("judgment_refused:agent invocation request not found"), refused.reason)

    def test_the_stage_is_priced_and_the_dispositions_are_read_off_the_envelope(self) -> None:
        from aria_kernel.evidence_probe import EVIDENCE_VERIFICATION_LIVENESS_SECONDS

        self.assertEqual(delivery.DELIVERY_RESULT_ADMISSIBLE_SECONDS, int(EVIDENCE_VERIFICATION_LIVENESS_SECONDS))
        # The one delivery fact the agent contributes is read off the SAME
        # envelope the decision judges (the separate argument is gone).
        import inspect

        parameters = inspect.signature(deliver_implementation).parameters
        self.assertIn("envelope", parameters)
        self.assertIn("agent_id", parameters)
        self.assertIn("output_path", parameters)
        self.assertNotIn("uncovered_intended_dispositions", parameters)


class ValidationTimeoutStopsTheWholeTreeTests(unittest.TestCase):
    """ARIA-HIGH-124 (round 4) — a validation command that hits its ceiling
    is STOPPED, contained or not.

    ``subprocess.run(..., timeout=…)`` SIGKILLs exactly the pid it spawned.
    With the round-3 wrapper that pid is ``bwrap``, which (without
    ``--unshare-pid``/``--die-with-parent``) does not take its children
    down: the gate recorded ``timed_out``, moved to the next command at its
    own 45-minute ceiling, refused the delivery — and the agent's suite
    kept running on the shared runner, unbounded and outside the pricing
    the drain window rests on. Unwrapped (the cycle's baseline) the direct
    child died and its own children were orphaned the same way.

    Measured here, on the host: after the run, no process of the command's
    tree survives."""

    def setUp(self) -> None:
        import secrets

        from aria_kernel.change_ledger import emit_change_planned
        from aria_kernel.implementation_safety import sandbox_backend
        from aria_kernel.ledger import load_declared_jsonl as _load
        from aria_kernel.runtime_profile import set_profile

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-timeout-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        # The sleeper's own marker: a duration no other process on this host
        # is sleeping for, so `/proc` tells the truth about survivors.
        self.marker = str(100_000 + secrets.randbelow(800_000))
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.head = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        # The suite, as the AGENT's tree provides it: `npm` backgrounds a
        # sleeper and then blocks far past the ceiling.
        self.toolchain = self.root / "toolchain" / "bin"
        self.toolchain.mkdir(parents=True)
        npm = self.toolchain / "npm"
        npm.write_text(
            f"#!{sys.executable}\n"
            "import subprocess, sys, time\n"
            f"subprocess.Popen(['sleep', {self.marker!r}])\n"
            "sys.stdout.write('suite started\\n'); sys.stdout.flush()\n"
            "time.sleep(600)\n",
            encoding="utf-8",
        )
        npm.chmod(0o755)
        self.addCleanup(self._kill_survivors)
        set_profile("strict", operator_approval_ref="test:timeout", base_dir=self.tools, set_by="operator",
                    scheduler_ceiling="strict")
        emit_change_planned(
            plan_id="plan-timeout", finding_id="F-1", intended_affected_files=["src/app.ts"],
            intended_validation_refs=["npm run type-check"], architectural_tier=1, base_dir=self.tools,
        )
        self.change_id = _load(self.tools / "change-ledger" / "planned.jsonl",
                               expected_surface="change_planned")[-1]["change_id"]

    def _survivors(self) -> list[int]:
        """The pids on THIS host still running the sleeper of this test."""
        found: list[int] = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes().split(b"\0")
            except OSError:
                continue
            if cmdline[:1] == [b"sleep"] and self.marker.encode() in cmdline[1:2]:
                found.append(int(entry.name))
        return found

    def _kill_survivors(self) -> None:
        import os as _os
        import signal as _signal

        for pid in self._survivors():
            try:
                _os.kill(pid, _signal.SIGKILL)
            except OSError:
                pass

    def _assert_timed_out_and_nothing_survives(self, group: dict) -> None:
        import time as _time

        from aria_kernel.validation_runs_ledger import verify_validation_run

        rows = [verify_validation_run(run_id, base_dir=self.tools) for run_id in group["validation_run_ids"]]
        self.assertEqual([row["timed_out"] for row in rows], [True], rows)
        # The kill is synchronous (the runner reaps within its grace), so a
        # short settle is enough for the tree's exit to reach `/proc`.
        deadline = _time.monotonic() + 5
        while self._survivors() and _time.monotonic() < deadline:
            _time.sleep(0.1)
        self.assertEqual(self._survivors(), [], "the timed-out command's tree outlived the run")

    def _run(self, *, spawn_wrapper) -> dict:
        import os as _os

        from aria_kernel.validation import run_validation_commands

        with mock.patch.dict(_os.environ, {"PATH": f"{self.toolchain}:{_os.environ.get('PATH', '')}"}):
            return run_validation_commands(
                commands=["npm run type-check"], workspace_root=self.repo, change_id=self.change_id,
                commit_sha=self.head, runner_identity="test", base_dir=self.tools, timeout_ms=2000,
                spawn_wrapper=spawn_wrapper,
            )

    def test_a_contained_command_at_its_ceiling_leaves_no_process_behind(self) -> None:
        group = self._run(spawn_wrapper=delivery.validation_sandbox_for(self.repo, store=self.tools))
        self._assert_timed_out_and_nothing_survives(group)

    def test_an_uncontained_command_at_its_ceiling_leaves_no_process_behind(self) -> None:
        # The baseline's shape (no wrapper): the process GROUP is what the
        # runner kills, so the command's own children go with it.
        group = self._run(spawn_wrapper=None)
        self._assert_timed_out_and_nothing_survives(group)

    def test_the_wrapper_and_the_probe_carry_the_flags_that_make_the_kill_total(self) -> None:
        import os as _os

        from aria_kernel.implementation_safety import (
            VALIDATION_SANDBOX_CONTAINMENT_FLAGS,
            _bwrap_probe_argv,
            wrap_validation_in_sandbox,
        )
        from aria_kernel.validation_env import build_validation_env

        environment = build_validation_env({**_os.environ, "PATH": f"{self.toolchain}:{_os.defpath}"}).env
        argv = wrap_validation_in_sandbox(["npm", "run", "type-check"], workspace_root=self.repo, git=None,
                                          environment=environment, store=self.tools)
        prefix = argv[:argv.index("--")]
        self.assertEqual(VALIDATION_SANDBOX_CONTAINMENT_FLAGS, ("--unshare-pid", "--die-with-parent"))
        for flag in VALIDATION_SANDBOX_CONTAINMENT_FLAGS:
            self.assertIn(flag, prefix)
            # A host that cannot build them is refused BEFORE a claim: the
            # probe is as strict as the strictest wrapper.
            self.assertIn(flag, _bwrap_probe_argv())


class ValidationSandboxHostsTheObservationChildTests(unittest.TestCase):
    """ARIA-HIGH-124 (round 4) — a recipe with an execution profile runs
    INSIDE the sandbox too.

    ``validation._run_one`` composes the spawn as ``[<python>, <the kernel's
    private observation child>, …]`` when a registered recipe's
    ``input_scope`` carries an execution profile, resolving that script from
    the CODE root — which the validation sandbox binds nothing of. Such a
    recipe therefore died inside with ``can't open file``, the gate blocked,
    and the delivery escalated a HUMAN_REQUIRED for a missing mount. The one
    file is ro-bound; the kernel package stays outside (the child imports
    none of it by design)."""

    def setUp(self) -> None:
        from aria_kernel.implementation_safety import sandbox_backend

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-observer-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def test_the_child_the_runner_spawns_is_readable_inside_the_sandbox(self) -> None:
        import os

        from aria_kernel import validation
        from aria_kernel.implementation_safety import VALIDATION_OBSERVATION_CHILD, wrap_validation_in_sandbox
        from aria_kernel.validation_env import build_validation_env

        # The path the runner composes and the path the wrapper binds are
        # one fact, not two.
        composed = Path(validation.__file__).with_name("_validation_unittest_child.py")
        self.assertEqual(VALIDATION_OBSERVATION_CHILD, composed)
        self.assertTrue(composed.is_file())
        environment = build_validation_env(dict(os.environ)).env
        probe = (
            "import pathlib, sys\n"
            f"sys.exit(0 if pathlib.Path({str(composed)!r}).is_file() else 3)\n"
        )
        argv = wrap_validation_in_sandbox(
            [sys.executable, "-c", probe], workspace_root=self.repo, git=None,
            environment=environment, store=self.tools,
        )
        self.assertIn(str(composed), argv[:argv.index("--")])
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 0,
                         f"the observation child is not reachable inside the sandbox: {completed.stderr[-400:]}")
        # And nothing else of the kernel package rides with it.
        kernel_package = composed.parent
        self.assertNotIn(str(kernel_package), argv[:argv.index("--")])


class ReleaseReasonTests(unittest.TestCase):
    def test_the_executor_tables_spell_the_kernels_reasons(self) -> None:
        import ci_executor
        from aria_kernel.agent_invocations import classify_release_reason
        from aria_kernel.release_reason import (
            IMPLEMENTATION_BRANCH_COLLISION,
            IMPLEMENTATION_DELIVERY_REFUSED_PREFIX,
            IMPLEMENTATION_DELIVERY_UNAVAILABLE,
            IMPLEMENTATION_REQUEST_INVALID,
            parse_release_reason,
        )

        self.assertEqual(ci_executor.DELIVERY_CREDENTIAL_REFUSAL.release_reason, IMPLEMENTATION_DELIVERY_UNAVAILABLE)
        self.assertEqual(ci_executor.IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.release_reason, IMPLEMENTATION_BRANCH_COLLISION)
        # (round 2) a request row whose implementation_ids cannot stand a
        # sandbox is the request's fault: request-class, not retried.
        self.assertEqual(ci_executor.IMPLEMENTATION_REQUEST_INVALID_REFUSAL.release_reason, IMPLEMENTATION_REQUEST_INVALID)
        self.assertEqual((ci_executor.IMPLEMENTATION_REQUEST_INVALID_REFUSAL.failure_class,
                          ci_executor.IMPLEMENTATION_REQUEST_INVALID_REFUSAL.retryable), ("policy_violation", False))
        self.assertEqual(classify_release_reason(IMPLEMENTATION_REQUEST_INVALID), "request")
        self.assertEqual(ci_executor.IMPLEMENTATION_REQUEST_INVALID_CONTAINMENT_REASONS,
                         frozenset({"implementation_branch_name_invalid", "base_sha_not_an_object_id"}))
        self.assertEqual((ci_executor.DELIVERY_CREDENTIAL_REFUSAL.failure_class, ci_executor.DELIVERY_CREDENTIAL_REFUSAL.retryable),
                         ("harness_unavailable", True))
        self.assertEqual((ci_executor.IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.failure_class,
                          ci_executor.IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.retryable), ("policy_violation", False))
        self.assertEqual(classify_release_reason(IMPLEMENTATION_DELIVERY_UNAVAILABLE), "harness")
        self.assertEqual(classify_release_reason(IMPLEMENTATION_BRANCH_COLLISION), "request")
        for stage in DELIVERY_STAGES:
            reason = IMPLEMENTATION_DELIVERY_REFUSED_PREFIX + stage
            self.assertEqual(classify_release_reason(reason), "request")
            parsed = parse_release_reason(reason)
            self.assertEqual((parsed.reason_code, parsed.reason_detail, parsed.fault_domain),
                             ("IMPLEMENTATION_DELIVERY_REFUSED", stage, "request"))
        # The executor spells the prefix the way the kernel owns it.
        source = (_POC_DIR / "ci_executor.py").read_text(encoding="utf-8")
        self.assertIn('reason=f"implementation_delivery_refused:{exc.stage}"', source)
        self.assertEqual(IMPLEMENTATION_DELIVERY_REFUSED_PREFIX, "implementation_delivery_refused:")


if __name__ == "__main__":
    unittest.main()


class CredentialIsMintedWhereItIsConsumedTests(unittest.TestCase):
    """ARIA-HIGH-124 (round 6) — the delivery credential's life is the push
    and the PR, not the request.

    Until round 6 the executor minted the ONE lease before the spawn and
    the delivery consumed it after the spawn, the publication, the
    decisions and the contained gate — priced at
    ``IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS`` after the mint — while a
    GitHub App installation token lives exactly one hour whatever the mint
    asks. In Mode A every implementation whose spawn and suite ran past
    ~55 minutes pushed with a dead token (``push_failed:rc=128``) and was
    escalated as the REQUEST's fault. The whole chain runs here in process
    against a staged action, a fixture remote whose receive hook records
    when the push arrived and what credential it carried, a fixture ``gh``
    that records the same, and a minter that records when it minted and
    what horizon the provider gave.
    """

    def setUp(self) -> None:
        from aria_kernel.agent_invocations import claim_request
        from aria_kernel.implementation_safety import sandbox_backend
        from aria_kernel.knowledge_graph import register_convention_signer
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.production_shaped import production_staged_implementation_request

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-credential-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = "apps/farm-service/src/sample-interval.ts"
        # The checkout, clean for the staging's baseline: the reviewer the
        # production-shaped plan names is committed byte-identical to what
        # the helper writes; the store and the keys are ignored.
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "aria-tools/\naria-debts/keys/\nnode_modules/\n",
            self.source: "export const sampleIntervalMs = 60000;\n",
            ".claude/agents/farm-expert.md": "\n".join([
                "---", "name: farm-expert", "description: Fixture reviewer.", "---", "", "Owns `apps/farm-service/**`.",
            ]),
        }, name="checkout")
        (self.repo / "node_modules").mkdir()
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        self.base = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        # The fixture remote: a bare repository whose receive hook records
        # WHEN the push arrived and WHICH credential names rode it (the
        # pusher's environment reaches a local receive-pack).
        self.remote = self.root / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        _git(["remote", "add", "origin", str(self.remote)], cwd=self.repo)
        self.push_log = self.root / "push-calls.jsonl"
        self._install_hook(self.remote / "hooks" / "pre-receive", (
            "import json, os, sys, time\n"
            f"with open({str(self.push_log)!r}, 'a', encoding='utf-8') as log:\n"
            "    log.write(json.dumps({'time': time.time(), 'refs': sys.stdin.read().split(),\n"
            "        'credential_names': sorted(n for n in os.environ if n in ('GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'))}) + '\\n')\n"
        ))
        # A pre-push hook in the CHECKOUT (what a `core.hooksPath` or a
        # `.git/hooks` install would give the executor's push): it must
        # never run for the kernel's own push, whatever it would do.
        self.hook_marker = self.root / "pre-push-ran"
        self._install_hook(self.repo / ".git" / "hooks" / "pre-push", (
            f"open({str(self.hook_marker)!r}, 'w').write('ran')\nraise SystemExit(1)\n"
        ))
        # The canonical suite, answered, and a `gh` that records when it was
        # called and which credential names it saw.
        self.fixture_bin = self.root / "fixture-bin"
        self.fixture_bin.mkdir()
        for name in ("npx", "npm"):
            self._install_executable(name, "print('ok')\n")
        self.gh_log = self.root / "gh-calls.jsonl"
        self._install_executable("gh", (
            "import json, os, sys, time\n"
            f"with open({str(self.gh_log)!r}, 'a', encoding='utf-8') as log:\n"
            "    log.write(json.dumps({'time': time.time(), 'argv': sys.argv[1:],\n"
            "        'credential_names': sorted(n for n in os.environ if n in ('GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'))}) + '\\n')\n"
            "print('https://github.com/fixture/aria-high-124/pull/6'); raise SystemExit(0)\n"
        ))
        self.environ = mock.patch.dict("os.environ", {
            "PATH": f"{self.fixture_bin}:{os.defpath}", "ARIA_TOOLS_DIR": str(self.tools),
        })
        self.environ.start()
        self.addCleanup(self.environ.stop)
        os.environ.pop("ARIA_DRY_RUN", None)
        os.environ.pop("GH_TOKEN", None)
        # The request, STAGED by production's producer (the baseline runs
        # through the fixture suite in this process), then claimed.
        self.request = production_staged_implementation_request(
            tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-credential", allowed_path=self.source,
            cycle_id=CYCLE_ID,
        )
        self.ids = self.request["implementation_ids"]
        self.claim = claim_request(request_id=self.request["request_id"], agent_id="aria-implementer", base_dir=self.tools)
        # The identity the executor would hold: registered under the
        # request's cycle; the tip is signed with it on the staged branch.
        keys = self.root / "keys"
        keys.mkdir()
        self.kernel_key, kernel_public, self.fingerprint = _mint_signing_key(keys, "cycle")
        register_convention_signer(cycle_id=CYCLE_ID, signer_key_fp=self.fingerprint, public_key=kernel_public, base_dir=self.tools)
        _git(["switch", "-q", "-c", self.ids["branch"], self.base], cwd=self.repo)
        contract = self.request["commit_contract"]
        message = f"{contract['commit_types'][0]}(farm-service): halve the sample interval\n\nWHY: the plan says so.\n" + (
            f"\n{contract['trailer']}\n" if contract["trailer"] else ""
        )
        self.tip = _commit_signed_with(self.repo, self.kernel_key, message=message, path=self.source,
                                       body="export const sampleIntervalMs = 30000;\n")
        self.output = Path(self.request["expected_output_path"])
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.envelope = {
            "$schema": "aria/agent-response/v1", "request_id": self.request["request_id"],
            "claim_id": self.claim["claim_id"], "agent_id": self.claim["agent_id"], "role": "implementation",
            "status": "submitted", "evidence_refs": [f"{self.source}:1"],
            "satisfaction_matrix": [{"id": item["id"], "verdict": "satisfied", "evidence_refs": [f"{self.source}:1"]}
                                    for item in self.request["must_satisfy"]],
            "details": {"implementation": {}},
        }
        self.output.write_text(json.dumps(self.envelope), encoding="utf-8")
        self.profile = SimpleNamespace(external_writes=True, profile_id="implementer")
        self.mints: list[dict] = []
        self.revokes: list[dict] = []

    def _install_hook(self, path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        path.chmod(0o755)

    def _install_executable(self, name: str, body: str) -> None:
        self._install_hook(self.fixture_bin / name, body)

    def _minter(self, *, horizon_seconds: int):
        from datetime import datetime, timedelta, timezone

        from aria_kernel.gh_token_factory import InstallationTokenLease

        def mint(*, cycle_id, workspace_root, ttl_seconds, token_dir, **_ignored):  # noqa: ANN001 — the factory's shape
            now = datetime.now(timezone.utc)
            token_file = Path(token_dir) / f"{cycle_id}.token"
            token_file.write_text("ghs_fixture_delivery_token", encoding="utf-8")
            token_file.chmod(0o600)
            expiry = (now + timedelta(seconds=horizon_seconds)).isoformat()
            self.mints.append({"time": now.timestamp(), "ttl_seconds": ttl_seconds, "provider_expiry": expiry})
            return InstallationTokenLease(
                cycle_id=cycle_id, token_file=token_file, ttl_seconds=ttl_seconds, gh_app_installation_id="42",
                fallback_active=False, minted_at_utc=now.isoformat(), provider_expiry=expiry,
            )

        return mint

    def _revoker(self):
        import time as _time

        def revoke(*, lease, environment):  # noqa: ANN001 — the factory's shape
            self.revokes.append({"time": _time.time(), "token": (environment or {}).get("GH_TOKEN"), "cycle_id": lease.cycle_id})
            return "revoked"

        return revoke

    def _deliver(self, *, horizon_seconds: int):
        from aria_kernel import delivery_credentials as dcred

        with mock.patch.object(dcred, "mint_installation_token", self._minter(horizon_seconds=horizon_seconds)), \
                mock.patch.object(dcred, "revoke_installation_token", self._revoker()):
            return deliver_implementation(
                request_id=self.request["request_id"], claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
                cycle_id=CYCLE_ID, signer_key_fp=self.fingerprint, implementation_ids=self.ids,
                envelope=self.envelope, output_path=self.output, workspace_root=self.repo, base_dir=self.tools,
                publication=_published(self.ids["branch"], adopted=self.ids["branch"]), profile=self.profile,
            )

    def _gate_runs(self) -> list[dict]:
        from aria_kernel.apply_engine import latest_apply_action
        from aria_kernel.validation import _find_comparison, _find_plan, list_validation_comparisons, list_validation_plans
        from aria_kernel.validation_runs_ledger import verify_validation_run

        action = latest_apply_action(proposal_id=self.ids["proposal_id"], base_dir=self.tools)
        assert action is not None
        comparison = _find_comparison(list_validation_comparisons(base_dir=self.tools), str(action["validation_comparison_ref"]))
        group = _find_plan(list_validation_plans(base_dir=self.tools), str(comparison["worktree_ref"]))
        return [verify_validation_run(str(run_id), base_dir=self.tools) for run_id in group["validation_run_ids"]]

    def _governance(self, kind: str) -> list[dict]:
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        return [row for row in rows if row.get("kind") == kind]

    @staticmethod
    def _epoch(stamp: str) -> float:
        from datetime import datetime, timezone

        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()

    def _log(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()] if path.exists() else []

    def test_the_push_and_the_pr_see_a_credential_minted_after_the_gate_whose_horizon_outlives_them(self) -> None:
        from aria_kernel.delivery_credentials import DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS
        from aria_kernel.gh_token_factory import PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS

        delivered = self._deliver(horizon_seconds=PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS)
        self.assertEqual((delivered.pr_url, delivered.pr_number, delivered.branch_tip_sha),
                         ("https://github.com/fixture/aria-high-124/pull/6", 6, self.tip))
        # ONE mint, made AFTER every run the gate recorded had completed:
        # the lease's life starts where its consumption starts.
        self.assertEqual(len(self.mints), 1, self.mints)
        mint = self.mints[0]
        runs = self._gate_runs()
        self.assertEqual(len(runs), 4, runs)
        for run in runs:
            self.assertGreaterEqual(mint["time"], self._epoch(run["completed_at"]), run)
        self.assertEqual(mint["ttl_seconds"], DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS)
        # The push carried the credential, after the mint; the receive hook
        # saw the branch and the credential NAMES.
        pushes = self._log(self.push_log)
        self.assertEqual(len(pushes), 1, pushes)
        self.assertGreater(pushes[0]["time"], mint["time"])
        # (git clears `GIT_CONFIG_COUNT` — a local-repository variable —
        # for the receive-pack it spawns; the token and the helper's
        # key/value ride through.)
        self.assertLessEqual({"GH_TOKEN", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"}, set(pushes[0]["credential_names"]))
        self.assertIn(f"refs/heads/{self.ids['branch']}", pushes[0]["refs"])
        self.assertEqual(_git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.remote).stdout.strip(), self.tip)
        # The PR opener carried it too, after the push.
        gh_calls = self._log(self.gh_log)
        self.assertEqual(len(gh_calls), 1, gh_calls)
        self.assertGreater(gh_calls[0]["time"], pushes[0]["time"])
        self.assertEqual(gh_calls[0]["argv"][:2], ["pr", "create"])
        self.assertEqual(gh_calls[0]["credential_names"], ["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
        # The provider's horizon POSTDATES both consumers — by construction,
        # since it was minted right before them — and the gate's end.
        horizon = self._epoch(mint["provider_expiry"])
        self.assertGreater(horizon, gh_calls[0]["time"])
        self.assertGreater(horizon, pushes[0]["time"])
        self.assertGreater(horizon - mint["time"], DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS)
        # Revoked right after the PR opened, under its own value, before
        # the delivery returned.
        self.assertEqual(len(self.revokes), 1, self.revokes)
        self.assertGreater(self.revokes[0]["time"], gh_calls[0]["time"])
        self.assertEqual(self.revokes[0]["token"], "ghs_fixture_delivery_token")
        # The ledger: issued for the DELIVERY, with the mint instant, the
        # window and the horizon; revoked; never the value; and nothing of
        # it in this process's environment.
        issued = self._governance("delivery_credential_issued")
        self.assertEqual([row["details"]["consumer"] for row in issued], ["executor_delivery"])
        self.assertEqual(issued[0]["details"]["covers_seconds"], DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS)
        self.assertEqual(issued[0]["details"]["provider_expiry"], mint["provider_expiry"])
        self.assertAlmostEqual(self._epoch(issued[0]["details"]["minted_at_utc"]), mint["time"], places=3)
        self.assertEqual([row["details"]["outcome"] for row in self._governance("delivery_credential_revoked")], ["revoked"])
        self.assertNotIn("ghs_fixture_delivery_token", (self.tools / "governance.jsonl").read_text(encoding="utf-8"))
        self.assertNotIn("GH_TOKEN", os.environ)
        # The checkout's own pre-push hook never ran: the kernel's push runs
        # with hooks off, whatever the tree or the runner's config installs.
        self.assertFalse(self.hook_marker.exists(), "the executor's push ran the checkout's pre-push hook")

    def test_a_horizon_that_cannot_cover_the_push_and_the_pr_is_refused_after_the_gate_with_nothing_pushed(self) -> None:
        from aria_kernel.delivery_credentials import DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS

        with self.assertRaises(ImplementationDeliveryRefusal) as refused:
            self._deliver(horizon_seconds=DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS // 2)
        self.assertEqual(refused.exception.stage, delivery.CREDENTIAL_STAGE)
        self.assertIn(delivery.CREDENTIAL_STAGE, delivery.HOST_STAGES)
        self.assertTrue(refused.exception.reason.startswith(
            "credential_unavailable:delivery_credential_unavailable:provider_expiry_short:expires_at="), refused.exception.reason)
        # The gate ran (the refusal is where the lease is minted, after it);
        # the lease was revoked under its own value; nothing was pushed, no
        # `gh` ran, the checkout's branch stands unpushed.
        self.assertEqual([run["exit_code"] for run in self._gate_runs()], [0, 0, 0, 0])
        self.assertEqual(len(self.mints), 1)
        self.assertEqual([row["token"] for row in self.revokes], ["ghs_fixture_delivery_token"])
        self.assertEqual(self._log(self.push_log), [])
        self.assertEqual(self._log(self.gh_log), [])
        self.assertEqual(_git(["show-ref", f"refs/heads/{self.ids['branch']}"], cwd=self.remote, check=False).returncode, 1)
        self.assertEqual(self._governance("delivery_credential_issued"), [])
        refusals = self._governance("delivery_credential_refused")
        self.assertEqual([row["details"]["error_class"] for row in refusals], ["ProviderHorizonShort"])
        self.assertEqual(refusals[0]["details"]["consumer"], "executor_delivery")
        self.assertFalse((self.tools / "pr-lifecycle.jsonl").exists())
        self.assertFalse(self.hook_marker.exists())

    def test_a_patch_that_carries_a_secret_shaped_string_is_refused_before_the_suite_the_mint_and_the_push(self) -> None:
        # ARIA-HIGH-124 (round 6) — the branch's WHOLE diff is scanned by
        # the delivery (`verify_no_secret_in_diff`, the V9.0-D check whose
        # docstring promised to run before `gh pr create` and which nothing
        # called on a diff: the contract asked the AGENT to call it, a
        # Python function it cannot execute). A secret-shaped string in the
        # commit refuses at the result's admissibility — the request's —
        # before the suite runs, before any lease is minted, with nothing
        # pushed and no `gh`; the reason carries counts, never the value.
        from aria_kernel.apply_engine import latest_apply_action

        leaked = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
        self.assertEqual(len(leaked), 40)
        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        self.tip = _commit_signed_with(self.repo, self.kernel_key, message="feat(farm-service): leak", path=self.source,
                                       body=f"export const sampleIntervalMs = 30000; // {leaked}\n")
        with self.assertRaises(ImplementationDeliveryRefusal) as refused:
            self._deliver(horizon_seconds=3600)
        self.assertEqual(refused.exception.stage, delivery.RESULT_ADMISSIBLE_STAGE)
        self.assertTrue(refused.exception.reason.startswith("diff_secret_shaped:secret pattern hits (counts only, values REDACTED):"),
                        refused.exception.reason)
        self.assertNotIn(leaked, refused.exception.reason)
        self.assertEqual(self.mints, [], "no lease is minted for a patch the kernel refuses")
        self.assertEqual(self._log(self.push_log), [])
        self.assertEqual(self._log(self.gh_log), [])
        action = latest_apply_action(proposal_id=self.ids["proposal_id"], base_dir=self.tools)
        assert action is not None
        self.assertNotEqual(action.get("status"), "ready_for_pr", "the suite never ran")
        self.assertFalse((self.tools / "change-ledger" / "committed.jsonl").exists())
        self.assertNotIn(delivery.RESULT_ADMISSIBLE_STAGE, delivery.HOST_STAGES, "a leaked secret is the request's")
        self.assertNotIn(leaked, (self.tools / "governance.jsonl").read_text(encoding="utf-8"))

    def test_a_lane_that_cannot_mint_at_the_push_is_refused_at_the_credential_stage(self) -> None:
        from aria_kernel import delivery_credentials as dcred

        with mock.patch.object(dcred, "mint_installation_token", side_effect=RuntimeError("installation refused")):
            with self.assertRaises(ImplementationDeliveryRefusal) as refused:
                deliver_implementation(
                    request_id=self.request["request_id"], claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
                    cycle_id=CYCLE_ID, signer_key_fp=self.fingerprint, implementation_ids=self.ids,
                    envelope=self.envelope, output_path=self.output, workspace_root=self.repo, base_dir=self.tools,
                    publication=_published(self.ids["branch"], adopted=self.ids["branch"]), profile=self.profile,
                )
        self.assertEqual((refused.exception.stage, refused.exception.reason),
                         (delivery.CREDENTIAL_STAGE, "credential_unavailable:delivery_credential_unavailable:RuntimeError"))
        self.assertEqual(self._log(self.push_log), [])
        self.assertEqual(self._log(self.gh_log), [])
        # And a profile without the grant mints nothing: the remote here
        # needs no credential, so the delivery lands with none.
        delivered = deliver_implementation(
            request_id=self.request["request_id"], claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
            cycle_id=CYCLE_ID, signer_key_fp=self.fingerprint, implementation_ids=self.ids,
            envelope=self.envelope, output_path=self.output, workspace_root=self.repo, base_dir=self.tools,
            publication=_published(self.ids["branch"], adopted=self.ids["branch"]), profile=None,
        )
        self.assertEqual(delivered.pr_number, 6)
        self.assertEqual(self._log(self.push_log)[0]["credential_names"], [])
        self.assertEqual(self._governance("delivery_credential_issued"), [])
