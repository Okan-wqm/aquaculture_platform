# Package 15: ci-timescaledb-image

## Metadata
Status: PENDING
Estimated Tokens: 6K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
The CI workflow uses `postgres:16` instead of `timescale/timescaledb:latest-pg16` as its database service image. Tests relying on TimescaleDB-specific features (hypertables, continuous aggregates, compression) either fail silently or are skipped in CI, creating a false green signal.

## Findings

**MEDIUM-017 [infra-expert]: CI uses postgres:16 not timescale/timescaledb**
- File: `.github/workflows/ci-full.yml` (line 78)
- Tests relying on TimescaleDB features fail silently or are skipped in CI
- Production uses TimescaleDB; CI should match to catch TimescaleDB-specific regressions

Closing-Findings: [MEDIUM-017]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/.github/workflows/ci-full.yml`

## Dependencies
None.

## Atomic Commit Plan
```
fix(infra): use timescale/timescaledb image in CI workflow

Replace postgres:16 with timescale/timescaledb:latest-pg16 in the CI
database service definition. This ensures TimescaleDB-specific tests
(hypertables, continuous aggregates, compression policies) run against
the same database engine used in production.

Plan: docs/plans/2026-04-09-full-remediation/packages/15-ci-timescaledb-image.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-017
```

## Test Plan
- Verify CI workflow YAML is valid: `gh workflow view ci-full.yml` or YAML lint
- Trigger CI run on branch to confirm TimescaleDB image pulls and starts correctly
- Confirm previously-skipped TimescaleDB tests now run

## Verification Command
`grep -q "timescale/timescaledb" .github/workflows/ci-full.yml && echo "PASS" || echo "FAIL"`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
