#!/usr/bin/env python3
"""
Validate infrastructure/deploy/required-secrets.yaml ↔ compose ${VAR:?} SSoT.

# Purpose

This script is the Tier-1 Make-Impossible gate for the "compose file
references a required env var that is not declared in the deploy secret
manifest" failure mode. It is invoked from:

  - `.github/workflows/ci-affected.yml` pre-flight job (at PR merge time)
  - Future: `.github/workflows/deploy-digitalocean.yml` pre-flight step
    (once the hard-coded REQUIRED_SECRETS array there is migrated to
    read this manifest — currently tracked)

# Validation rules

For every compose file listed in `required-secrets.yaml[compose_files]`:

  1. Scan with regex for `${VAR:?...}` mandatory interpolations
  2. Every unique VAR found MUST have a matching entry in
     `required-secrets.yaml[secrets]`. Otherwise: DRIFT → exit 1 with an
     explicit "missing: STRIPE_SECRET_KEY" style error.
  3. Every entry in `required-secrets.yaml[secrets]` MUST appear in at
     least one compose file's `${VAR:?...}` block. Stale entries are also
     DRIFT → exit 1.
  4. Every `name:` in `required-secrets.yaml[secrets]` MUST have a
     matching `NAME=...` line in `infrastructure/deploy/ci-test.env` so
     `docker compose config --quiet` does not fail in CI on missing vars.
     Missing dummy → exit 1.
  5. Each secret's `required_by:` list MUST match the actual set of
     compose files the regex scan found it in. Drift between declared
     ownership and actual usage → exit 1.

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
CI_TEST_ENV = REPO_ROOT / "infrastructure" / "deploy" / "ci-test.env"

# Matches ${NAME:?...} — the strict-required interpolation syntax only.
# Does NOT match:
#   ${NAME:-default}  (optional-with-default)
#   ${NAME}           (optional, empty-if-unset)
#   ${NAME-default}   (optional-with-default, colon-less variant)
# By design: only `:?` fails compose at parse time, so only `:?` vars are
# "required secrets" that deploy must validate presence of.
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

    # Schema check on each secret entry
    for i, secret in enumerate(data["secrets"]):
        if not isinstance(secret, dict):
            die(f"secrets[{i}] is not a mapping", 2)
        for key in ("name", "purpose", "required_by"):
            if key not in secret:
                die(f"secrets[{i}] missing key: {key!r}", 2)
        if not isinstance(secret["required_by"], list) or not secret["required_by"]:
            die(f"secrets[{i}].required_by must be a non-empty list", 2)

    # Uniqueness of names
    names = [s["name"] for s in data["secrets"]]
    if len(names) != len(set(names)):
        seen: set[str] = set()
        dups = sorted({n for n in names if (n in seen) or seen.add(n)})  # type: ignore[func-returns-value]
        die(f"duplicate secret names: {dups}", 2)

    return data


def scan_compose_required_vars(compose_path: Path) -> set[str]:
    if not compose_path.exists():
        die(f"compose file {compose_path.relative_to(REPO_ROOT)} not found", 2)
    text = compose_path.read_text()
    return set(REQUIRED_VAR_RE.findall(text))


def load_ci_test_env_keys() -> set[str]:
    if not CI_TEST_ENV.exists():
        die(f"{CI_TEST_ENV.relative_to(REPO_ROOT)} not found", 2)
    keys: set[str] = set()
    for raw in CI_TEST_ENV.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key = line.split("=", 1)[0].strip()
        if key:
            keys.add(key)
    return keys


def main() -> int:
    manifest = load_manifest()
    compose_files = manifest["compose_files"]
    declared_secrets: dict[str, dict[str, Any]] = {s["name"]: s for s in manifest["secrets"]}
    declared_names = set(declared_secrets.keys())

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

    # Rule 1 & 2: bidirectional drift between declaration and usage.
    undeclared = sorted(actually_used - declared_names)
    stale = sorted(declared_names - actually_used)
    if undeclared:
        errors.append(
            "missing entries in infrastructure/deploy/required-secrets.yaml[secrets] "
            f"(found ${{VAR:?}} in compose but no manifest entry): {undeclared}"
        )
    if stale:
        errors.append(
            "stale entries in infrastructure/deploy/required-secrets.yaml[secrets] "
            f"(declared but no compose file uses ${{VAR:?}}): {stale}"
        )

    # Rule 3: every declared secret has a dummy in ci-test.env.
    ci_env_keys = load_ci_test_env_keys()
    missing_dummy = sorted(declared_names - ci_env_keys)
    if missing_dummy:
        errors.append(
            "missing dummy values in infrastructure/deploy/ci-test.env "
            f"(declared in manifest but CI compose parse would fail): {missing_dummy}"
        )
    # Symmetric: ci-test.env should not leak unused junk keys.
    extra_ci_env = sorted(ci_env_keys - declared_names)
    if extra_ci_env:
        errors.append(
            "extra keys in infrastructure/deploy/ci-test.env with no "
            f"corresponding manifest entry: {extra_ci_env}"
        )

    # Rule 5: `required_by` list matches actual usage per compose file.
    for name in sorted(declared_names & actually_used):
        declared_required_by = set(declared_secrets[name]["required_by"])
        actually_in = {rel for rel, vars_ in compose_vars.items() if name in vars_}
        if declared_required_by != actually_in:
            errors.append(
                f"secret `{name}` required_by drift:\n"
                f"  declared: {sorted(declared_required_by)}\n"
                f"  actual:   {sorted(actually_in)}"
            )

    if errors:
        sys.stderr.write("\n")
        sys.stderr.write(
            "Pre-flight FAIL — required-secrets manifest ↔ compose drift detected.\n"
        )
        sys.stderr.write(
            "Fix: update infrastructure/deploy/required-secrets.yaml + "
            "infrastructure/deploy/ci-test.env in the same commit as any "
            "change to `${VAR:?}` interpolations in docker-compose.*.yml.\n\n"
        )
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        sys.stderr.write("\n")
        return 1

    total = len(declared_names)
    sys.stdout.write(
        f"OK: {total} required secrets validated across "
        f"{len(compose_files)} compose file(s).\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
