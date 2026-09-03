"""Real banned-phrase adapter (Plan 017 Phase 5.1, partial DEBT-2026-05-07-003 closure).

Wraps the existing tools/gates/banned-phrase.ts Node CLI as an ARIA
adapter. The Node CLI scans staged or ranged content for the CLAUDE.md
banned phrase list; this adapter parses the CLI's output (stdout text +
exit code) and emits the ARIA observation/finding shape the kernel
runner contract expects.

Distinct from `shadow_runner.py`: that stub returns a fixed empty
payload regardless of input. This adapter actually invokes the gate,
so SHADOW runs against a non-empty staged diff produce real
observations and the dashboard's adapter SHADOW evidence count moves
from zero.

Runner contract (ARIA tool_runner.run_tool):
    stdin: JSON {cycle_id, ...}
    stdout: JSON {observations[], findings[], read_paths[],
                  evidence_sources[], cost_units, metadata}
    exit code: 0 on success
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT_ENV = "ARIA_REPO_ROOT"
GATE_TS_NODE = Path("./node_modules/.bin/ts-node")
GATE_TSCONFIG = Path("tools/gates/tsconfig.json")
GATE_SCRIPT = Path("tools/gates/banned-phrase.ts")


def _resolve_repo_root() -> Path:
    """Use env override when set; otherwise walk up from CWD until package.json."""
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for candidate in [here, *here.parents]:
        if (candidate / "package.json").exists() and (candidate / "tools" / "gates").exists():
            return candidate
    return here


def _invoke_banned_phrase_cli(repo_root: Path, mode: str = "staged") -> tuple[int, str]:
    """Invoke the Node banned-phrase gate. Return (exit_code, stdout+stderr_text)."""
    ts_node = repo_root / GATE_TS_NODE
    script = repo_root / GATE_SCRIPT
    tsconfig = repo_root / GATE_TSCONFIG
    if not ts_node.exists() or not script.exists():
        return 127, f"banned-phrase CLI unavailable at {ts_node} / {script}"
    proc = subprocess.run(
        [str(ts_node), "--project", str(tsconfig), str(script), f"--mode={mode}"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _parse_violations(text: str) -> list[dict]:
    """Parse the CLI's stdout/stderr into structured violation dicts.

    The Node CLI prints lines of the form:
        <source>:<line>:<column>  "<phrase>"
            > <context line>
    """
    violations: list[dict] = []
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        stripped = line.strip()
        # Match the source:line:column "<phrase>" header line.
        # Be liberal — any line containing a quoted phrase + colon position.
        if '"' not in stripped or ':' not in stripped:
            continue
        # Look for the pattern: prefix has 2+ colons + quoted phrase.
        # Avoid matching the kernel's own help text.
        parts = stripped.split('"')
        if len(parts) < 3:
            continue
        head = parts[0].strip().rstrip(' ')
        phrase = parts[1].strip()
        if not phrase or '/' not in head and ':' not in head:
            continue
        # Try to extract source:line:column from head.
        # head looks like: "apps/foo.ts:42:7  " (with trailing whitespace).
        head_parts = head.rstrip().rsplit(':', 2)
        if len(head_parts) != 3:
            continue
        source, line_no, col = head_parts
        try:
            line_int = int(line_no.strip())
            col_int = int(col.strip())
        except ValueError:
            continue
        # Capture the next "    > <context>" line if present.
        context = ""
        if idx + 1 < len(lines):
            nxt = lines[idx + 1].strip()
            if nxt.startswith("> "):
                context = nxt[2:].strip()
        violations.append(
            {
                "source": source.strip(),
                "line": line_int,
                "column": col_int,
                "phrase": phrase,
                "context": context,
            }
        )
    return violations


def _violation_to_observation(v: dict, cycle_id: str, idx: int) -> dict:
    """Convert a parsed violation into an ARIA observation row."""
    fingerprint = hashlib.sha256(
        f"{v['source']}:{v['line']}:{v['phrase']}".encode("utf-8"),
    ).hexdigest()[:12]
    return {
        "observation_id": f"obs:banned-phrase-adapter:{fingerprint}:{cycle_id}",
        "summary": f"banned phrase '{v['phrase']}' at {v['source']}:{v['line']}:{v['column']}",
        "severity": "info",
        "evidence": [{"path": v["source"], "line": v["line"]}],
        "metadata": {
            "phrase": v["phrase"],
            "context": v["context"],
            "column": v["column"],
        },
    }


def main() -> int:
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {}
    cycle_id = payload.get("cycle_id", "unknown-cycle")
    mode = payload.get("mode", "staged")

    repo_root = _resolve_repo_root()
    exit_code, output_text = _invoke_banned_phrase_cli(repo_root, mode=mode)
    violations = _parse_violations(output_text) if exit_code != 0 else []

    # Tool execution and scan result are different typed states. The
    # banned-phrase CLI exits 0 clean, 1 with violations, 2 on its own
    # errors (and 127 never runs). A non-zero exit with NO parseable
    # violations is therefore never a clean scan: it is a scanner that
    # did not run or did not speak its protocol. Reporting zero
    # observations for that (the audit reproduction: exit 127 read as
    # "no banned phrases") turns a dead security gate into a green one.
    if exit_code != 0 and not violations:
        sys.stdout.write(json.dumps({
            "observations": [],
            "findings": [],
            "read_paths": [],
            "evidence_sources": [],
            "cost_units": 0,
            "status": "unavailable",
            "metadata": {
                "adapter": "banned-phrase-adapter",
                "phase": "shadow",
                "mode": mode,
                "exit_code": exit_code,
                "violation_count": 0,
                "reason": "banned-phrase CLI failed without a parseable result",
            },
        }))
        return exit_code or 1

    body = {
        "observations": [
            _violation_to_observation(v, cycle_id, idx)
            for idx, v in enumerate(violations)
        ],
        # SHADOW emits observations only — never operator-facing findings.
        # Promotion to findings happens through the operator-supervised
        # gate_apply_action + suppression scanner pipeline.
        "findings": [],
        "read_paths": [str(v["source"]) for v in violations],
        "evidence_sources": [
            {"path": v["source"], "line": v["line"]} for v in violations
        ],
        "cost_units": 1,
        "metadata": {
            "adapter": "banned-phrase-adapter",
            "phase": "shadow",
            "mode": mode,
            "exit_code": exit_code,
            "violation_count": len(violations),
        },
    }
    sys.stdout.write(json.dumps(body))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
