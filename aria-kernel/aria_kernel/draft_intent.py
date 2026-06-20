"""Plan ARIA-V3 §A3 + §2b — typed DraftIntent split (Agent vs Skill).

GAP-4 architectural pivot: pre-V3 ``_render_agent_markdown`` and
``_render_skill`` were template renderers — they returned static
markdown stubs with no behaviour. The actual body had to be hand-
filled by an operator (or a Claude Code session) before
materialization. The kernel's "draft" was metadata + boilerplate,
not a behavior contract.

V3 inverts the responsibility: the kernel emits a structured
``DraftIntent`` (grammar of required sections + observation-derived
constraints + acceptance tests + evidence allowlist + diff
classifier lane + banned phrases). Body synthesis is delegated to
``tools/aria-poc/worker_executor.py`` which spawns
``claude code agent --subagent-type aria-drafter --intent-file
<intent.json> --output-path <draft.md>``. The kernel then VALIDATES
the returned body against the intent's grammar; reject → retry
with complaint; escalate after N failures. SPEC §5.4 preserved
(kernel never invokes ``Agent()`` directly; the subprocess
boundary in worker_executor is the existing seam).

Two concrete intent types — agent vs skill — split via the type
system (HIGH-V3-008 closure). No runtime ``kind`` switch; ``draft_validator.validate``
dispatches via overload on the dataclass type.

Plan-026R discipline: invariant tests I-V3-07a/b lock the dataclass
shapes; I-V3-12a/b lock the return-type contracts at the call
boundary.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any


# Plan ARIA-V3 §A3 banned-phrase list MUST mirror CLAUDE.md so a
# drafter that wants to slip "for now" / "interim" / "temporary" /
# etc. into the body is rejected by draft_validator. Sourced from
# CLAUDE.md "Phrases BANNED as gating excuses" section.
BANNED_PHRASES_DEFAULT: tuple[str, ...] = (
    "for now",
    "interim solution",
    "temporary",
    "pragmatic",
    "simpler approach",
    "middle ground",
    "for momentum",
    "just this commit",
    "deferred",
    "out of scope",
    "good enough",
    "sufficient for now",
)


@dataclass(frozen=True)
class AcceptanceTest:
    """A single fixture the drafter must wire into the body."""

    name: str
    expected: str
    description: str = ""


@dataclass(frozen=True)
class AgentDraftIntent:
    """Plan ARIA-V3 §A3 — kernel-emitted grammar for an agent draft.

    Consumed by:
      * ``draft_validator.validate(intent, body)`` — section presence,
        banned-phrase scan, evidence-ref allowlist, diff classifier.
      * ``worker_executor.py`` (via JSON serialisation) — payload
        passed as ``--intent-file`` when spawning claude code agent.
      * ``materialize_agent_draft`` (Phase A4) — gate on body matching
        intent grammar BEFORE writing the target file.
    """

    intent_kind: str  # "agent"
    intent_id: str
    name: str
    target_path: str  # ``.claude/agents/<name>.md``
    purpose: str
    required_sections: tuple[str, ...]
    scope_globs: tuple[str, ...]
    forbidden_globs: tuple[str, ...]
    evidence_contract: str
    output_schema: dict[str, Any]
    acceptance_tests: tuple[AcceptanceTest, ...]
    evidence_allowlist: tuple[str, ...]
    diff_classifier_lane: str  # current live default: "L0-main"
    banned_phrases: tuple[str, ...] = BANNED_PHRASES_DEFAULT
    related_existing_agents: tuple[str, ...] = field(default_factory=tuple)
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return _intent_to_dict(self)

    def to_intent_file(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)


@dataclass(frozen=True)
class SkillDraftIntent:
    """Plan ARIA-V3 §A3 — kernel-emitted grammar for a skill draft.

    Skills differ structurally from agents:
      * They carry shadow_period / precision_threshold (SPEC §4
        Engine 4 — shadow → active pipeline).
      * They materialise to ``aria-grown/skills/<name>/`` rather than
        ``.claude/agents/<name>.md``.
      * They have explicit handoff agent list (which agents resume
        work after the skill emits a result).

    The type split (HIGH-V3-008) means ``draft_validator.validate``
    knows which grammar to enforce from the input type alone — no
    runtime ``kind`` switch needed.
    """

    intent_kind: str  # "skill"
    intent_id: str
    name: str
    target_path: str  # e.g. ``aria-grown/skills/<name>``
    description: str
    required_sections: tuple[str, ...]
    owners: tuple[str, ...]
    handoff_agents: tuple[str, ...]
    shadow_period_days: int
    precision_threshold: float
    acceptance_tests: tuple[AcceptanceTest, ...]
    evidence_allowlist: tuple[str, ...]
    diff_classifier_lane: str
    banned_phrases: tuple[str, ...] = BANNED_PHRASES_DEFAULT
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return _intent_to_dict(self)

    def to_intent_file(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)


def _intent_to_dict(intent: AgentDraftIntent | SkillDraftIntent) -> dict[str, Any]:
    """Serialise an intent for the ``--intent-file`` boundary.

    ``dataclasses.asdict`` flattens tuples to lists which is exactly
    what JSON needs. Acceptance tests become a list of dicts via
    their own dataclass conversion.
    """
    return asdict(intent)


__all__ = [
    "AcceptanceTest",
    "AgentDraftIntent",
    "BANNED_PHRASES_DEFAULT",
    "SkillDraftIntent",
]
