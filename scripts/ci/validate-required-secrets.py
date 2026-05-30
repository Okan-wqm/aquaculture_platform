#!/usr/bin/env python3
"""
Validate infrastructure/deploy/required-secrets.yaml ↔ compose ${VAR:?} SSoT.

# Purpose

This script is the Tier-1 Make-Impossible gate for the "compose file
references a required env var that is not declared in the deploy manifest"
failure mode. It is invoked from:

  - `.github/workflows/ci-affected.yml` pre-flight job (at PR merge time)
  - Future: `.github/workflows/deploy-digitalocean.yml` pre-flight step
    (once the hard-coded REQUIRED_SECRETS array there is migrated to
    read this manifest — currently tracked)

# Validation rules

For every compose file listed in `required-secrets.yaml[compose_files]`:

  1. Scan with regex for `${VAR:?...}` mandatory interpolations
  2. Every unique VAR found MUST have a matching entry in either
     `required-secrets.yaml[secrets]` or
     `required-secrets.yaml[runtime_required_env]`. Otherwise: DRIFT →
     exit 1 with an explicit "missing: STRIPE_SECRET_KEY" style error.
  3. Every entry in both sections MUST appear in at least one compose
     file's `${VAR:?...}` block. Stale entries are also DRIFT → exit 1.
  4. Each entry's `required_by:` list MUST match the actual set of compose
     files the regex scan found it in. Drift between declared ownership
     and actual usage → exit 1.

# Why no ci-test.env check

A previous version of this script also asserted that every declared
secret had a dummy line in `infrastructure/deploy/ci-test.env`. That
rule (and the symmetric "no extra keys" rule) was removed once the CI
pre-flight job adopted `scripts/ci/preflight-validate.ts`, which derives
the throwaway env from the compose file at run time — Tier-2
Make-Automatic per CLAUDE.md hierarchy. The hand-maintained ci-test.env
is the drift surface the auto-derive design eliminates, so the check
that asserted its content is no longer load-bearing.

# Exit codes

  0  all invariants hold
  1  drift detected (missing, stale, or mis-declared)
  2  manifest or compose file missing / malformed

# Why Python + PyYAML

Same rationale as `scripts/nats/generate-nats-conf.py` (its sibling):
universally available, no extra tool dependency, and keeps the validator
auditable in a single file. Bash+yq+jq would be fragile.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore[import-untyped]
except ImportError:
    sys.stderr.write(
        "error: PyYAML not available. Install via `pip install pyyaml` "
        "or `apt-get install python3-yaml`.\n"
    )
    sys.exit(2)


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "infrastructure" / "deploy" / "required-secrets.yaml"

# Matches ${NAME:?...} — the strict-required interpolation syntax only.
# Does NOT match:
#   ${NAME:-default}  (optional-with-default)
#   ${NAME}           (optional, empty-if-unset)
#   ${NAME-default}   (optional-with-default, colon-less variant)
# By design: only `:?` fails compose at parse time, so only `:?` vars are
# "required deploy inputs" that the manifest must classify as either
# operator-provisioned secrets or non-secret runtime values supplied by
# deployment automation.
REQUIRED_VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*):\?")


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"error: {msg}\n")
    sys.exit(code)


def load_manifest() -> dict[str, Any]:
    if not MANIFEST.exists():
        die(f"{MANIFEST.relative_to(REPO_ROOT)} not found", 2)

    with MANIFEST.open() as f:
        data = yaml.safe_load(f)

    if not isinstance(data, dict):
        die(f"{MANIFEST.relative_to(REPO_ROOT)} is not a YAML mapping", 2)

    if data.get("version") != 1:
        die(
            f"{MANIFEST.relative_to(REPO_ROOT)} version mismatch — "
            f"expected 1, got {data.get('version')!r}",
            2,
        )

    if not isinstance(data.get("compose_files"), list) or not data["compose_files"]:
        die(f"{MANIFEST.relative_to(REPO_ROOT)} missing non-empty `compose_files` list", 2)

    if not isinstance(data.get("secrets"), list) or not data["secrets"]:
        die(f"{MANIFEST.relative_to(REPO_ROOT)} missing non-empty `secrets` list", 2)

    runtime_required_env = data.get("runtime_required_env", [])
    if not isinstance(runtime_required_env, list):
        die(f"{MANIFEST.relative_to(REPO_ROOT)} `runtime_required_env` must be a list", 2)

    # Schema check on each manifest entry.
    for section in ("secrets", "runtime_required_env"):
        for i, entry in enumerate(data.get(section, [])):
            if not isinstance(entry, dict):
                die(f"{section}[{i}] is not a mapping", 2)
            for key in ("name", "purpose", "required_by"):
                if key not in entry:
                    die(f"{section}[{i}] missing key: {key!r}", 2)
            if not isinstance(entry["required_by"], list) or not entry["required_by"]:
                die(f"{section}[{i}].required_by must be a non-empty list", 2)

    # Uniqueness of names across both sections. A variable is either a
    # secret or deployment runtime metadata, never both.
    names = [s["name"] for s in data["secrets"]] + [
        e["name"] for e in runtime_required_env
    ]
    if len(names) != len(set(names)):
        seen: set[str] = set()
        dups = sorted({n for n in names if (n in seen) or seen.add(n)})  # type: ignore[func-returns-value]
        die(f"duplicate required env names: {dups}", 2)

    return data


def scan_compose_required_vars(compose_path: Path) -> set[str]:
    if not compose_path.exists():
        die(f"compose file {compose_path.relative_to(REPO_ROOT)} not found", 2)
    text = compose_path.read_text()
    return set(REQUIRED_VAR_RE.findall(text))


def main() -> int:
    manifest = load_manifest()
    compose_files = manifest["compose_files"]
    sections: dict[str, dict[str, dict[str, Any]]] = {
        "secrets": {s["name"]: s for s in manifest["secrets"]},
        "runtime_required_env": {
            e["name"]: e for e in manifest.get("runtime_required_env", [])
        },
    }
    declared_entries: dict[str, dict[str, Any]] = {}
    declared_sections_by_name: dict[str, str] = {}
    for section, entries in sections.items():
        for name, entry in entries.items():
            declared_entries[name] = entry
            declared_sections_by_name[name] = section
    declared_names = set(declared_entries.keys())

    # Scan every compose file for its set of required vars.
    compose_vars: dict[str, set[str]] = {}
    for rel in compose_files:
        path = REPO_ROOT / rel
        compose_vars[rel] = scan_compose_required_vars(path)

    # Union of every required var across every listed compose file.
    actually_used: set[str] = set()
    for vars_ in compose_vars.values():
        actually_used |= vars_

    errors: list[str] = []

    # Rules 2 & 3: bidirectional drift between declaration and usage.
    undeclared = sorted(actually_used - declared_names)
    if undeclared:
        errors.append(
            "missing entries in infrastructure/deploy/required-secrets.yaml "
            "(found ${VAR:?} in compose but no `secrets` or "
            f"`runtime_required_env` entry): {undeclared}"
        )
    for section, entries in sections.items():
        stale = sorted(set(entries) - actually_used)
        if stale:
            errors.append(
                f"stale entries in infrastructure/deploy/required-secrets.yaml[{section}] "
                f"(declared but no compose file uses ${{VAR:?}}): {stale}"
            )

    # Rule 4: `required_by` list matches actual usage per compose file.
    for name in sorted(declared_names & actually_used):
        declared_required_by = set(declared_entries[name]["required_by"])
        actually_in = {rel for rel, vars_ in compose_vars.items() if name in vars_}
        if declared_required_by != actually_in:
            errors.append(
                f"{declared_sections_by_name[name]} `{name}` required_by drift:\n"
                f"  declared: {sorted(declared_required_by)}\n"
                f"  actual:   {sorted(actually_in)}"
            )

    if errors:
        sys.stderr.write("\n")
        sys.stderr.write(
            "Pre-flight FAIL — required-secrets manifest ↔ compose drift detected.\n"
        )
        sys.stderr.write(
            "Fix: update infrastructure/deploy/required-secrets.yaml in the "
            "same commit as any change to `${VAR:?}` interpolations in "
            "docker-compose.*.yml.\n\n"
        )
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        sys.stderr.write("\n")
        return 1

    total_secrets = len(sections["secrets"])
    total_runtime = len(sections["runtime_required_env"])
    sys.stdout.write(
        f"OK: {total_secrets} required secrets and {total_runtime} runtime "
        f"required env vars validated across "
        f"{len(compose_files)} compose file(s).\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
