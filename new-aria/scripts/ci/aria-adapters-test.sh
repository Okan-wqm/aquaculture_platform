#!/usr/bin/env bash
# WHY: the adapter test suites (nine core, plus the packs') are ts-node scripts, not a test-runner
# project; one entrypoint keeps `npm run aria:adapters:test`, the Docker image
# and the destination CI lane running the identical list.
# WHAT: runs every adapter's *.test.ts under tools/aria-adapters and under
# packs/*/adapters, and stops at the first failure.
set -euo pipefail
cd "$(dirname "$0")/../.."
for adapter in bundle-budget doc-staleness event-contracts fe-dto-parity kernel-dead-wire security-boundary tenant-scoping test-gap typeorm-entity-schema; do
  npx ts-node --project tools/gates/tsconfig.json "tools/aria-adapters/${adapter}-adapter.test.ts"
done
# Pack adapters live under packs/<id>/adapters and carry the same ts-node
# test shape; a pack whose tests no lane runs is a pack whose promises are
# unverified (legal register L-27).
for pack_test in packs/legal/adapters/legal-document-inventory.test.ts packs/legal/adapters/binary/extract.test.ts packs/legal/adapters/records/statement-gate.test.ts; do
  npx ts-node --project tools/gates/tsconfig.json "${pack_test}"
done
