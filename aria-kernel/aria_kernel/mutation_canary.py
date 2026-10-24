"""WP-J D-2 — mutation canaries: the panel's self-exam, labelled by construction.

The operator's protocol item 10 (2026-10-18): plant known bugs and false
claims, and measure the panel continuously — precision and recall without a
single human label. This module owns the WHOLE canary lane:

  * THE CORPUS (``build_canary_corpus``): a tiny synthetic codebase in a
    hermetic-git sandbox (git env scrubbed, disk bounded by construction —
    a few KB of fixed files, no repo checkout), with N planted MUTANTS
    (a real defect introduced: the canary finding is a TRUE positive by
    construction) and M planted FALSE CLAIMS (a finding describing a
    defect that is not there: a FALSE positive by construction). The
    labels are not judged, they are CAUSED.
  * REGISTRATION (``register_canary_corpus``): through the goldset LANE —
    the corpus is promoted with ``goldset.promote_goldset_proposal`` into
    the one active-corpus shape the existing consumers read, for the
    canary tool id, named by its corpus hash. Deliberately NOT a curator
    envelope: a curator drafts what is undetermined, and a canary corpus
    is determined by construction; an LLM call with no decision to make
    is the cost the funnel exists to prevent. Machine promotion is safe
    HERE and only here: canary items never enter GROUND_TRUTH_SOURCE_TYPES,
    so no authority reader (suppression, goldset admission for organic
    tools, promotion readiness) can ever read them.
  * THE MINT (``mint_canary_judgments``): the corpus's canary findings are
    put to the panel through the SAME judge-question law the live fan-out
    uses (``judge_fanout.judge_request_fields`` — the envelope is built
    from a constructed RuleContract, so the canary asks exactly the
    question real findings ask), under ``canary:`` groups, blind. The
    label rows land as ``source_type='canary'`` under the same groups —
    the first such mint is the same commit as FEEDBACK_SOURCE_TYPES
    gaining 'canary'.
  * SCORING (``role_fitness.measure_role_fitness`` canary block): ≥ 90 %
    of planted mutants found, ≥ 90 % of planted false claims refuted,
    nightly, named by the corpus hash.

Cadence is a function of the MEASURED drain exactly like the stability
lane: with no measured drain the mint holds (records it, mints nothing).
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request
from .calibrated_intelligence import deterministic_seed
from .feedback_store import record_operator_feedback
from .judge_fanout import JUDGE_FANOUT, _existing_judge_dispatches, judge_request_fields
from .request_admission import admit_request
from .rule_contract import RuleContract
from .tool_registry import ensure_tools_dir, utc_now

CANARY_SOURCE_TYPE = "canary"
CANARY_GROUP_PREFIX = "canary:"
CANARY_TOOL_ID = "mutation-canary"
CANARY_JUDGE_ID = "aria-mutation-canary"
# ≥90 % / ≥90 % — the operator's bars (WP-J §4), stated once here and read
# by the role_fitness canary block.
CANARY_MIN_MUTANT_DETECTION: float = 0.9
CANARY_MIN_FALSE_CLAIM_REFUTATION: float = 0.9
# The sandbox's disk bound: the synthetic corpus is a handful of fixed
# files; anything bigger than this is a bug in the constructor, not a
# bigger exam, and is refused before it lands on the shared disk.
SANDBOX_MAX_BYTES: int = 512 * 1024

# The synthetic codebase the mutants live in. Small, fixed, dependency-free.
_SANDBOX_FILES: dict[str, str] = {
    "sensor_range.py": (
        "def reading_in_range(value: float, lo: float, hi: float) -> bool:\n"
        "    \"\"\"True when value sits in [lo, hi].\"\"\"\n"
        "    return lo <= value <= hi\n"
        "\n"
        "\n"
        "def clamp(value: float, lo: float, hi: float) -> float:\n"
        "    \"\"\"Clamp value into [lo, hi].\"\"\"\n"
        "    return max(lo, min(hi, value))\n"
    ),
    "feed_schedule.py": (
        "def next_feed_grams(weight_g: int) -> int:\n"
        "    \"\"\"Daily feed: 2% of body weight, at least 5 g, at most 500 g.\"\"\"\n"
        "    grams = weight_g * 2 // 100\n"
        "    return max(5, min(500, grams))\n"
        "\n"
        "\n"
        "def feeds_per_day(temp_c: float) -> int:\n"
        "    \"\"\"Above 24C the metabolism is high: feed twice.\"\"\"\n"
        "    return 2 if temp_c > 24.0 else 1\n"
    ),
}

# The planted mutants: (file, find(line), replace(line), canary rule id,
# defect claim, premise). Each is a REAL defect a judge must catch. An item's
# evidence ref is DERIVED from its anchor line in ``_SANDBOX_FILES``
# (``_anchor_ref``), never typed beside it: the sandbox text is the one
# owner of where a line sits.
_MUTANTS: list[dict[str, Any]] = [
    {
        "rule": "canary-range-inclusive",
        "file": "sensor_range.py",
        "find": "    return lo <= value <= hi",
        "replace": "    return lo < value < hi",
        "claim": "reading_in_range rejects readings exactly at a range boundary, so a sensor at its calibrated edge reports out-of-range",
        "premises": ["reading_in_range is documented to include both endpoints"],
    },
    {
        "rule": "canary-clamp-order",
        "file": "sensor_range.py",
        "find": "    return max(lo, min(hi, value))",
        "replace": "    return min(hi, max(lo, value))",
        "claim": "clamp returns hi for values above hi but lo for values below lo only after clamping to hi first, so a lo above hi inverts the clamp",
        "premises": ["clamp is documented to bound value into [lo, hi]"],
    },
    {
        "rule": "canary-feed-floor",
        "file": "feed_schedule.py",
        "find": "    return max(5, min(500, grams))",
        "replace": "    return min(5, max(500, grams))",
        "claim": "next_feed_grams floors every ration at 500 g and caps it at 5 g, inverting the intended bounds",
        "premises": ["the daily ration is documented as at least 5 g and at most 500 g"],
    },
]

# The planted false claims: findings describing defects that are NOT in the
# code. A judge must refute each. ``anchor`` is the unmutated line the claim
# is about; the evidence ref is derived from it like a mutant's.
_FALSE_CLAIMS: list[dict[str, Any]] = [
    {
        "rule": "canary-feeds-threshold",
        "file": "feed_schedule.py",
        "anchor": "    return 2 if temp_c > 24.0 else 1",
        "claim": "feeds_per_day feeds twice at exactly 24C, contradicting the 'above 24C' rule",
        "premises": ["feeds_per_day is documented to feed twice only strictly above 24C"],
    },
    {
        "rule": "canary-range-strict",
        "file": "sensor_range.py",
        "anchor": "    return lo <= value <= hi",
        "claim": "reading_in_range uses strict comparisons and excludes the endpoints",
        "premises": ["reading_in_range is documented to include both endpoints"],
    },
]


def _anchor_ref(file: str, anchor: str) -> str:
    """``<file>:<line>`` (1-indexed, the kernel's evidence-ref convention)
    of the ONE sandbox line equal to ``anchor``.

    Raises ValueError when the anchor is absent or not unique: a ref that
    cannot name exactly one line is not evidence of anything.
    """
    lines = _SANDBOX_FILES[file].splitlines()
    hits = [number for number, line in enumerate(lines, start=1) if line == anchor]
    if len(hits) != 1:
        raise ValueError(f"canary anchor not exactly one line of {file}: {anchor!r}")
    return f"{file}:{hits[0]}"


def _scrubbed_git_env() -> dict[str, str]:
    """The kernel's own hermetic env — fixture git must be blind to this host's repositories."""
    from .main_anchor import scrubbed_git_env

    return scrubbed_git_env()


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd, capture_output=True,
        text=True, check=False, timeout=60, env=_scrubbed_git_env(), stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RuntimeError(f"canary sandbox git {args[0]} failed: {result.stderr[:200]}")
    return result.stdout.strip()


def _sandbox_commit(sandbox: Path) -> str:
    _git(sandbox, "add", "-A")
    _git(sandbox, "-c", "user.email=canary@aria", "-c", "user.name=aria-mutation-canary",
         "commit", "-qm", "canary corpus")
    return _git(sandbox, "rev-parse", "HEAD")


def build_canary_corpus(
    *,
    sandbox_root: str | Path,
    mutants: int = 3,
    false_claims: int = 2,
) -> dict[str, Any]:
    """Plant the mutants and false claims in a fresh hermetic sandbox.

    Returns the corpus record: items (with labels by construction), the
    sandbox commit each item's evidence pins, and the corpus hash that
    names it everywhere (the goldset record, the fitness block, the
    governance row). The sandbox is bounded by construction (fixed file
    set, ``SANDBOX_MAX_BYTES``) and re-created fresh — a corpus is a
    function of its inputs, not of whatever was on disk.
    """
    from .ledger import sha256_of_canonical_json

    sandbox = Path(sandbox_root)
    if sandbox.exists():
        raise ValueError(f"canary sandbox already exists: {sandbox}")
    sandbox.mkdir(parents=True)
    for name, body in _SANDBOX_FILES.items():
        (sandbox / name).write_text(body, encoding="utf-8")
    _git(sandbox, "init", "-q", "--initial-branch=main")
    base_sha = _sandbox_commit(sandbox)

    items: list[dict[str, Any]] = []
    for mutant in _MUTANTS[:mutants]:
        target = sandbox / mutant["file"]
        text = target.read_text(encoding="utf-8")
        if text.count(mutant["find"]) != 1:
            raise ValueError(f"canary mutant anchor not unique in {mutant['file']}: {mutant['find']!r}")
        target.write_text(text.replace(mutant["find"], mutant["replace"]), encoding="utf-8")
        sha = _sandbox_commit(sandbox)
        items.append({
            "item_id": f"canary:{mutant['rule']}",
            "kind": "mutant",
            "verdict": "true_positive",
            "rule": mutant["rule"],
            "path": _anchor_ref(mutant["file"], mutant["find"]),
            # WP-J review — BLIND by construction: the message is the
            # defect claim alone. The item's kind/verdict live on the corpus
            # row (the label side, read by the fitness measurement), never
            # in the envelope the judge prompt renders.
            "message": str(mutant["claim"]),
            "defect_claim": mutant["claim"],
            "premises": list(mutant["premises"]),
            "sandbox_sha": sha,
            "base_sha": base_sha,
        })
    for false_claim in _FALSE_CLAIMS[:false_claims]:
        items.append({
            "item_id": f"canary:{false_claim['rule']}",
            "kind": "false_claim",
            "verdict": "false_positive",
            "rule": false_claim["rule"],
            "path": _anchor_ref(false_claim["file"], false_claim["anchor"]),
            "message": str(false_claim["claim"]),
            "defect_claim": false_claim["claim"],
            "premises": list(false_claim["premises"]),
            "sandbox_sha": base_sha,
            "base_sha": base_sha,
        })
    used = sum((sandbox / name).stat().st_size for name in _SANDBOX_FILES)
    if used > SANDBOX_MAX_BYTES:
        raise ValueError(f"canary sandbox exceeded its disk bound: {used} > {SANDBOX_MAX_BYTES}")
    record = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "tool_id": CANARY_TOOL_ID,
        "base_sha": base_sha,
        "mutant_count": sum(1 for item in items if item["kind"] == "mutant"),
        "false_claim_count": sum(1 for item in items if item["kind"] == "false_claim"),
        "sandbox_root": str(sandbox),
        "items": items,
    }
    record["corpus_hash"] = sha256_of_canonical_json(
        {key: value for key, value in record.items() if key != "sandbox_root"}
    )
    return record


def _canary_contract(item: dict[str, Any]) -> RuleContract:
    """The item's judgment contract, constructed beside it.

    The envelope is still rendered by the ONE judge-question law
    (``judge_fanout.judge_request_fields``); only the contract — which a
    tool manifest declares for an organic rule — is constructed here,
    because a canary item's rule lives in the corpus, not in a manifest.
    """
    return RuleContract(
        tool_id=CANARY_TOOL_ID,
        rule=str(item["rule"]),
        claim_type="correctness",
        severity_cap="HIGH",
        defect_claim=str(item["defect_claim"]),
        premises=tuple(str(p) for p in item["premises"]),
        declared_scope=("*",),
    )


def register_canary_corpus(
    corpus: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Register the corpus through the goldset lane — ONE corpus, every reader."""
    from .goldset import promote_goldset_proposal

    proposal = {
        "schema_version": 1,
        "recorded_at": corpus["recorded_at"],
        "tool_id": CANARY_TOOL_ID,
        "status": "ready",
        "target_true_positive_count": corpus["mutant_count"],
        "target_known_false_positive_count": corpus["false_claim_count"],
        "true_positive_count": corpus["mutant_count"],
        "known_false_positive_count": corpus["false_claim_count"],
        # The gold item shape the replay/fitness readers already consume,
        # with the canary's own provenance: labels by construction.
        "true_positive_items": [
            _gold_item(item) for item in corpus["items"] if item["kind"] == "mutant"
        ],
        "known_false_positive_items": [
            _gold_item(item) for item in corpus["items"] if item["kind"] == "false_claim"
        ],
        "blocked_by": [],
        "corpus_hash": corpus["corpus_hash"],
    }
    return promote_goldset_proposal(
        tool_id=CANARY_TOOL_ID,
        curator=f"{CANARY_JUDGE_ID}:{corpus['corpus_hash'][:12]}",
        base_dir=base_dir,
        proposal=proposal,
    )


def _gold_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_type": CANARY_SOURCE_TYPE,
        "item_id": item["item_id"],
        "kind": item["kind"],
        "run_id": CANARY_TOOL_ID,
        "finding_id": item["item_id"],
        "finding_fingerprint": item["item_id"],
        "verdict": item["verdict"],
        "severity": "medium",
        "evidence_refs": [str(item["path"])],
        "defect_claim": item["defect_claim"],
        "premises": list(item["premises"]),
        "message": item["message"],
    }


def _canary_group(corpus_hash: str, item_id: str) -> str:
    return f"{CANARY_GROUP_PREFIX}{corpus_hash[:12]}:{item_id}"


def mint_canary_judgments(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    target_sha: str | None = None,
    corpus: dict[str, Any] | None = None,
    cap: int | None = None,
    drain: float | None = None,
) -> dict[str, Any]:
    """Label rows + panel envelopes for the registered corpus, under canary groups.

    HOLD, never fail: with no measured drain (the lane's cadence is the
    same explicit function of the drain as the stability lane's) nothing
    mints and the hold is recorded. Idempotent per (canary group, agent):
    a corpus is asked once per seat.
    """
    from .stability_reask import stability_budget

    root = ensure_tools_dir(base_dir)
    if corpus is None:
        from .goldset import load_active_goldset

        active = load_active_goldset(tool_id=CANARY_TOOL_ID, base_dir=root)
        if not active:
            return {"schema_version": 1, "cycle_id": cycle_id, "held": "no_registered_corpus",
                    "minted_count": 0, "labelled_count": 0, "skipped": []}
        corpus = _corpus_from_active(active)
    budget, budget_reason = stability_budget(base_dir=root, cap=cap, drain=drain)
    if budget <= 0:
        return {"schema_version": 1, "cycle_id": cycle_id, "held": budget_reason,
                "corpus_hash": corpus.get("corpus_hash"),
                "minted_count": 0, "labelled_count": 0, "skipped": []}
    existing = _existing_judge_dispatches(root)
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    labelled = 0
    labelled_groups: set[str] = set()
    for item in corpus.get("items") or []:
        item_id = str(item.get("item_id") or "")
        verdict = str(item.get("verdict") or "")
        if not item_id or verdict not in ("true_positive", "false_positive"):
            skipped.append({"item_id": item_id, "reason": "corpus_item_invalid"})
            continue
        group = _canary_group(str(corpus.get("corpus_hash") or ""), item_id)
        envelope_item = {
            "tool_id": CANARY_TOOL_ID, "run_id": CANARY_TOOL_ID,
            "finding_id": item_id, "rule": str(item.get("rule") or ""),
            "severity": "medium", "path": str(item.get("path") or ""),
            "message": str(item.get("message") or ""),
        }
        contract = _canary_contract(item)
        for role, agent in JUDGE_FANOUT:
            if len(minted) >= budget:
                skipped.append({"item_id": item_id, "target_agent": agent,
                                "reason": "canary_budget_spent"})
                continue
            if (group, agent) in existing:
                skipped.append({"item_id": item_id, "target_agent": agent,
                                "reason": "already_asked"})
                continue
            admission = admit_request(
                "mutation_canary.panel", role, base_dir=root, cycle_id=cycle_id,
            )
            if not admission.admitted:
                skipped.append({"item_id": item_id, "target_agent": agent,
                                "reason": admission.refusal})
                continue
            req = create_agent_invocation_request(
                target_agent=agent, role=role,
                **judge_request_fields(envelope_item, contract),
                evidence_refs=[str(item.get("path") or "")] or None,
                finding_id=item_id, finding_fingerprint=item_id,
                tool_id=CANARY_TOOL_ID, run_id=CANARY_TOOL_ID,
                judgment_group_id=group, cycle_id=cycle_id,
                target_sha=str(item.get("sandbox_sha") or target_sha) or None,
                base_dir=root,
                admission=admission,
            )
            minted.append({
                "request_id": req.get("request_id"), "role": role,
                "target_agent": agent, "judgment_group_id": group,
            })
            existing.add((group, agent))
        if group not in labelled_groups and any((group, _a) in existing for _r, _a in JUDGE_FANOUT):
            # The label row — by construction, never by judgment — lands in
            # the feedback ledger under the SAME group so score_judges can
            # join the panel's verdicts to it (is_calibration_truth_row).
            record_operator_feedback(
                tool_id=CANARY_TOOL_ID, run_id=CANARY_TOOL_ID, finding_id=item_id,
                verdict=verdict, severity="medium",
                note=f"canary label by construction ({item.get('kind')}), corpus {corpus.get('corpus_hash')}",
                source_type=CANARY_SOURCE_TYPE, judge_id=CANARY_JUDGE_ID,
                judgment_group_id=group, finding_fingerprint=item_id,
                base_dir=root,
            )
            labelled += 1
            labelled_groups.add(group)
    return {
        "schema_version": 1, "cycle_id": cycle_id,
        "corpus_hash": corpus.get("corpus_hash"), "budget": budget,
        "budget_reason": budget_reason, "minted_count": len(minted),
        "minted": minted, "labelled_count": labelled, "skipped": skipped,
    }


def _corpus_from_active(active: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the mint's corpus view from the registered active record."""
    items = []
    for kind, key in (("mutant", "true_positive_items"), ("false_claim", "known_false_positive_items")):
        for gold in active.get(key) or []:
            refs = [str(ref) for ref in gold.get("evidence_refs") or [] if str(ref)]
            items.append({
                "item_id": str(gold.get("finding_id") or ""),
                "kind": kind,
                "verdict": str(gold.get("verdict") or ""),
                "rule": str(gold.get("item_id") or "").replace("canary:", "", 1),
                "path": refs[0] if refs else "",
                "message": str(gold.get("message") or ""),
                "defect_claim": str(gold.get("defect_claim") or ""),
                "premises": list(gold.get("premises") or []),
                "sandbox_sha": None,
            })
    return {
        "schema_version": 1, "tool_id": CANARY_TOOL_ID,
        "corpus_hash": str(active.get("curator", "").rsplit(":", 1)[-1] or ""),
        "items": items,
    }
