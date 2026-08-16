"""Per-agent runtime profile (model + reasoning effort) SSoT reader.

Plan 023 §A — model/effort tiering. Until this module existed every ARIA
agent ran on the single most expensive setting and the frontmatter
``model:``/``effort:`` fields were declared but never consumed at runtime.

The fix follows the "scout-and-verify" operator decision: the cheap tier
(read-only scorers / scanners) flags candidates, the expensive tier
(planners / arbiter / writers) decides and re-verifies and never trusts the
cheap tier blindly. The agent frontmatter is the single source of truth for
which tier each agent runs on. Two backends consume it:

* Claude Code Agent dispatch honours ``model:`` natively.
* The Claude Code CLI executor (``tools/aria-poc/claude_runtime.py``) resolves
  ``model:`` to the ``--model`` alias via :func:`resolve_claude_model`.

This module is the only reader, so both consumers can never drift from the
frontmatter. Fail-safe by design: an unknown agent or a missing/invalid field
resolves to the most expensive tier (``fable`` / ``max``). A silent cost
downgrade can therefore never be introduced by omission — only by an explicit,
reviewable frontmatter edit.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


VALID_MODELS: frozenset[str] = frozenset({"opus", "sonnet", "haiku", "fable"})
VALID_EFFORTS: frozenset[str] = frozenset({"low", "medium", "high", "xhigh", "max"})

DEFAULT_MODEL: str = "fable"

# E16 (ORPHAN-673) — model-tier write protection SSoT (operator rule
# 2026-08-13): a weaker model must never delete or overwrite what a
# stronger model authored, and models below the authoring floor must not
# author agents at all. Strongest first; future stronger models are
# PREPENDED here deliberately — never inferred.
MODEL_TIER_ORDER: tuple[str, ...] = ("fable", "opus", "sonnet", "haiku")
MIN_AGENT_AUTHORING_TIER: str = "opus"


def model_tier_rank(model: str | None) -> int:
    """Rank in MODEL_TIER_ORDER; lower is stronger.

    Unknown models resolve ASYMMETRICALLY by design: as a TARGET's author
    they rank strongest (-1) — an agent stamped by a model this kernel
    does not know is most plausibly a FUTURE, stronger model and must be
    protected; as an ACTIVE actor they rank weakest (len) — a model that
    cannot prove its tier may neither author nor modify. Callers pick the
    side via the dedicated asserts below.
    """
    if model in MODEL_TIER_ORDER:
        return MODEL_TIER_ORDER.index(model)
    return -1


def _active_model_rank(model: str | None) -> int:
    if model in MODEL_TIER_ORDER:
        return MODEL_TIER_ORDER.index(model)
    return len(MODEL_TIER_ORDER)


def assert_model_may_author_agents(model: str | None) -> None:
    """E16 authoring floor: below MIN_AGENT_AUTHORING_TIER cannot author."""
    from .tool_registry import GovernanceError

    if _active_model_rank(model) > MODEL_TIER_ORDER.index(MIN_AGENT_AUTHORING_TIER):
        raise GovernanceError(
            f"agent_authoring_tier_too_low: model={model!r} "
            f"floor={MIN_AGENT_AUTHORING_TIER!r} order={MODEL_TIER_ORDER!r}"
        )


def assert_model_may_modify_agent(
    *, active_model: str | None, target_authored_by: str | None
) -> None:
    """E16 write protection: weaker may not overwrite stronger's work.

    An UNSTAMPED target (legacy agents predating authored_by_model) is
    modifiable by any authoring-eligible model — the rule protects
    provenance that exists, it does not invent provenance. The duel has
    NO exception: a lower-tier duel winner still cannot supersede a
    higher-tier agent directly; that path must fall to HUMAN_REQUIRED.
    """
    from .tool_registry import GovernanceError

    if not target_authored_by:
        return
    if _active_model_rank(active_model) > model_tier_rank(target_authored_by):
        raise GovernanceError(
            "model_tier_insufficient_to_modify: "
            f"active={active_model!r} target_authored_by={target_authored_by!r} "
            f"order={MODEL_TIER_ORDER!r} (duel has no exception — escalate "
            "to HUMAN_REQUIRED)"
        )
# ORPHAN-HIGH-477 — ultracode depth. `max` is the CLI's deepest reasoning
# level (verified against Claude Code 2.1.220: --effort low|medium|high|xhigh|max).
# The fail-safe deliberately resolves UPWARD, so an unknown agent or an
# unparseable frontmatter field can never quietly run shallower than policy.
DEFAULT_EFFORT: str = "max"

# Agents that hold write tools (Edit/Write/Bash) or author governance
# artifacts MUST stay on the expensive tier — the cheap scout tier is for
# read-only judgment only. Enforced by the model-tier invariant test so a
# frontmatter edit can never quietly downgrade a writer.
WRITE_TIER_AGENTS: frozenset[str] = frozenset({
    "aria-implementer",
    "aria-drafter",
    "aria-prompt-writer",
    # Plan 030 / K3 — write-capable agents the jest mirror already pinned;
    # the two sets must never diverge (ORPHAN-HIGH-285).
    "aria-acceptance-gap-fixer",
    "aria-worker",
})

_FRONTMATTER_RX = re.compile(r"\A---\n(.*?)\n---", re.DOTALL)


@dataclass(frozen=True)
class AgentRuntimeProfile:
    """Resolved tier for one agent. ``source`` records how it was derived."""

    agent_name: str
    model: str
    effort: str
    source: str  # "frontmatter" | "default_missing_file" | "default_invalid"


def _repo_root() -> Path:
    # <repo>/aria-kernel/aria_kernel/agent_runtime_profile.py
    return Path(__file__).resolve().parents[2]


def _agents_dir(repo_root: Path | None) -> Path:
    return (repo_root or _repo_root()) / ".claude" / "agents"


def _find_agent_file(agent_name: str, repo_root: Path | None) -> Path | None:
    base = _agents_dir(repo_root)
    if not base.exists():
        return None
    direct = base / f"{agent_name}.md"
    if direct.is_file():
        return direct
    matches = sorted(base.glob(f"**/{agent_name}.md"))
    return matches[0] if matches else None


def _parse_frontmatter_field(text: str, field: str) -> str | None:
    match = _FRONTMATTER_RX.match(text)
    if not match:
        return None
    fm = match.group(1)
    field_match = re.search(rf"^{re.escape(field)}:\s*(\S+)\s*$", fm, re.MULTILINE)
    if not field_match:
        return None
    return field_match.group(1).strip().strip("\"'").lower()


@lru_cache(maxsize=256)
def _read_profile_cached(agent_name: str, repo_root_str: str | None) -> AgentRuntimeProfile:
    repo_root = Path(repo_root_str) if repo_root_str else None
    path = _find_agent_file(agent_name, repo_root)
    if path is None:
        return AgentRuntimeProfile(agent_name, DEFAULT_MODEL, DEFAULT_EFFORT, "default_missing_file")
    text = path.read_text(encoding="utf-8")
    raw_model = _parse_frontmatter_field(text, "model")
    raw_effort = _parse_frontmatter_field(text, "effort")
    model = raw_model if raw_model in VALID_MODELS else DEFAULT_MODEL
    effort = raw_effort if raw_effort in VALID_EFFORTS else DEFAULT_EFFORT
    source = "frontmatter"
    if raw_model not in VALID_MODELS or raw_effort not in VALID_EFFORTS:
        source = "default_invalid"
    return AgentRuntimeProfile(agent_name, model, effort, source)


def read_agent_runtime_profile(
    agent_name: str,
    *,
    repo_root: str | Path | None = None,
) -> AgentRuntimeProfile:
    """Resolve the (model, effort) tier declared in an agent's frontmatter.

    Fail-safe: unknown agent or invalid/missing field → most expensive tier.
    """
    if not isinstance(agent_name, str) or not agent_name.strip():
        return AgentRuntimeProfile(str(agent_name), DEFAULT_MODEL, DEFAULT_EFFORT, "default_invalid")
    root_str = str(Path(repo_root).resolve()) if repo_root is not None else None
    return _read_profile_cached(agent_name.strip(), root_str)


def resolve_claude_model(
    agent_name: str,
    *,
    repo_root: str | Path | None = None,
) -> str:
    """Claude Code CLI executor lever: resolve an agent's frontmatter
    ``model`` tier to the ``--model`` alias the CLI consumes. Fail-safe to
    the most expensive tier for unknown agents or invalid fields."""
    return read_agent_runtime_profile(agent_name, repo_root=repo_root).model


def resolve_claude_effort(
    agent_name: str,
    *,
    repo_root: str | Path | None = None,
) -> str:
    """Claude Code CLI executor lever: resolve an agent's frontmatter
    ``effort`` tier to the ``--effort`` level the CLI consumes. Shares the
    fail-safe path with :func:`resolve_claude_model` (most expensive tier)."""
    return read_agent_runtime_profile(agent_name, repo_root=repo_root).effort

# E16 — the provenance stamp lives WITH the tier order: stamping is a
# governance concern of the runtime-profile SSoT, not draft rendering
# (agent_genesis is barred from markdown/frontmatter literals by
# I-V3-12c, and rightly so — the kernel governs provenance, the drafter
# renders content).
def parse_authored_by_model(text: str) -> str | None:
    match = re.search(
        r"^authored_by_model:\s*([A-Za-z0-9._-]+)\s*$", text, flags=re.MULTILINE
    )
    return match.group(1) if match else None


def stamp_authored_by_model(body: str, model: str) -> str:
    """Kernel-injected provenance stamp (E16). A drafter-supplied value
    is OVERWRITTEN — the stamp is measured at mint, never claimed."""
    if parse_authored_by_model(body) is not None:
        return re.sub(
            r"^authored_by_model:\s*[A-Za-z0-9._-]+\s*$",
            f"authored_by_model: {model}",
            body,
            count=1,
            flags=re.MULTILINE,
        )
    if body.startswith("---\n"):
        return body.replace("---\n", f"---\nauthored_by_model: {model}\n", 1)
    return f"---\nauthored_by_model: {model}\n---\n{body}"
