"""The per-rule judgment contract an adapter manifest declares (ARIA-HIGH-324).

WHY. The judge envelope asked "true_positive or false_positive?" and defined
neither, so judges checked whether the rule's predicate held (F-011, Opus:
"Rule predicate ... both halves hold") and three of them agreed. What a rule
claims about the PRODUCT is known only to the manifest of the tool emitting it.

WHAT. ``rules`` in ``tools/aria-adapters/<tool>.tool.json`` maps a rule id to
``claim_type`` (a ``finding.CLAIM_TYPES`` member the promoted finding carries),
``severity_cap`` (the highest severity it is promoted at, never below the
claim type's floor), ``defect_claim`` (the product defect a true positive
asserts) and ``premises`` (product facts that must ALL hold). The judge
fan-out turns premises into ``must_satisfy`` obligations the judge bridge
holds a true_positive to. ``*`` covers rule ids derived at run time
(lint-rules-adapter's ESLint ids); ``tests/test_rule_contract_manifests.py``
pins every literal rule to its own entry. ``validate_rule_contracts`` runs in
``tool_registry.validate_tool_definition``, the one gate every registry row
passes, so a contract that could never be promoted never registers.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

RULE_CONTRACT_FIELDS: tuple[str, ...] = ("claim_type", "severity_cap", "defect_claim", "premises")
DYNAMIC_RULE_KEY = "*"


@dataclass(frozen=True)
class RuleContract:
    tool_id: str
    rule: str
    claim_type: str
    severity_cap: str
    defect_claim: str
    premises: tuple[str, ...]
    # The producing tool's declared scope: where evidence that a finding of
    # this tool is a product defect may live (evidence_trust).
    declared_scope: tuple[str, ...]

    def promotion_severity(self, raw: str) -> str:
        """ARIA-MEDIUM-326 — the severity a true positive of this rule is
        promoted at: the consensus severity in the canonical vocabulary
        (``critical`` is CRITICAL), no higher than ``severity_cap`` and no
        lower than the claim type's floor (validated <= cap at the gate)."""
        from .finding import CLAIM_TYPES, SEVERITY_RANK

        canonical = str(raw or "").strip().upper()
        severity = canonical if canonical in SEVERITY_RANK else "MEDIUM"
        if SEVERITY_RANK[severity] > SEVERITY_RANK[self.severity_cap]:
            severity = self.severity_cap
        floor = str(CLAIM_TYPES[self.claim_type]["min_severity"])
        if SEVERITY_RANK[severity] < SEVERITY_RANK[floor]:
            severity = floor
        return severity


def validate_rule_contracts(rules: Any, *, tool_id: str) -> dict[str, dict[str, Any]]:
    """The manifest ``rules`` block, refused when any contract could not stand."""
    from .agent_genesis import BANNED_PHRASES
    from .finding import CLAIM_TYPES, SEVERITIES, SEVERITY_RANK

    if not isinstance(rules, dict) or not rules:
        raise GovernanceError(f"rule_contract_invalid: {tool_id}: rules must be a non-empty object")
    cleaned: dict[str, dict[str, Any]] = {}
    for rule, contract in rules.items():
        where = f"rule_contract_invalid: {tool_id}.rules[{rule!r}]"
        if not isinstance(rule, str) or not rule.strip():
            raise GovernanceError(f"{where}: rule id must be a non-empty string")
        if not isinstance(contract, dict) or set(contract) != set(RULE_CONTRACT_FIELDS):
            raise GovernanceError(f"{where}: fields must be exactly {RULE_CONTRACT_FIELDS}")
        claim_type = contract["claim_type"]
        severity_cap = contract["severity_cap"]
        if claim_type not in CLAIM_TYPES:
            raise GovernanceError(f"{where}: unknown claim_type {claim_type!r}")
        if severity_cap not in SEVERITIES:
            raise GovernanceError(f"{where}: unknown severity_cap {severity_cap!r}")
        floor = CLAIM_TYPES[claim_type]["min_severity"]
        if SEVERITY_RANK[severity_cap] < SEVERITY_RANK[floor]:
            raise GovernanceError(
                f"{where}: severity_cap {severity_cap} is below the {claim_type} floor {floor}"
            )
        defect_claim = contract["defect_claim"]
        premises = contract["premises"]
        if not isinstance(defect_claim, str) or not defect_claim.strip():
            raise GovernanceError(f"{where}: defect_claim must be a non-empty string")
        if (
            not isinstance(premises, list)
            or not premises
            or any(not isinstance(item, str) or not item.strip() for item in premises)
        ):
            raise GovernanceError(f"{where}: premises must be a non-empty list of statements")
        # The defect claim reaches a promoted finding's claim_summary, which
        # emit_finding scans; a claim it would refuse is refused here.
        for phrase in BANNED_PHRASES:
            if phrase in defect_claim.lower():
                raise GovernanceError(f"{where}: defect_claim contains banned phrase {phrase!r}")
        cleaned[rule] = {
            "claim_type": claim_type,
            "severity_cap": severity_cap,
            "defect_claim": defect_claim.strip(),
            "premises": [item.strip() for item in premises],
        }
    return cleaned


def contract_for_tool(tool: dict[str, Any], rule: str) -> RuleContract | None:
    """The contract ``tool`` (a registry row) declares for ``rule``, if any."""
    rules = tool.get("rules")
    if not isinstance(rules, dict) or not rule:
        return None
    entry = rules.get(rule) or rules.get(DYNAMIC_RULE_KEY)
    if not isinstance(entry, dict):
        return None
    return RuleContract(
        tool_id=str(tool.get("tool_id") or ""),
        rule=rule,
        claim_type=str(entry["claim_type"]),
        severity_cap=str(entry["severity_cap"]),
        defect_claim=str(entry["defect_claim"]),
        premises=tuple(str(item) for item in entry["premises"]),
        declared_scope=tuple(str(glob) for glob in tool.get("declared_scope") or ()),
    )


def resolve_rule_contract(
    *,
    tool_id: str,
    rule: str,
    base_dir: str | Path | None = None,
) -> RuleContract | None:
    """The registered contract for ``(tool_id, rule)``; ``None`` when the tool
    is not registered or declares no contract for the rule. Callers refuse on
    ``None``: a finding whose rule states no product claim cannot be judged
    for one, nor promoted as one."""
    from .tool_registry import get_tool

    try:
        tool = get_tool(tool_id, base_dir)
    except GovernanceError:
        return None
    return contract_for_tool(tool, rule)

