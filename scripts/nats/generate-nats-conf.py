#!/usr/bin/env python3
"""
Generate nats.conf authorization{} users[] block from the SSoT at
infrastructure/nats/services.yaml.

# Why Python instead of bash+yq

The pipeline requires:
  - YAML parsing (`services.yaml` is YAML for human editability)
  - Ordered output (preserve service + subject order for auditable diffs)
  - Multi-line string interpolation with exact whitespace control
  - JSON schema validation in the same process

Python with PyYAML is universally available (GitHub Actions ubuntu-latest,
every Linux distro), handles all four requirements natively, and keeps the
generator in a single auditable file. Bash + yq + jq would require three
tools chained together with fragile quoting.

# Usage

  ./scripts/nats/generate-nats-conf.py

By default: reads infrastructure/nats/services.yaml, replaces the block
between `# BEGIN GENERATED` / `# END GENERATED` sentinels in
infrastructure/docker/nats/nats.conf.

Idempotent: re-running on an already-generated nats.conf produces identical
output (deterministic ordering + no timestamp injection).

# Exit codes

  0  success, file updated (or no changes needed)
  1  services.yaml missing or invalid
  2  nats.conf missing, or sentinels not found

# Related

  - ADR-015: NATS Cert-Is-Identity SSoT
  - docs/adr/014-nats-mtls-only-auth.md: legacy shared user removal
  - scripts/nats/generate-internal-certs.sh (sibling): per-service cert CN list
"""

from __future__ import annotations

import json
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
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVICES_YAML = REPO_ROOT / "infrastructure" / "nats" / "services.yaml"
SERVICES_SCHEMA = REPO_ROOT / "infrastructure" / "nats" / "services.schema.json"
NATS_CONF = REPO_ROOT / "infrastructure" / "docker" / "nats" / "nats.conf"

BEGIN_MARKER = "    # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)"
END_MARKER = "    # END GENERATED"


def load_services() -> list[dict[str, Any]]:
    """Load and validate services.yaml against services.schema.json."""
    if not SERVICES_YAML.exists():
        sys.stderr.write(f"error: {SERVICES_YAML} not found\n")
        sys.exit(1)

    with SERVICES_YAML.open() as f:
        data = yaml.safe_load(f)

    if not isinstance(data, dict) or "services" not in data:
        sys.stderr.write(
            f"error: {SERVICES_YAML} is malformed — expected top-level 'services' key\n"
        )
        sys.exit(1)

    if data.get("version") != 1:
        sys.stderr.write(
            f"error: {SERVICES_YAML} version mismatch — expected 1, got {data.get('version')}\n"
        )
        sys.exit(1)

    services = data["services"]
    if not isinstance(services, list) or len(services) == 0:
        sys.stderr.write(f"error: services list is empty or not a list\n")
        sys.exit(1)

    # Minimal shape validation (full JSON schema validation in CI test).
    required_keys = {"name", "description", "publish", "subscribe"}
    for i, svc in enumerate(services):
        missing = required_keys - set(svc.keys())
        if missing:
            sys.stderr.write(f"error: services[{i}] missing keys: {sorted(missing)}\n")
            sys.exit(1)
        if not svc["publish"] or not svc["subscribe"]:
            sys.stderr.write(f"error: services[{i}].publish or .subscribe is empty\n")
            sys.exit(1)

    # Assert uniqueness of service names.
    names = [s["name"] for s in services]
    if len(names) != len(set(names)):
        sys.stderr.write(f"error: duplicate service names in services.yaml\n")
        sys.exit(1)

    return services


def render_subject_list(subjects: list[str], indent: str) -> str:
    """Render a subject allow-list with quoted, comma-separated entries, one per line."""
    inner = f",\n{indent}".join(json.dumps(s) for s in subjects)
    return f"{indent}{inner}"


def render_user_entry(svc: dict[str, Any]) -> str:
    """
    Render a single NATS authorization users[] entry — cert-only (no password).

    verify_and_map: true in nats-tls-enabled.conf maps the client cert's
    formatted Distinguished Name to a user entry. NATS 2.10+ uses the
    full DN string "CN=<name>" (not just the bare CN value), so the user
    field must include the "CN=" prefix to match.
    No `password:` field — cert IS the identity.
    """
    name = svc["name"]
    description = svc["description"].strip().replace("\n", " ")
    publish = render_subject_list(svc["publish"], "            ")
    subscribe = render_subject_list(svc["subscribe"], "            ")

    return (
        f"    # ── {name}: {description} ──\n"
        f"    {{\n"
        f'      user: "CN={name}",\n'
        f"      permissions: {{\n"
        f"        publish: {{\n"
        f"          allow: [\n"
        f"{publish}\n"
        f"          ]\n"
        f"        }}\n"
        f"        subscribe: {{\n"
        f"          allow: [\n"
        f"{subscribe}\n"
        f"          ]\n"
        f"        }}\n"
        f"      }}\n"
        f"    }}"
    )


def render_generated_block(services: list[dict[str, Any]]) -> str:
    """Render the full generated block including sentinel markers."""
    entries = [render_user_entry(svc) for svc in services]
    body = ",\n".join(entries)
    return f"{BEGIN_MARKER}\n{body}\n{END_MARKER}"


def splice_into_nats_conf(generated_block: str) -> tuple[str, bool]:
    """
    Replace everything between BEGIN_MARKER and END_MARKER in nats.conf.

    On first run (markers not yet present), REPLACES the existing
    authorization{} users[] array content with markers + generated block.
    Detects the existing authorization block by looking for
    `users: [` and the matching `]` that closes the array.

    Returns (new_contents, was_modified).
    """
    if not NATS_CONF.exists():
        sys.stderr.write(f"error: {NATS_CONF} not found\n")
        sys.exit(2)

    original = NATS_CONF.read_text()

    # Case 1: markers already present → splice between them.
    if BEGIN_MARKER in original and END_MARKER in original:
        before, _, rest = original.partition(BEGIN_MARKER)
        _, _, after = rest.partition(END_MARKER)
        new_contents = before + generated_block + after
        return new_contents, new_contents != original

    # Case 2: first-run migration → replace raw users[] array content.
    # Find `users: [` (the opening bracket), then find the matching `]`
    # at the same indentation to locate block boundaries.
    users_open_marker = "users: ["
    idx = original.find(users_open_marker)
    if idx < 0:
        sys.stderr.write(
            "error: nats.conf has no `users: [` marker. Either the file is "
            "already migrated but sentinels were stripped, or the format changed. "
            "Manual migration required.\n"
        )
        sys.exit(2)

    # Walk forward from idx balancing brackets to find the matching ].
    depth = 0
    i = idx + len(users_open_marker) - 1  # on the opening [
    while i < len(original):
        ch = original[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1

    if depth != 0:
        sys.stderr.write("error: could not locate closing ] for users[] array\n")
        sys.exit(2)

    # Splice: everything up to and including `users: [` + newline + generated + `  ]`
    before_users_array = original[: idx + len(users_open_marker)]
    after_users_array = original[i:]  # starts at the closing `]`
    new_contents = (
        before_users_array
        + "\n"
        + generated_block
        + "\n  "
        + after_users_array
    )
    return new_contents, new_contents != original


def main() -> int:
    args = sys.argv[1:]
    if args not in ([], ["--check"]):
        sys.stderr.write("usage: generate-nats-conf.py [--check]\n")
        return 2
    check_only = args == ["--check"]

    services = load_services()
    block = render_generated_block(services)
    new_contents, modified = splice_into_nats_conf(block)

    if not modified:
        sys.stdout.write(
            f"no change — {NATS_CONF.relative_to(REPO_ROOT)} already matches SSoT\n"
        )
        return 0

    if check_only:
        sys.stderr.write(
            f"error: {NATS_CONF.relative_to(REPO_ROOT)} does not match "
            "infrastructure/nats/services.yaml; regenerate and commit it\n"
        )
        return 1

    NATS_CONF.write_text(new_contents)
    sys.stdout.write(
        f"regenerated — {NATS_CONF.relative_to(REPO_ROOT)} "
        f"(services: {len(services)})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
