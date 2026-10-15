"""Plan ARIA-V5 §3e V5.3 Phase 5.3 — pedagogy-lint invariants.

Three invariants pin the V5.3 pedagogy universalization contract:

  * I-V5.3-01 — every ``.claude/agents/**/*.md`` (excluding READMEs)
    declares ``pedagogy-tier:`` in YAML frontmatter
  * I-V5.3-02 — pedagogy_lint accepts the current corpus under the
    warn-mode allowlist (C4 landing posture); --strict mode reports
    correct violation count for follow-up narrative work
  * I-V5.3-03 — pedagogy_lint CLI exit code matches violation
    presence (0=clean, 1=violations) AND structured JSON output
    shape matches schema for CI consumption

Operator anchor (Plan ARIA-V5 §1, verbatim):
  "agentlara yapma demek yerıne yaptıgında neler olacak neden
   yapmaması gerektıgı orneklerle acıklanmalı"
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_AGENTS_DIR = _REPO_ROOT / ".claude" / "agents"
_ALLOWLIST = _REPO_ROOT / "tests" / "invariants" / "agent-pedagogy.allowlist.json"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.pedagogy_lint import is_agent_markdown_file


class PhaseV5_3PedagogyLint(unittest.TestCase):
    # I-V5.3-01 — every agent file declares pedagogy-tier.
    def test_i_v5_3_01_every_agent_declares_pedagogy_tier(self) -> None:
        """Plan ARIA-V5 §3e v2 — universalize V4 §2a frontmatter
        discipline to all 81 agents. Every .md file (excluding
        READMEs) under .claude/agents/ MUST declare
        ``pedagogy-tier: N`` where N ∈ {1, 2, 3}.

        Pre-V5.3 only 9 ARIA agents carried the field. C4 lands
        the field on the remaining 72 (~10 Tier-1 / ~50 Tier-2 /
        ~15 Tier-3) so the operator vision ("yaptıgında neler
        olacak orneklerle acıklanmalı") applies architecturally
        across the whole agent corpus.
        """
        import re
        agent_files = sorted(
            p for p in _AGENTS_DIR.rglob("*.md")
            if is_agent_markdown_file(p, _AGENTS_DIR)
        )
        self.assertGreaterEqual(
            len(agent_files), 80,
            msg=(
                "Plan ARIA-V5 §3e v2 — agent corpus shrunk below 80; "
                "C4 baseline guard."
            ),
        )
        missing: list[tuple[str, str]] = []
        tier_rx = re.compile(r"^pedagogy-tier:\s*([123])\s*$", re.MULTILINE)
        fm_rx = re.compile(r"\A(---\n.*?\n---\n)", re.DOTALL)
        for path in agent_files:
            text = path.read_text(encoding="utf-8")
            fm_match = fm_rx.match(text)
            if not fm_match:
                missing.append((str(path.relative_to(_REPO_ROOT)), "no frontmatter"))
                continue
            tier_match = tier_rx.search(fm_match.group(1))
            if not tier_match:
                missing.append((
                    str(path.relative_to(_REPO_ROOT)),
                    "pedagogy-tier missing",
                ))
        self.assertEqual(
            missing, [],
            msg=(
                f"Plan ARIA-V5 §3e v2 — these agent files MUST declare "
                f"`pedagogy-tier: N` in YAML frontmatter:\n"
                + "\n".join(f"  {p} — {r}" for p, r in missing)
            ),
        )

    # I-V5.3-02 — lint accepts current corpus under warn-mode allowlist.
    def test_i_v5_3_02_lint_passes_under_allowlist(self) -> None:
        """Plan ARIA-V5 §3e Phase 2 — permanent enforcement.

        With ``strict=True`` (allowlist IGNORED) the lint MUST return
        ``violation_count == 0``: every agent now carries its V5 §3e
        narrative pairings, the C4 grandfather allowlist is empty, and
        a new un-narrated imperative reds the gate with no bypass.
        """
        from aria_kernel.pedagogy_lint import run_pedagogy_lint
        report = run_pedagogy_lint(
            agents_dir=_AGENTS_DIR,
            allowlist_path=_ALLOWLIST,
            strict=True,
        )
        self.assertEqual(
            report.violation_count, 0,
            msg=(
                f"Plan ARIA-V5 §3e v2 R1 — pedagogy_lint warn-mode "
                f"MUST be clean at C4 landing. Found "
                f"{report.violation_count} violations:\n"
                + "\n".join(
                    f"  {v.agent_file}:{v.line_number} — {v.reason}"
                    for v in report.violations[:10]
                )
            ),
        )
        self.assertGreaterEqual(
            report.lint_pass_rate, 0.95,
            msg=(
                f"Plan ARIA-V5 §3e v2 — lint_pass_rate must be ≥ 95% "
                f"at C4 landing (allowlist + compliant). Got "
                f"{report.lint_pass_rate:.2%}"
            ),
        )

    # I-V5.3-03 — CLI exit code + JSON output shape.
    def test_i_v5_3_03_cli_exit_code_and_json_output(self) -> None:
        """Plan ARIA-V5 §3e v2 — CLI contract for CI consumption.

        ``python -m aria_kernel.pedagogy_lint --format json`` MUST:
          (a) exit 0 when violations are empty (strict mode + clean)
          (b) emit valid JSON with keys: violation_count,
              agents_scanned, agents_compliant, agents_allowlisted,
              lint_pass_rate, violations (list of dicts)
        """
        result = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel.pedagogy_lint",
                "--agents-dir", str(_AGENTS_DIR),
                "--allowlist", str(_ALLOWLIST),
                "--strict",
                "--format", "json",
            ],
            cwd=str(_KERNEL_ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            result.returncode, 0,
            msg=(
                f"Plan ARIA-V5 §3e v2 — pedagogy_lint warn-mode "
                f"CLI MUST exit 0 at C4 landing. "
                f"stdout={result.stdout[:500]!r} "
                f"stderr={result.stderr[:500]!r}"
            ),
        )
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            self.fail(f"pedagogy_lint --format json emitted invalid JSON: {exc}")
        for required_key in [
            "violation_count", "agents_scanned", "agents_compliant",
            "agents_allowlisted", "lint_pass_rate", "violations",
        ]:
            self.assertIn(
                required_key, data,
                msg=f"pedagogy_lint JSON output missing key {required_key!r}",
            )
        self.assertIsInstance(data["violations"], list)
        self.assertEqual(data["violation_count"], 0)

    # I-V5.3-04 — the narrative matcher recognizes the operator-canonical
    # punctuation shape (regression for the Phase-0 inside/outside contract fix).
    def test_i_v5_3_04_narrative_rx_accepts_canonical_shapes(self) -> None:
        """Plan ARIA-V5 §3e — NARRATIVE_RX MUST recognize the narrative shape
        the lint's own remediation string + narrative_prompt_validator.py
        prescribe (`**Why:**`, colon INSIDE), as well as the legacy outside form
        (`**Why**:`), and MUST NOT match a bare non-marker. Locks the Phase-0
        fix so the matcher can never again contradict its own guidance.
        """
        from aria_kernel.pedagogy_lint import NARRATIVE_RX, EXAMPLE_EQUIVALENT_RX
        accept = [
            "  **Why:** the cascade would replay forever.",     # V5 inside (canonical)
            "  **Why**: the cascade would replay forever.",      # legacy outside
            "  **Consequence:** duplicate events storm consumers.",
            "  **Rule.** never publish outside the outbox.",     # V4 inside
            "  **The correct path.** emit via the transactional outbox.",
        ]
        for s in accept:
            self.assertTrue(
                NARRATIVE_RX.search(s),
                msg=f"NARRATIVE_RX must match canonical narrative: {s!r}",
            )
        reject = [
            "  **Note:** not a recognized narrative marker.",    # marker not in the set
            "  - The handler MUST publish via the outbox.",      # bare imperative, no marker
            "  **Why**",                                          # marker, no punctuation/content
        ]
        for s in reject:
            self.assertFalse(
                NARRATIVE_RX.search(s),
                msg=f"NARRATIVE_RX must NOT match: {s!r}",
            )
        self.assertTrue(EXAMPLE_EQUIVALENT_RX.search("  **Example:** see batch.handler.ts"))
        self.assertTrue(EXAMPLE_EQUIVALENT_RX.search("  **Example**: see batch.handler.ts"))

    # I-V5.3-05 — one allowlist match site, keyed by the schema's
    # repo-relative path.
    def test_i_v5_3_05_allowlist_matches_once_by_repo_relative_path(self) -> None:
        """Plan ARIA-V5 §3e v2 R-P4 — the allowlist's keys are
        repo-relative agent paths, and ``run_pedagogy_lint`` is the one
        place that knows that path. ``lint_agent_file`` lints and
        returns the violations, nothing else; strict mode ignores the
        allowlist.
        """
        import tempfile
        from datetime import datetime, timezone

        from aria_kernel.pedagogy_lint import lint_agent_file, run_pedagogy_lint

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agents_dir = root / ".claude" / "agents"
            agents_dir.mkdir(parents=True)
            agent = agents_dir / "untiered.md"
            agent.write_text("---\nname: untiered\n---\nBody.\n", encoding="utf-8")
            allowlist = root / "allowlist.json"
            allowlist.write_text(json.dumps({"entries": {
                ".claude/agents/untiered.md": {
                    "reason": "fixture",
                    "added_at": datetime.now(timezone.utc).isoformat(),
                },
            }}), encoding="utf-8")

            violations = lint_agent_file(agent)
            warn = run_pedagogy_lint(agents_dir=agents_dir, allowlist_path=allowlist)
            strict = run_pedagogy_lint(
                agents_dir=agents_dir, allowlist_path=allowlist, strict=True,
            )

        self.assertIsInstance(violations, list)
        self.assertEqual([v.imperative_kind for v in violations], ["missing_tier"])
        self.assertEqual(
            (warn.agents_allowlisted, warn.violation_count), (1, 0),
        )
        self.assertEqual(strict.agents_allowlisted, 0)
        self.assertEqual(
            [v.imperative_kind for v in strict.violations], ["missing_tier"],
        )

    # The allowlist's comment is the first thing a reader of an empty
    # allowlist sees; it must name the CI step that enforces the lint and
    # carry no agent count that silently goes stale.
    def test_allowlist_comment_names_live_ci_and_no_count(self) -> None:
        import re

        comment = json.loads(_ALLOWLIST.read_text(encoding="utf-8"))["comment"]
        workflows = _REPO_ROOT / ".github" / "workflows"
        named = re.findall(r"[\w{},.-]+\.ya?ml", comment)
        self.assertGreater(len(named), 0)
        for name in named:
            workflow = workflows / name
            self.assertTrue(workflow.is_file(), msg=f"{name} is not a workflow file")
            text = workflow.read_text(encoding="utf-8")
            self.assertIn("aria_kernel.pedagogy_lint", text, msg=name)
            self.assertIn("--strict", text, msg=name)
        self.assertIsNone(
            re.search(r"\b\d+\s+agents\b", comment),
            msg="the allowlist comment carries an agent count",
        )


if __name__ == "__main__":
    unittest.main()
