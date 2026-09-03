#!/usr/bin/env bash
# WHY: the nine adapter test suites are ts-node scripts, not a test-runner
# project; one entrypoint keeps `npm run aria:adapters:test`, the Docker image
# and the destination CI lane running the identical list.
# WHAT: runs every adapter's *.test.ts under tools/aria-adapters and stops at
# the first failure.
set -euo pipefail
cd "$(dirname "$0")/../.."
for adapter in bundle-budget doc-staleness event-contracts fe-dto-parity kernel-dead-wire security-boundary tenant-scoping test-gap typeorm-entity-schema; do
  npx ts-node --project tools/gates/tsconfig.json "tools/aria-adapters/${adapter}-adapter.test.ts"
done
