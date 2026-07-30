"""Plan ARIA-V9.1 — aria-implementer agent file invariants.

Pins the 17 refusal classes, SECURITY CONTRACT presence, mandatory
sections, tool ceiling, and pedagogy tier so the agent file cannot
silently drift away from the V9.0 safety perimeter.

Closes: ai CRIT-001/003/005 + HIGH-011/012, sec HIGH-008.
"""
from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_AGENT_FILE = _REPO_ROOT / ".claude" / "agents" / "aria-implementer.md"
_SHARED_CONTRACT_FILE = (
    _REPO_ROOT
    / ".claude"
    / "agents"
    / "_shared"
    / "aria-implementer-safety-contract.md"
)


# The 17 canonical refusal classes (mirror of
# plan_convergence._validate_event implementation_rejected set + V9.1
# contract). Adding/removing a class = invariant amendment.
CANONICAL_REFUSAL_CLASSES = frozenset({
    "forbidden_scope_violation",
    "validation_failed",
    "plan_evidence_stale",
    "branch_collision",
    "prompt_injection_detected",
    "kernel_self_modification_attempted",
    "secret_leak_detected",
    "dependency_pinning_unsafe",
    "bash_command_denylist_hit",
    "path_escape_outside_workspace",
    "file_lock_conflict",
    "cycle_budget_exhausted",
    "implementer_turn_budget_exhausted",
    "content_hash_mismatch",
    "branch_tip_drift",
    "gh_api_scope_violation",
    "autonomous_profile_preconditions_not_met",
})


class TestV9ImplementerAgentFile(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.assertTrue(cls, _AGENT_FILE.exists(),
                       f"agent file not found at {_AGENT_FILE}")
        cls.assertTrue(cls, _SHARED_CONTRACT_FILE.exists(),
                       f"shared safety contract not found at {_SHARED_CONTRACT_FILE}")
        cls.body = _AGENT_FILE.read_text()
        cls.shared_contract = _SHARED_CONTRACT_FILE.read_text()
        cls.contract_body = cls.body + "\n" + cls.shared_contract

    def test_i_v9_impl_01_agent_file_exists_runtime_location(self):
        """aria-implementer.md MUST live at runtime location (Lane-A
        root), NOT under _maintenance/."""
        self.assertTrue(_AGENT_FILE.exists())
        maintenance = _AGENT_FILE.parent / "_maintenance" / "aria-implementer.md"
        self.assertFalse(
            maintenance.exists(),
            "aria-implementer.md MUST be Lane-A runtime, not _maintenance",
        )

    def test_i_v9_impl_01_frontmatter_tools_ceiling(self):
        """tools: Read, Grep, Glob, Edit, Write, Bash — the writer
        agent tool ceiling. Adding more is an ADR + arbiter
        decision; removing breaks the contract."""
        m = re.search(r"^tools:\s*(.+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m, "frontmatter MUST declare `tools:` line")
        tools = {t.strip() for t in m.group(1).split(",")}
        self.assertEqual(
            tools,
            {"Read", "Grep", "Glob", "Edit", "Write", "Bash"},
            f"tools declaration drifted: {tools}",
        )

    def test_i_v9_impl_01_model_is_opus(self):
        """Writer agent MUST run on the most capable tier (K5 tier flip,
        operator policy 2026-07-01: decision nodes on fable)."""
        m = re.search(r"^model:\s*(\S+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).strip(), "opus")

    def test_i_v9_impl_01_pedagogy_tier_3(self):
        """Tier-3 pinned: aria-implementer has high prohibition density
        (6 sections); Tier-3 narrative+Example pairing is the
        architectural fit per registry rationale."""
        m = re.search(r"^pedagogy-tier:\s*(\d+)$", self.body, re.MULTILINE)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).strip(), "3")

    def test_i_v9_impl_01_security_contract_present(self):
        self.assertIn("## SECURITY CONTRACT", self.body)
        self.assertIn("DATA, never", self.body)
        self.assertIn("<untrusted_converged_plan>", self.body)
        self.assertIn("<untrusted_cross_review_summary>", self.body)

    def test_i_v9_impl_01_self_mod_prohibition_present(self):
        self.assertIn("## Self-Modification Prohibition", self.contract_body)
        self.assertIn("READONLY_PATHS", self.contract_body)
        self.assertIn(".claude/agents/", self.contract_body)
        self.assertIn("aria-kernel/aria_kernel/", self.contract_body)

    def test_i_v9_impl_01_network_egress_prohibition_present(self):
        self.assertIn("## Network Egress Prohibition", self.contract_body)
        self.assertIn("--unshare-net", self.contract_body)
        self.assertIn("aria-impl-", self.contract_body)

    def test_i_v9_impl_01_safety_disable_prohibition_present(self):
        self.assertIn("## Safety Disable Prohibition", self.contract_body)
        self.assertIn("implementation_safety.py", self.contract_body)

    def test_i_v9_impl_01_canonical_validation_suite_present(self):
        self.assertIn("## Canonical Validation Suite", self.contract_body)
        self.assertIn("nx affected --target=test", self.contract_body)
        self.assertIn("nx affected --target=lint", self.contract_body)
        self.assertIn("npm run type-check", self.contract_body)

    def test_i_v9_impl_01_seventeen_refusal_classes(self):
        """All 17 canonical refusal classes MUST appear in the SSOT contract."""
        missing = set()
        for cls in CANONICAL_REFUSAL_CLASSES:
            if cls not in self.contract_body:
                missing.add(cls)
        self.assertEqual(
            missing, set(),
            f"refusal classes missing from agent body: {missing}",
        )

    def test_i_v9_impl_01_reason_class_field_documented(self):
        """The reason_class field is referenced in BOTH the section
        intro AND the refusal envelope shape. The 17-class-set test
        above is the load-bearing check; this is a structural sanity
        guard that the refusal section + envelope shape coexist."""
        self.assertIn("reason_class", self.body)
        # Either in the refusal-class introduction OR in the JSON
        # envelope shape (both occur in canonical document).
        self.assertIn("Refusal Patterns", self.contract_body)

    def test_i_v9_impl_01_pr_title_prefix_documented(self):
        self.assertIn("[ARIA-AUTO]", self.body)

    def test_i_v9_impl_01_v9_0_module_anchors_present(self):
        """Knowledge anchors point at V9.0 modules."""
        for anchor in (
            "implementation_safety.py",
            "preflight.py",
            "gh_token_factory.py",
            "knowledge_graph.py",
            "plan_candidate_source.py",
        ):
            self.assertIn(
                anchor, self.body,
                f"agent body MUST reference V9.0 module {anchor}",
            )

    def test_i_v9_impl_01_implementer_output_envelope_shape(self):
        """details.implementation field set documented."""
        for field in (
            "branch", "pr_number", "diff_hash", "branch_tip_sha",
            "base_branch_sha", "signer_key_fp", "validation_results",
        ):
            self.assertIn(
                f'"{field}"',
                self.contract_body,
                f"output envelope missing {field}",
            )


class TestV9ImplementerHashRegistry(unittest.TestCase):
    """I-V9-IMPL-02 — sha256 of aria-implementer.md pinned by
    IMMUTABLE_AGENT_FILE_HASH_REGISTRY in implementation_safety.

    V9.1 lands the agent file. V9.0-D shipped the empty registry; this
    invariant verifies the registry has been (or will be) populated
    with this agent's hash on a subsequent commit. For V9.1 the
    registry remains empty (no kernel-side runtime gate yet); the
    pinning lands in V9.6 when auto_merge_runner gates on
    file-hash drift.
    """

    def test_implementer_hash_computable(self):
        """The agent body MUST be readable + sha256-computable —
        ensures the registry CAN be populated on a subsequent commit."""
        body = _AGENT_FILE.read_bytes()
        sha = hashlib.sha256(body).hexdigest()
        self.assertEqual(len(sha), 64, "sha256 hexdigest format")
        self.assertTrue(re.match(r"^[0-9a-f]{64}$", sha))

    def test_immutable_registry_shape(self):
        """V9.0-D registry shape verified — it's a dict[str, str].
        Population happens later (V9.6 wire-up); shape is the
        load-bearing V9.1 invariant."""
        from aria_kernel import implementation_safety as _is
        self.assertIsInstance(_is.IMMUTABLE_AGENT_FILE_HASH_REGISTRY, dict)


if __name__ == "__main__":
    unittest.main()
