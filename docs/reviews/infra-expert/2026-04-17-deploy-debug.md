# Deploy Debug — 2026-04-17

## DEPLOY-HIGH-001: DATABASE_SSL crash-loop

**Severity:** HIGH
**State:** OPEN

All 13 backend services crash-looping with ssl-config.ts production guard rejecting
`DATABASE_SSL=true + DATABASE_SSL_REJECT_UNAUTHORIZED=false` without a CA cert.
Postgres is on the same Docker bridge — SSL is unnecessary.

**Fix:** `DATABASE_SSL="false"` in docker-compose.droplet.yml for all 13 services.

## DEPLOY-HIGH-002: NATS verify_and_map DN format mismatch

**Severity:** HIGH
**State:** OPEN

NATS 2.10 `verify_and_map` uses `DistinguishedNameMatch` which compares the full
formatted DN string (`"CN=farm_service"`) against `nats.conf` user entries. The cert
generation script was producing certs with `Subject: CN=farm_service, O=Aquaculture Platform`,
and the NATS codegen was emitting `user: farm_service` (bare name). Neither matched.

**Fix:** Two-part:
1. Cert generation: CN-only Subject (`-subj "/CN=${svc_user}"`)
2. NATS codegen: `user: "CN=${name}"` format

## PROC-MEDIUM-005: CI-Affected path filter missing tools/eslint-rules, tools/gates, tools/scripts

**Severity:** MEDIUM
**State:** RESOLVED (commit 50df8342)

The `detect-changes` paths-filter in `.github/workflows/ci-affected.yml` did not
include `tools/eslint-rules/**`, `tools/gates/**`, or `tools/scripts/**`. When
commit `5f3280c4` fixed a tsc build error inside `tools/eslint-rules/`, CI-Affected
resolved with `has_changes=false` and skipped the entire build+deploy chain — the
fix shipped unverified. Recursive chicken-egg: a CI bug's own fix cannot test itself
unless the path it touches is already in the trigger filter.

**Fix:** `50df8342` — extend the `deploy-config` filter to every path that
participates in the CI install chain: `tools/eslint-rules/**`, `tools/gates/**`,
`tools/scripts/**`, plus the root TS/ESLint configs that transitively feed the
Nx graph probe and the ESLint plugin loader.

**Follow-ups (separate commits):** `a8320411` added `tools/eslint-rules` to npm
workspaces (the actual build-order root cause); `efca6627` committed the
pre-built `tools/eslint-rules/dist/` to eliminate the runtime-build race.
