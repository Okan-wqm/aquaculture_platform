"""Plan 032 Faz 032i — decision memory + the context pack.

WHY: ARIA already records what it did (hash-chained ledgers) but a fresh
dispatch never saw WHY earlier decisions were taken; the agent re-derives,
re-argues and re-spends tokens. Hermes keeps a memory file the model edits.
ARIA compiles memory FROM the ledgers, deterministically, per dispatch:
decisions with a stated reason, ranked by overlap with the request and by
recency, cut to a token budget, hash-addressed, and rendered as DATA (a
`<derived_context section="decision_memory">` block) — never instructions,
never something the agent can rewrite.

WHAT: `collect_decisions` reads only rows that carry a why (recovery
decisions, operator control, curation decisions, human-required records,
plan/mission events with a reason, governance rows with reason/rationale);
`compile_context` builds the pack at MINT time so the prompt hash seals it.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .ledger import load_declared_jsonl, read_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, utc_now

DECISION_SOURCES: tuple[str, ...] = ("recovery", "control", "curation", "human_required", "plan", "mission", "governance")
GOVERNANCE_WHY_KEYS: tuple[str, ...] = ("reason", "rationale", "why", "resolution_note", "tripped_reason")
DEFAULT_PACK_TOKENS = 1200
MAX_DECISIONS = 12
CONTEXT_PACK_EVENT = "context_pack_compiled"
_WORD = re.compile(r"[a-z][a-z0-9_./-]{2,}")
_STOP = frozenset("the and for with that this from into your when then than are you use not but can all any has have will should must request plan".split())


@dataclass(frozen=True)
class DecisionRecord:
    source: str
    ref: str
    when: str
    what: str
    why: str
    ledger_hash: str = ""

    def text(self) -> str:
        return f"{self.what} {self.why}"


@dataclass(frozen=True)
class ContextPack:
    pack_hash: str
    compiled_at: str
    token_estimate: int
    budget_tokens: int
    decisions: tuple[DecisionRecord, ...]
    sources: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"pack_hash": self.pack_hash, "compiled_at": self.compiled_at, "token_estimate": self.token_estimate,
                "budget_tokens": self.budget_tokens, "sources": dict(self.sources), "decisions": [asdict(d) for d in self.decisions]}


def _terms(text: str) -> set[str]:
    return {w for w in _WORD.findall(str(text or "").lower()) if w not in _STOP}


def _rows(root: Path, rel: str, surface: str | None) -> list[dict[str, Any]]:
    path = root / rel
    if not path.exists():
        return []
    try:
        return load_declared_jsonl(path, expected_surface=surface) if surface else read_jsonl(path)
    except Exception:  # noqa: BLE001 — a corrupt secondary ledger costs memory, not the dispatch
        return []


def collect_decisions(*, base_dir: str | Path | None = None, limit: int = 400) -> list[DecisionRecord]:
    """Every decision that states its reason, newest last."""
    root = ensure_tools_dir(base_dir)
    out: list[DecisionRecord] = []
    for row in _rows(root, "recovery/decisions.jsonl", "recovery_decisions"):
        out.append(DecisionRecord("recovery", str(row.get("request_id")), str(row.get("recorded_at") or ""),
                                  f"recovery decided {row.get('decision')} for {row.get('request_id')}", str(row.get("reason") or ""), str(row.get("ledger_hash") or "")))
    for row in _rows(root, "control/commands.jsonl", "control_commands"):
        out.append(DecisionRecord("control", str(row.get("command_id")), str(row.get("recorded_at") or ""),
                                  f"operator {row.get('verb')} ({row.get('scope')}{' ' + str(row.get('request_id')) if row.get('request_id') else ''})",
                                  str(row.get("reason") or ""), str(row.get("ledger_hash") or "")))
    for row in _rows(root, "skill-genesis/curation-proposals.jsonl", "skill_curation_proposals"):
        if row.get("event") == "decided":
            out.append(DecisionRecord("curation", str(row.get("proposal_id")), str(row.get("recorded_at") or ""),
                                      f"curation {row.get('decision')} {row.get('proposal_id')}", str(row.get("note") or ""), str(row.get("ledger_hash") or "")))
        elif row.get("event") == "proposed":
            out.append(DecisionRecord("curation", str(row.get("proposal_id")), str(row.get("recorded_at") or ""),
                                      f"{row.get('kind')} {' + '.join(row.get('subjects') or [])}", str(row.get("rationale") or ""), str(row.get("ledger_hash") or "")))
    hr_dir = root / "human-required"
    if hr_dir.is_dir():
        for path in sorted(hr_dir.glob("*.json")):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            why = str(record.get("resolution_note") or record.get("reason") or "")
            out.append(DecisionRecord("human_required", str(record.get("request_id")), str(record.get("resolved_at") or record.get("recorded_at") or ""),
                                      f"HUMAN_REQUIRED {record.get('status')} {record.get('request_id')}" + (f" verdict={record.get('verdict')}" if record.get("verdict") else ""), why))
    for row in _rows(root, "plans/events.jsonl", None):
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        why = str(payload.get("reason") or payload.get("rationale") or "")
        if why:
            out.append(DecisionRecord("plan", str(row.get("plan_id")), str(row.get("recorded_at") or row.get("at") or ""),
                                      f"plan {row.get('event')} {row.get('plan_id')}", why, str(row.get("ledger_hash") or "")))
    for row in _rows(root, "missions/mission-events.jsonl", "mission_events"):
        why = str(row.get("note") or row.get("reason_code") or "")
        if why:
            out.append(DecisionRecord("mission", str(row.get("mission_id")), str(row.get("recorded_at") or ""),
                                      f"mission {row.get('event')} {row.get('mission_id')}", why, str(row.get("ledger_hash") or "")))
    gov = root / "governance.jsonl"
    if gov.exists():
        try:
            from .governance_reader import read_governance_rows

            rows = list(read_governance_rows(gov, on_corruption="skip", base_dir=root))
        except Exception:  # noqa: BLE001
            rows = []
        for row in rows[-limit:]:
            details = row.get("details") if isinstance(row.get("details"), dict) else {}
            why = next((str(details[k]) for k in GOVERNANCE_WHY_KEYS if details.get(k)), "")
            if why:
                out.append(DecisionRecord("governance", str(row.get("event_id") or row.get("kind")), str(row.get("recorded_at") or row.get("timestamp") or ""),
                                          str(row.get("kind")), why[:300], str(row.get("ledger_hash") or "")))
    out.sort(key=lambda d: d.when)
    return out[-limit:]


def rank_decisions(decisions: list[DecisionRecord], *, query: str, k: int = MAX_DECISIONS) -> list[DecisionRecord]:
    """Overlap with the request first, recency second; deterministic."""
    q = _terms(query)
    scored = []
    for index, decision in enumerate(decisions):
        overlap = len(q & _terms(decision.text())) if q else 0
        scored.append((-overlap, -index, decision))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [d for _, _, d in scored[:k]]


def compile_context(*, request: Mapping[str, Any], base_dir: str | Path | None = None, budget_tokens: int = DEFAULT_PACK_TOKENS,
                    decisions: list[DecisionRecord] | None = None, record: bool = True) -> ContextPack:
    from .context_budget_gate import estimate_tokens

    root = ensure_tools_dir(base_dir)
    pool = decisions if decisions is not None else collect_decisions(base_dir=root)
    query = " ".join(str(request.get(k) or "") for k in ("suggested_prompt", "role", "target_agent", "convergence_id"))
    query += " " + " ".join(str(r) for r in (request.get("evidence_refs") or []) + (request.get("allowed_scope") or []))
    chosen: list[DecisionRecord] = []
    used = 0
    for decision in rank_decisions(pool, query=query):
        cost = estimate_tokens(decision.text()) + 8
        if used + cost > budget_tokens:
            break
        chosen.append(decision)
        used += cost
    sources: dict[str, int] = {}
    for decision in chosen:
        sources[decision.source] = sources.get(decision.source, 0) + 1
    digest = hashlib.sha256(json.dumps([asdict(d) for d in chosen], sort_keys=True).encode("utf-8")).hexdigest()
    pack = ContextPack(pack_hash=f"sha256:{digest[:32]}", compiled_at=utc_now(), token_estimate=used, budget_tokens=budget_tokens,
                       decisions=tuple(chosen), sources=sources)
    if record:
        append_tools_governance(root, CONTEXT_PACK_EVENT, {"request_id": request.get("request_id"), "pack_hash": pack.pack_hash,
                                                            "decisions": len(chosen), "token_estimate": used, "sources": sources})
    return pack


def render_decision_memory(pack: Mapping[str, Any] | None) -> str:
    """The prompt block. Empty when no decision applies — silence is honest."""
    if not isinstance(pack, Mapping) or not pack.get("decisions"):
        return ""
    lines = ["## Decision memory", "",
             f"What ARIA decided before, and why (pack `{pack.get('pack_hash')}`) — a projection, **not evidence**; do not re-litigate a decision without new evidence.", ""]
    for decision in pack.get("decisions") or []:
        if not isinstance(decision, Mapping):
            continue
        when = str(decision.get("when") or "")[:10]
        lines.append(f"- [{decision.get('source')} {when}] {decision.get('what')} — because: {decision.get('why')}")
    return "\n".join(lines) + "\n"


__all__ = ["CONTEXT_PACK_EVENT", "DECISION_SOURCES", "DEFAULT_PACK_TOKENS", "GOVERNANCE_WHY_KEYS", "MAX_DECISIONS",
           "ContextPack", "DecisionRecord", "collect_decisions", "compile_context", "rank_decisions", "render_decision_memory"]
