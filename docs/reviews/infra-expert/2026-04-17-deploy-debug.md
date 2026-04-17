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
