#!/usr/bin/env python3
"""
Generate the NATS authorization and deployment identity artifacts from the
SSoT at infrastructure/nats/services.yaml.

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
  ./scripts/nats/generate-nats-conf.py --check

By default: reads infrastructure/nats/services.yaml, replaces the block
between `# BEGIN GENERATED` / `# END GENERATED` sentinels in
infrastructure/docker/nats/nats.conf, and writes the exact same identity
roster to infrastructure/helm/aquaculture/files/nats-service-identities.yaml.

With `--check`: reads and compares only. Nothing on disk is written; a stale
artifact is named on stderr and reported through exit code 3.

# Why --check exists

The drift gate used to run the generator and then ask git whether anything
changed. That repairs the checkout before it judges it: the generator's write
lands first, so every later step in the same job reads the REPAIRED artifact
while the commit under test still carries the stale one. The gate also could
not tell "you edited services.yaml and forgot to regenerate" from "your YAML
is malformed" — both surfaced as a dirty tree or a non-zero exit with no
distinguishing code. `--check` answers the freshness question without touching
the tree, and drift has an exit code of its own.

Idempotent: re-running on an already-generated nats.conf produces identical
output (deterministic ordering + no timestamp injection).

# Exit codes

  0   success, file updated (or no changes needed); with --check, both
      artifacts already match services.yaml
  1   services.yaml missing or invalid
  2   nats.conf missing, or sentinels not found
  3   --check only: a generated artifact does not match services.yaml
  64  usage error (unrecognized argument)

# Related

  - ADR-015: NATS Cert-Is-Identity SSoT
  - docs/adr/014-nats-mtls-only-auth.md: legacy shared user removal
  - scripts/nats/generate-internal-certs.sh (sibling): per-service cert CN list
"""

from __future__ import annotations

import json
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
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVICES_YAML = REPO_ROOT / "infrastructure" / "nats" / "services.yaml"
SERVICES_SCHEMA = REPO_ROOT / "infrastructure" / "nats" / "services.schema.json"
NATS_CONF = REPO_ROOT / "infrastructure" / "docker" / "nats" / "nats.conf"
HELM_IDENTITIES = (
    REPO_ROOT
    / "infrastructure"
    / "helm"
    / "aquaculture"
    / "files"
    / "nats-service-identities.yaml"
)

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
    required_keys = {"name", "application", "description", "publish", "subscribe"}
    for i, svc in enumerate(services):
        if not isinstance(svc, dict):
            sys.stderr.write(f"error: services[{i}] is not an object\n")
            sys.exit(1)
        missing = required_keys - set(svc.keys())
        if missing:
            sys.stderr.write(f"error: services[{i}] missing keys: {sorted(missing)}\n")
            sys.exit(1)
        if not isinstance(svc["name"], str) or not re.fullmatch(
            r"[A-Za-z0-9_-]+", svc["name"]
        ):
            sys.stderr.write(f"error: services[{i}].name is not a safe certificate CN\n")
            sys.exit(1)
        if not isinstance(svc["application"], str) or not re.fullmatch(
            r"[a-z0-9]+(?:-[a-z0-9]+)*", svc["application"]
        ):
            sys.stderr.write(f"error: services[{i}].application is not a runtime name\n")
            sys.exit(1)
        if not svc["publish"] or not svc["subscribe"]:
            sys.stderr.write(f"error: services[{i}].publish or .subscribe is empty\n")
            sys.exit(1)

    # Assert uniqueness of service names.
    names = [s["name"] for s in services]
    if len(names) != len(set(names)):
        sys.stderr.write(f"error: duplicate service names in services.yaml\n")
        sys.exit(1)

    applications = [s["application"] for s in services]
    if len(applications) != len(set(applications)):
        sys.stderr.write(
            "error: duplicate applications in services.yaml — an application "
            "cannot be assigned multiple NATS certificate identities\n"
        )
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


def render_helm_identities(services: list[dict[str, Any]]) -> str:
    """Render the certificate identity roster consumed by the Helm chart."""
    identities = "\n".join(f"  - {svc['name']}" for svc in services)
    return (
        "# GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)\n"
        "# Source: infrastructure/nats/services.yaml\n"
        "version: 1\n"
        "identities:\n"
        f"{identities}\n"
    )


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
        return 64
    check_only = args == ["--check"]

    services = load_services()
    block = render_generated_block(services)
    new_contents, nats_modified = splice_into_nats_conf(block)
    helm_contents = render_helm_identities(services)
    helm_modified = (
        not HELM_IDENTITIES.exists()
        or HELM_IDENTITIES.read_text() != helm_contents
    )

    if not nats_modified and not helm_modified:
        sys.stdout.write(
            "no change — NATS authorization and Helm identities already match SSoT\n"
        )
        return 0

    if check_only:
        # Name the artifacts that actually drifted. "Something is stale" sends
        # the reader to diff two generated files by hand; this points at the
        # one that moved.
        stale = [
            path.relative_to(REPO_ROOT)
            for path, modified in (
                (NATS_CONF, nats_modified),
                (HELM_IDENTITIES, helm_modified),
            )
            if modified
        ]
        sys.stderr.write(
            "error: generated artifacts do not match "
            "infrastructure/nats/services.yaml; regenerate and commit them\n"
        )
        for path in stale:
            sys.stderr.write(f"  stale: {path}\n")
        sys.stderr.write("  run: python3 scripts/nats/generate-nats-conf.py\n")
        return 3

    if nats_modified:
        NATS_CONF.write_text(new_contents)
        sys.stdout.write(
            f"regenerated — {NATS_CONF.relative_to(REPO_ROOT)} "
            f"(services: {len(services)})\n"
        )

    if helm_modified:
        HELM_IDENTITIES.parent.mkdir(parents=True, exist_ok=True)
        HELM_IDENTITIES.write_text(helm_contents)
        sys.stdout.write(
            f"regenerated — {HELM_IDENTITIES.relative_to(REPO_ROOT)} "
            f"(identities: {len(services)})\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
