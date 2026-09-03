"""Plan 020 Phase 10 — agent harness security adapter.

7 detection rules over `.claude/agents/**`, `.github/workflows/**`,
`tools/aria-{poc,adapters}/**`, `aria-kernel/**`, `aria-tools/registry.json`.

Rule taxonomy (Plan v3.3 §Phase 10.A — operator gap #9 refinement):
1. secret_leak_in_yaml_or_md
   AKIA / ghp_ / sk-ant- / password= / token= regex (sıkı; .example files
   and frontmatter <...> placeholders excluded).
2. workflow_run_or_pr_target_untrusted_checkout
   workflow_run / pull_request_target jobs that checkout
   github.event.workflow_run.head_sha or pull_request.head.sha (untrusted
   head ref). Standalone actions/checkout WITHOUT fetch-depth NOT flagged
   (false-positive eliminated per operator gap #9 refinement).
3. broad_shell_permission
   permissions: write-all OR contents: write WITHOUT scoped justification
   comment.
4. prompt_injection_surface
   agent .md frontmatter `tools:` allowlist missing OR allowed_paths: **
   glob.
5. direct_anthropic_api_usage
   import.*@anthropic-ai/sdk outside ARIA approved wrappers.
6. lease_token_in_logs
   process.stdout|console.log|print|sys.stdout argv references
   lease_token (Plan 019 Phase 8 redaction-test pattern).
7. agent_self_modification_bypass
   .claude/agents/**/*.md frontmatter `tools: [Edit, Write, ...]` would
   permit writing to .claude/agents/** paths.

Runner contract (ARIA tool_runner.run_tool):
    stdin:  JSON {cycle_id, ...}
    stdout: JSON {observations[], findings[], read_paths[],
                  evidence_sources[], cost_units, metadata}
    exit:   0 on success.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT_ENV = "ARIA_REPO_ROOT"

# Scope discipline (single source of truth — Plan 022 §C-7/§C-8 follow-up):
#   This list MUST match the manifest declaration for tool_id
#   `agent-harness-security-adapter` in `aria-tools/registry.json`,
#   `allowed_read_globs` field, modulo `aria-tools/registry.json` itself
#   which is a single file glob handled below by direct read.
#
#   Source of truth: `aria-tools/registry.json` row for
#   `agent-harness-security-adapter`. The invariant test
#   `tools/aria-poc/test_adapter_scope_narrow.py
#   ::test_agent_harness_security_adapter_scope_unchanged` pins this
#   list to the manifest declaration; if the manifest changes, the
#   test fails until the adapter is updated.
#
#   Note: `aria-tools/registry.json` is in the manifest as
#   `aria-tools/registry.json` (literal path, not a glob). It is NOT
#   appended to SCANNED_GLOBS because the registry-aware run already
#   reads the registry through the kernel; appending it here would
#   double-read. The current tuple matches every other line in the
#   manifest declaration verbatim.
SCANNED_GLOBS: tuple[str, ...] = (
    ".claude/agents/**/*.md",
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    "tools/aria-poc/**/*.py",
    "tools/aria-adapters/**/*.ts",
    "aria-kernel/aria_kernel/**/*.py",
)

# Rule 1 — secret leak.
_SECRET_RES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_pat", re.compile(r"\bghp_[A-Za-z0-9]{36,}\b")),
    ("anthropic_api_key", re.compile(r"\bsk-ant-(?:api|admin)?-?[A-Za-z0-9_\-]{20,}\b")),
    ("hardcoded_password", re.compile(r"(?i)\bpassword\s*=\s*['\"][^'\"]{4,}")),
    ("hardcoded_token", re.compile(r"(?i)\btoken\s*=\s*['\"][^'\"<{][^'\"]{4,}")),
)

# Rule 2 — untrusted head ref checkout in workflow_run/pull_request_target.
_UNTRUSTED_TRIGGER_RE = re.compile(r"^on:\s*\n(?:.|\n)*?(workflow_run|pull_request_target)", re.MULTILINE)
_UNTRUSTED_REF_RE = re.compile(
    r"actions/checkout@.*?ref:\s*\$\{\{\s*github\.event\."
    r"(?:workflow_run\.head_sha|pull_request\.head\.sha)\s*\}\}",
    re.DOTALL,
)

# Rule 3 — broad permission.
_BROAD_PERMISSION_RE = re.compile(
    r"permissions:\s*write-all|^\s*contents:\s*write\b", re.MULTILINE,
)

# Rule 4 — prompt injection surface (agent .md frontmatter).
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
_TOOLS_LINE_RE = re.compile(r"^tools:\s*(.*)$", re.MULTILINE)
_ALLOWED_PATHS_GLOB_RE = re.compile(r"allowed_paths:.*\*\*", re.IGNORECASE)

# Rule 5 — direct Anthropic API usage.
_DIRECT_ANTHROPIC_RE = re.compile(r"@anthropic-ai/sdk")
_APPROVED_WRAPPERS = ("aria-kernel/aria_kernel/llm_bridge.py",)

# Rule 6 — lease token in logs.
_LEASE_TOKEN_LOG_RE = re.compile(
    r"(?:print|console\.log|process\.stdout|sys\.stdout|logger\.\w+)\s*\(.*lease_token"
)

# Rule 7 — agent self-modification.
_AGENT_WRITE_TOOLS_RE = re.compile(r"tools:.*(Edit|Write).*", re.IGNORECASE)


def _resolve_repo_root() -> Path:
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for candidate in [here, *here.parents]:
        if (candidate / "package.json").exists():
            return candidate
    return here


def _iter_scanned_files(repo_root: Path) -> list[Path]:
    matches: list[Path] = []
    for pattern in SCANNED_GLOBS:
        for path in repo_root.glob(pattern):
            if not path.is_file():
                continue
            rel = path.relative_to(repo_root).as_posix()
            if rel.endswith(".example") or "node_modules/" in rel:
                continue
            matches.append(path)
    return matches


def _check_secret_leak(rel_path: str, content: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for label, pattern in _SECRET_RES:
        for match in pattern.finditer(content):
            line_no = content[: match.start()].count("\n") + 1
            findings.append({
                "rule": "secret_leak_in_yaml_or_md",
                "label": label,
                "ref": f"{rel_path}:{line_no}",
                "severity": "CRITICAL",
            })
    return findings


def _check_untrusted_checkout(rel_path: str, content: str) -> list[dict[str, Any]]:
    if not (rel_path.startswith(".github/workflows/")):
        return []
    if not _UNTRUSTED_TRIGGER_RE.search(content):
        return []
    if not _UNTRUSTED_REF_RE.search(content):
        return []
    return [{
        "rule": "workflow_run_or_pr_target_untrusted_checkout",
        "ref": rel_path,
        "severity": "HIGH",
    }]


def _check_broad_permission(rel_path: str, content: str) -> list[dict[str, Any]]:
    if not (rel_path.startswith(".github/workflows/")):
        return []
    findings: list[dict[str, Any]] = []
    for match in _BROAD_PERMISSION_RE.finditer(content):
        line_no = content[: match.start()].count("\n") + 1
        # Look back 3 lines for a justification comment containing 'reason'.
        chunk = "\n".join(content.splitlines()[max(0, line_no - 3): line_no - 1])
        if "reason" in chunk.lower():
            continue
        findings.append({
            "rule": "broad_shell_permission",
            "match": match.group(0),
            "ref": f"{rel_path}:{line_no}",
            "severity": "MEDIUM",
        })
    return findings


def _check_prompt_injection_surface(rel_path: str, content: str) -> list[dict[str, Any]]:
    if not rel_path.startswith(".claude/agents/"):
        return []
    fm_match = _FRONTMATTER_RE.search(content)
    if not fm_match:
        # Non-agent doc (README etc.) — skip per Phase 11 doc-vs-agent
        # heuristic.
        return []
    fm = fm_match.group(1)
    findings: list[dict[str, Any]] = []
    if not _TOOLS_LINE_RE.search(fm):
        findings.append({
            "rule": "prompt_injection_surface",
            "subkind": "tools_allowlist_missing",
            "ref": rel_path,
            "severity": "HIGH",
        })
    if _ALLOWED_PATHS_GLOB_RE.search(fm):
        findings.append({
            "rule": "prompt_injection_surface",
            "subkind": "allowed_paths_double_star",
            "ref": rel_path,
            "severity": "MEDIUM",
        })
    return findings


def _check_direct_anthropic_usage(rel_path: str, content: str) -> list[dict[str, Any]]:
    if rel_path in _APPROVED_WRAPPERS:
        return []
    if not _DIRECT_ANTHROPIC_RE.search(content):
        return []
    return [{
        "rule": "direct_anthropic_api_usage",
        "ref": rel_path,
        "severity": "HIGH",
    }]


def _check_lease_token_in_logs(rel_path: str, content: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for match in _LEASE_TOKEN_LOG_RE.finditer(content):
        line_no = content[: match.start()].count("\n") + 1
        findings.append({
            "rule": "lease_token_in_logs",
            "ref": f"{rel_path}:{line_no}",
            "severity": "CRITICAL",
        })
    return findings


def _check_agent_self_modification(rel_path: str, content: str) -> list[dict[str, Any]]:
    if not rel_path.startswith(".claude/agents/"):
        return []
    fm_match = _FRONTMATTER_RE.search(content)
    if not fm_match:
        return []
    fm = fm_match.group(1)
    if _AGENT_WRITE_TOOLS_RE.search(fm):
        return [{
            "rule": "agent_self_modification_bypass",
            "ref": rel_path,
            "severity": "HIGH",
        }]
    return []


def scan(repo_root: Path) -> dict[str, Any]:
    """Run all 7 rules across the scanned glob set; return ARIA envelope."""
    findings: list[dict[str, Any]] = []
    read_paths: list[str] = []
    for path in _iter_scanned_files(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        read_paths.append(rel)
        for fn in (
            _check_secret_leak,
            _check_untrusted_checkout,
            _check_broad_permission,
            _check_prompt_injection_surface,
            _check_direct_anthropic_usage,
            _check_lease_token_in_logs,
            _check_agent_self_modification,
        ):
            findings.extend(fn(rel, content))
    return {
        "observations": [],
        "findings": findings,
        "read_paths": read_paths[:200],  # cap to keep envelope small
        "evidence_sources": [f["ref"] for f in findings],
        "cost_units": len(read_paths),
        "metadata": {
            "rule_count": 7,
            "scanned_file_count": len(read_paths),
            "finding_count": len(findings),
        },
    }


def main() -> int:
    try:
        json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        pass
    repo_root = _resolve_repo_root()
    envelope = scan(repo_root)
    print(json.dumps(envelope))
    return 0


if __name__ == "__main__":
    sys.exit(main())
