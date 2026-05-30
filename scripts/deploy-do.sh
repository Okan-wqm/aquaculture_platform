#!/usr/bin/env bash
# Deprecated production deploy entrypoint.
#
# Production deploys are intentionally centralized in GitHub Actions:
#   CI -> GHCR immutable images -> scripts/deploy/droplet-up.sh over SSH.
#
# This legacy script used mutable latest images and bypassed rollback capture,
# db-migrate ordering, capacity preflight, health gates, boot-signal checks,
# and the release ledger. Keep it as a loud guard so old operator notes fail
# before touching production.

set -euo pipefail

cat >&2 <<'EOF'
ERROR: scripts/deploy-do.sh is disabled.

Use GitHub Actions "Deploy to DigitalOcean" instead. The Actions workflow is
the production deploy SSOT and enforces immutable image tags, capacity
preflight, rollback state, health/readiness gates, and release-ledger updates.
EOF

exit 1
