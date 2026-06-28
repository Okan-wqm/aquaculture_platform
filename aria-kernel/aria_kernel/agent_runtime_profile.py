"""Per-agent runtime profile (model + reasoning effort) SSoT reader.

Plan 023 §A — model/effort tiering. Until this module existed every ARIA
agent ran on the single most expensive setting: the Codex executor forced
``model_reasoning_effort="xhigh"`` globally and the Claude-path frontmatter
``model:``/``effort:`` fields were declared but never consumed at runtime.

The fix follows the "scout-and-verify" operator decision: the cheap tier
(read-only scorers / scanners) flags candidates, the expensive tier
(planners / arbiter / writers) decides and re-verifies and never trusts the
cheap tier blindly. The agent frontmatter is the single source of truth for
which tier each agent runs on. Two backends consume it:

* Claude Code Agent dispatch honours ``model:`` natively.
* The Codex CLI executor (``tools/aria-poc/codex_runtime.py``) maps
  ``effort:`` to ``model_reasoning_effort`` via
  :func:`resolve_codex_reasoning_effort`.

This module is the only reader, so the two backends can never drift from the
frontmatter. Fail-safe by design: an unknown agent or a missing/invalid field
resolves to the most expensive tier (``opus`` / ``xhigh``). A silent cost
downgrade can therefore never be introduced by omission — only by an explicit,
reviewable frontmatter edit.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


VALID_MODELS: frozenset[str] = frozenset({"opus", "sonnet", "haiku"})
VALID_EFFORTS: frozenset[str] = frozenset({"low", "medium", "high", "xhigh"})

DEFAULT_MODEL: str = "opus"
DEFAULT_EFFORT: str = "xhigh"

# Agents that hold write tools (Edit/Write/Bash) or author governance
# artifacts MUST stay on the expensive tier — the cheap scout tier is for
# read-only judgment only. Enforced by the model-tier invariant test so a
# frontmatter edit can never quietly downgrade a writer.
WRITE_TIER_AGENTS: frozenset[str] = frozenset({
    "aria-implementer",
    "aria-drafter",
    "aria-prompt-writer",
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


def resolve_codex_reasoning_effort(
    agent_name: str,
    *,
    repo_root: str | Path | None = None,
) -> str:
    """Codex executor lever: map an agent's frontmatter ``effort`` to the
    ``model_reasoning_effort`` config value. Fail-safe to ``xhigh``."""
    return read_agent_runtime_profile(agent_name, repo_root=repo_root).effort
