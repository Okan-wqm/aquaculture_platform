"""Plan 033 Faz 033i — semantic parity corpus, qualifying shadow cycles, agent retirement gate.

WHY: the removable Lane-B security agents (`security-reviewer`, `auth-security-expert`)
may only be retired when the kernel demonstrably matches them: a paired
secure/vulnerable corpus (deterministic mutants) scores recall/false-positive per claim
type; only a QUALIFYING shadow cycle counts toward the burn-in (non-mock, fresh
qualifying lab lease, ≥1 applicable control, passing positive control, sealed evidence)
and the counter resets on any non-qualifying cycle. `retirement_readiness` is an honest
report: it names every remaining kernel runtime dependency on a removable agent and never
performs a deletion. `database-reviewer` is RETAINED (data-correctness, not security).
"""
from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from . import packs
from .profile import compile_profile

PARITY_SURFACE = "security_parity"
PARITY_RELPATH: tuple[str, ...] = ("security", "parity.jsonl")
REMOVABLE_SECURITY_AGENTS = ("security-reviewer", "auth-security-expert")
RETAINED_AGENTS = ("database-reviewer",)
RETIREMENT_THRESHOLD = {
    "critical_recall": 1.0, "other_recall": 0.95, "secure_false_positive_rate": 0.02,
    "consecutive_qualifying_cycles": 30, "agent_only_unresolved_critical_high": 0, "boundary_violations": 0,
}
# kernel modules that may legally dispatch or name an agent at runtime
_RUNTIME_DISPATCH_MODULES = ("agent_surface.py", "expert_review_gate.py", "agent_resolver.py", "ci.py", "specialist_touch_map.py")

# ---- corpus: paired secure / vulnerable fixtures, deterministic --------------
_SECURE_SQL = "CREATE SCHEMA t;\nCREATE TABLE farms (id int, tenant_id uuid);\nALTER TABLE farms ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON farms USING (true);\n"
_VULN_SQL = "CREATE SCHEMA t;\nCREATE TABLE farms (id int, tenant_id uuid);\n"
_SECURE_CTRL = "@Controller('farms')\nexport class C {\n  @UseGuards(JwtGuard)\n  @Post()\n  create() {}\n}\n"
_VULN_CTRL = "@Controller('farms')\nexport class C {\n  @Post()\n  create() {}\n}\n"


@dataclass(frozen=True)
class CorpusCase:
    case_id: str
    claim_type: str
    severity: str
    vulnerable: bool
    files: dict[str, str]
    expected_rule: str


SECURITY_CORPUS: tuple[CorpusCase, ...] = (
    CorpusCase("rls-secure", "rls_gap", "CRITICAL", False, {"apps/farm-service/sql/s.sql": _SECURE_SQL}, "rls_coverage"),
    CorpusCase("rls-vulnerable", "rls_gap", "CRITICAL", True, {"apps/farm-service/sql/s.sql": _VULN_SQL}, "rls_coverage"),
    CorpusCase("guard-secure", "authz_bypass", "HIGH", False, {"apps/farm-service/src/x.controller.ts": _SECURE_CTRL}, "public_write_guard"),
    CorpusCase("guard-vulnerable", "authz_bypass", "HIGH", True, {"apps/farm-service/src/x.controller.ts": _VULN_CTRL}, "public_write_guard"),
)


def _materialize(case: CorpusCase, root: Path) -> None:
    (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1"}}', encoding="utf-8")
    (root / "apps" / "farm-service" / "sql").mkdir(parents=True, exist_ok=True)
    (root / "apps" / "farm-service" / "src").mkdir(parents=True, exist_ok=True)
    for rel, text in case.files.items():
        (root / rel).write_text(text, encoding="utf-8")


def run_corpus(corpus: tuple[CorpusCase, ...] = SECURITY_CORPUS) -> dict[str, Any]:
    """Run the kernel's own packs over every case; score recall (vulnerable found) and
    false positives (secure flagged) per severity class."""
    per_case: list[dict[str, Any]] = []
    for case in corpus:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            _materialize(case, root)
            profile = compile_profile(workspace_root=root, repo_sha="corpus").to_row()
            leads: list[Any] = []
            for manifest in packs.select_packs(profile):
                if manifest.applicable:
                    leads.extend(packs.run_pack(manifest.name, workspace_root=root, profile_row=profile))
            flagged = any(case.expected_rule in str(getattr(lead, "rule_id", "")) for lead in leads)
            per_case.append({"case_id": case.case_id, "claim_type": case.claim_type, "severity": case.severity,
                             "vulnerable": case.vulnerable, "flagged": flagged, "correct": flagged == case.vulnerable})
    def _recall(sev_filter):
        vul = [c for c in per_case if c["vulnerable"] and sev_filter(c["severity"])]
        return round(sum(c["flagged"] for c in vul) / len(vul), 4) if vul else None
    secure = [c for c in per_case if not c["vulnerable"]]
    fp = round(sum(c["flagged"] for c in secure) / len(secure), 4) if secure else None
    return {"cases": per_case, "critical_recall": _recall(lambda s: s == "CRITICAL"),
            "other_recall": _recall(lambda s: s != "CRITICAL"), "secure_false_positive_rate": fp,
            "all_correct": all(c["correct"] for c in per_case)}


# ---- qualifying shadow cycles --------------------------------------------------
def record_cycle(*, campaign_run_id: str, mock: bool, lease_qualifying: bool, applicable_controls: int,
                 positive_control_ok: bool, evidence_sealed: bool, boundary_violations: int = 0,
                 base_dir: str | Path | None = None) -> dict[str, Any]:
    qualifying = (not mock and lease_qualifying and applicable_controls >= 1 and positive_control_ok
                  and evidence_sealed and boundary_violations == 0)
    path = ensure_tools_dir(base_dir).joinpath(*PARITY_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {"schema_version": 1, "recorded_at": utc_now(), "event": "cycle", "campaign_run_id": campaign_run_id,
           "mock": mock, "lease_qualifying": lease_qualifying, "applicable_controls": applicable_controls,
           "positive_control_ok": positive_control_ok, "evidence_sealed": evidence_sealed,
           "boundary_violations": boundary_violations, "qualifying": qualifying}
    return append_declared_jsonl(path, row, expected_surface=PARITY_SURFACE)


def consecutive_qualifying(*, base_dir: str | Path | None = None) -> int:
    path = ensure_tools_dir(base_dir).joinpath(*PARITY_RELPATH)
    if not path.exists():
        return 0
    streak = 0
    for row in load_declared_jsonl(path, expected_surface=PARITY_SURFACE):
        if row.get("event") != "cycle":
            continue
        streak = streak + 1 if row.get("qualifying") else 0
    return streak


def total_boundary_violations(*, base_dir: str | Path | None = None) -> int:
    path = ensure_tools_dir(base_dir).joinpath(*PARITY_RELPATH)
    if not path.exists():
        return 0
    return sum(int(r.get("boundary_violations") or 0) for r in load_declared_jsonl(path, expected_surface=PARITY_SURFACE) if r.get("event") == "cycle")


# ---- retirement gate -----------------------------------------------------------
def remaining_runtime_dependencies(kernel_root: str | Path) -> list[dict[str, str]]:
    """Structural scan: every non-comment line in a dispatch module naming a removable agent."""
    root = Path(kernel_root)
    hits: list[dict[str, str]] = []
    for name in _RUNTIME_DISPATCH_MODULES:
        path = root / name
        if not path.exists():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith('"""') or stripped.startswith("*"):
                continue
            for agent in REMOVABLE_SECURITY_AGENTS:
                if re.search(rf"[\"']{re.escape(agent)}[\"']", stripped):
                    hits.append({"module": name, "line": str(lineno), "agent": agent})
    return hits


def retirement_readiness(*, kernel_root: str | Path, corpus_result: dict[str, Any] | None = None,
                         agent_only_unresolved_critical_high: int = 0, base_dir: str | Path | None = None) -> dict[str, Any]:
    corpus_result = corpus_result or run_corpus()
    streak = consecutive_qualifying(base_dir=base_dir)
    deps = remaining_runtime_dependencies(kernel_root)
    violations = total_boundary_violations(base_dir=base_dir)
    reasons: list[str] = []
    th = RETIREMENT_THRESHOLD
    if (corpus_result.get("critical_recall") or 0) < th["critical_recall"]:
        reasons.append(f"critical_recall {corpus_result.get('critical_recall')} < {th['critical_recall']}")
    if (corpus_result.get("other_recall") or 0) < th["other_recall"]:
        reasons.append(f"other_recall {corpus_result.get('other_recall')} < {th['other_recall']}")
    if (corpus_result.get("secure_false_positive_rate") if corpus_result.get("secure_false_positive_rate") is not None else 1) > th["secure_false_positive_rate"]:
        reasons.append("secure_false_positive_rate above threshold")
    if streak < th["consecutive_qualifying_cycles"]:
        reasons.append(f"consecutive_qualifying_cycles {streak} < {th['consecutive_qualifying_cycles']}")
    if agent_only_unresolved_critical_high > th["agent_only_unresolved_critical_high"]:
        reasons.append(f"agent_only_unresolved_critical_high={agent_only_unresolved_critical_high}")
    if violations > th["boundary_violations"]:
        reasons.append(f"boundary_violations={violations}")
    if deps:
        reasons.append(f"{len(deps)} kernel runtime dependency(ies) on removable agents remain")
    return {"ready": not reasons, "reasons": reasons, "consecutive_qualifying_cycles": streak,
            "remaining_runtime_dependencies": deps, "removable": list(REMOVABLE_SECURITY_AGENTS),
            "retained": list(RETAINED_AGENTS), "operator_approval_required": True,
            "corpus": {k: v for k, v in corpus_result.items() if k != "cases"}}


__all__ = ["PARITY_RELPATH", "PARITY_SURFACE", "REMOVABLE_SECURITY_AGENTS", "RETAINED_AGENTS", "RETIREMENT_THRESHOLD",
           "SECURITY_CORPUS", "CorpusCase", "consecutive_qualifying", "record_cycle", "remaining_runtime_dependencies",
           "retirement_readiness", "run_corpus", "total_boundary_violations"]
