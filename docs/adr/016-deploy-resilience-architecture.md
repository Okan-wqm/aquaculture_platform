# ADR-016: Deploy Resilience Architecture

**Status:** Accepted (Phase A landed; Phase D-Topology landed; Phases B-F roadmap)
**Date:** 2026-04-14 (Phase D-Topology added 2026-05-10)
**Deciders:** platform team
**Related:** ADR-011, ADR-013, ADR-014, ADR-015 (the architectural series this ADR closes the operational loop on)

## Context

The 2026-04-14 deploy cascade exposed FIVE distinct architectural
weaknesses in the DigitalOcean deploy pipeline. Each had been
independently introduced over the previous weeks, and each became
visible only when the prior one was fixed. The deploy script's
"all-or-nothing-then-rollback" pattern made root cause attribution
expensive — every failed deploy cost 5 minutes of timeout + log dive.

**Failure cascade (in the order they surfaced):**

1. **Strict env interpolation gate** — `${VAR:?...}` for STRIPE_*,
   NATS_USER, NATS_PASS turned missing values into total deploy halt
   before any container was even pulled. Operator's first symptom:
   "deploy stopped before doing anything" with cryptic interpolation
   errors. Closed in ADR-014 (legacy shared NATS user removal) +
   commit `fd5a2284` (Stripe optional, NATS_USER dead code purge).

2. **NATS password contains base64 special chars** — `openssl rand
   -base64 32` produces values containing `+`, `/`, `=`. nats.conf's
   `password: $NATS_BILLING_PASS` substitution treats unquoted values
   as bare-token grammar; special chars cause parse error → server
   crash-loops. Closed in commit `f600d530` (quote all password
   substitutions in nats.conf).

3. **NATS user names provisioned as random 32-char strings** — the
   deploy workflow used `generate_credential` for both `*_USER` and
   `*_PASS`, treating identifiers as if they were secrets. Cert CN
   (`billing_service`) didn't match the random NATS user name
   (`aXbC7Kd...`) → `verify_and_map` denied every connection. Closed
   in commit `d77eddf9` (`set_canonical` heals .env values), then
   structurally eliminated in ADR-015 (services.yaml SSoT — cert CN
   IS identity, no separate username).

4. **Per-service NATS client certs missing on droplet** — generate-
   internal-certs.sh added per-service certs in commit `11c21fda`,
   but the deploy gate only regenerated certs when redis cert was
   expiring within 30 days. Droplets with valid redis certs **never
   ran the script at all** after the per-service expansion landed.
   Result: cert files missing → mTLS handshake failed → every backend
   threw "Authorization Violation" at boot. Closed in this ADR's
   Phase A1.

5. **Pre-existing `ai-privacy.service.ts` four-layer naming drift,
   gateway-api orphan RlsModule registration, hydroponics
   JWT_SECRET legacy reference** — all dormant in the codebase, all
   surfaced when the prior cascade was unblocked enough to let
   service bootstrap reach DI resolution / first DB query / first
   message handler. Closed in commits `545fb292` (ai-privacy →
   repository pattern) + this commit (gateway + hydroponics).

The pattern across all five: **PRE-EXISTING bugs masked by upstream
failures**. Each was introduced in a separate prior PR, each shipped
"green CI" because no test exercised the failure mode in question,
and each manifested only at production deploy time when the full
container mesh tried to come alive together.

## The architectural diagnosis

Every failure shares a common shape: **a config / contract / cert /
code change is committed without an enforcement mechanism that
guarantees its companion changes also land**. CI builds artifacts
but does not verify that those artifacts can actually start, mesh,
and authenticate against the real production-shape configuration.

This ADR codifies a six-phase resilience program. Phase A lands
immediately (this commit); Phases B–F are roadmap.

## Decision: Six-phase deploy resilience program

### Phase A — Pre-flight validation (LANDED 2026-04-14)

Run all VERIFICATION steps before destructive container operations.
A failed verification → abort deploy WITHOUT touching live state.
Currently the script destroys old containers, then rebuilds — if
rebuild fails, you have outage. Pre-flight reverses the order.

**Concrete:**

A1. **Always-run cert generation** (this commit, deploy workflow).
    Drop the `if cert valid > 30 days, skip` gate. Always invoke
    `generate-internal-certs.sh` so its per-file skip-if-exists
    handles the no-op (~100ms total). New per-service certs added
    in lockstep with services.yaml are never missed.

A2. **`docker compose config --quiet` before pull/up.** Catches
    interpolation errors and YAML schema violations BEFORE pulling
    images. (Already implicit in compose CLI; make it explicit
    pre-step that fails fast.)

A3. **NATS SSoT drift assertion** (already wired in commit
    `13aabdc6` to `ci-affected.yml`). Mirror in deploy workflow as
    a hard pre-step: regenerate nats.conf and `git diff --quiet`
    on the file. Drift between commit and runtime → deploy fails.

A4. **Required-secret presence check** (without generating).
    Deploy script asserts the .env file contains every variable
    listed in a manifest. Missing any → abort with explicit list,
    not "interpolation error on line 906".

### Phase B — Idempotent infrastructure (LANDED in earlier work)

- B1. Cert generation: always-run + per-file idempotency (Phase A1)
- B2. Migration runner: `createMigrationRunnerService` factory with
  per-migration tx + search_path pinning (ADR-011/012)
- B3. NATS SSoT: services.yaml → nats.conf generator + CI invariant (ADR-015)
- B4. Per-service cert manifest derived from services.yaml
  (BACKLOG-NATS-002 — cert script reads SSoT)

### Phase C — Per-service health independence (ROADMAP)

Currently health check is `gateway-api` only. If gateway is OK but
billing crashes, deploy reports success. This means a service can
silently rot until a user request triggers it.

**Plan:**

- C1. Deploy script polls `/health/live` on EVERY service container,
  reports per-service status.
- C2. Critical-path services (gateway, auth, postgres, nats, redis)
  gate the deploy. Non-critical (notification, billing) log warnings
  but don't block.
- C3. `infrastructure/deploy/manifest.yaml` declares service criticality.

### Phase D — Staging environment (ROADMAP — biggest single win)

No staging means every deploy is gambling. Even minimum staging:

- D1. Second droplet mirrors prod compose + secret subset.
- D2. `deploy-digitalocean.yml` deploys to staging first, runs e2e
  smoke tests, then prod.
- D3. OR canary on prod (10% traffic to new image, monitor 10min,
  promote or roll back).

This is THE single-biggest deploy improvement available. Without
it, every cert regen / migration / config change is high-stakes.

#### D-Topology — Topology-aware staging gate (LANDED 2026-05-10)

Phase D's deploy-staging.yml + prod-side staging-gate landed on the
implicit assumption that a staging droplet is ALWAYS provisioned.
That assumption breaks at repo init and during single-droplet
operator topologies (one droplet running prod only): the staging
deploy hard-fails with `error: missing server host` because the
SSH action receives an empty `STAGING_DROPLET_HOST`, no
`deployed/staging-<sha>` tag is ever emitted, and prod's gate
hangs for 55 minutes then fails — permanently blocking prod
deploys until the operator either provisions staging or manually
runs every prod deploy with `bypass_staging_gate=true`.

The architectural invariant — "every prod deploy was green on
staging" — only applies WHEN staging exists. Phase D-Topology
codifies this:

**Two architecturally-valid topologies, both supported as
first-class:**

- **Topology A (multi-droplet):** `STAGING_DROPLET_HOST` secret
  set in the `staging` GitHub Environment + `STAGING_ENABLED=true`
  repo variable. `deploy-staging.yml` runs the full staging deploy
  on every push to main; prod gate enforces the
  `deployed/staging-<sha>` tag.
- **Topology B (single-droplet):** `STAGING_DROPLET_HOST` empty
  OR `STAGING_ENABLED` not 'true'. `deploy-staging.yml` skips all
  jobs with a workflow notice; prod gate auto-bypasses on the same
  signal. Prod deploys directly without operator intervention.

**Discriminator: secret presence (Tier-1 Make-Impossible).**
GitHub Actions does not allow secret expressions in job-level
`if:` conditions (security boundary preventing secret leakage via
conditional evaluation). Detection therefore lives in a step that
reads `secrets.STAGING_DROPLET_HOST` into an env var, then exposes
the result via `steps.<id>.outputs.configured` for downstream
job-level `if:` consumption.

The structural-truth signal (secret presence) is paired with the
operator-intent signal (`STAGING_ENABLED` repo variable). The
gate auto-bypasses on EITHER signal of an unconfigured staging:

- If the operator sets `STAGING_ENABLED=true` but forgets the
  secrets, secret-presence catches it (gate cannot wait for a
  deploy that physically cannot run).
- If the operator adds the secrets but forgets the variable,
  the variable check still requires explicit opt-in (prevents
  accidental gating mid-rollout).

**Operator migration path (Topology B → A) requires no workflow
file change:** provision the staging droplet (Terraform module),
add the three secrets to the `staging` GitHub Environment, set
the `STAGING_ENABLED=true` repo variable. Next push to main runs
the full staging deploy and prod begins gating on it.

**The emergency `bypass_staging_gate=true` workflow_dispatch
input is preserved.** Topology-aware auto-bypass handles the
"staging not provisioned" case; the manual bypass handles the
"staging is provisioned but currently broken" case (CVE hotfix,
staging droplet offline, etc.).

References:
- `.github/workflows/deploy-staging.yml` — `staging-configured` job
- `.github/workflows/deploy-digitalocean.yml` — `staging-gate.enablement` step
- `docs/runbooks/staging-environment.md` — operator runbook

### Phase E — Migration container isolation (ROADMAP)

Migration runners currently fire on `OnApplicationBootstrap` of
each service. With 14 services restarting in parallel, race
conditions on shared schemas (RLS install, table moves) become
real. A failed migration crashes the service it's in; other
services may have already moved past their own migrations.

**Plan:**

- E1. Dedicated `aqua-db-migrate` container runs BEFORE service
  containers. Single source of truth for "schema is at version N".
- E2. Service containers verify schema version on boot, refuse to
  start if behind. Don't run migrations themselves.
- E3. Schema version stored in shared migrations table; migration
  container computes and applies the diff.

### Phase F — Observability assertion loop (ROADMAP)

Today: deploy script dumps "last 80 lines" of unhealthy containers
on failure. Reactive, ad-hoc, no signal-to-noise filter.

**Plan:**

- F1. Deploy script asserts SPECIFIC SIGNALS in service logs:
    - `NATS auth mode: mtls-cert` (per service, confirms cert path works)
    - `Migration runner: applied N migrations` (confirms DB synced)
    - `Schema drift validator: 0 violations` (confirms drift validator running)
  Missing signal → deploy fails with explicit message.
- F2. Per-service health endpoints expose: schema_version, NATS
  auth_mode, last_redis_ping. Health check verifies those, not
  just "process is running".
- F3. Structured deploy log → searchable. Today's bash + echo log
  is unsearchable; a JSON event stream would let alerts fire on
  specific failure shapes.

## Rationale

### Why pre-flight before destructive (Phase A)

Current order: stop containers → pull images → up containers → check
health → if unhealthy, rollback. **Production goes through "stopped"
state before we know if the new code will boot.**

Reversed order: validate config → validate cert manifest → verify
SSoT → THEN stop+pull+up. Bad commit → caught at validate → no
production state change.

This is the Tier-1 Make-Impossible tier of CLAUDE.md hierarchy:
the validation gate makes "deploy proceeds with broken config"
structurally impossible.

### Why staging is THE single-biggest improvement

Every failure mode in the 2026-04-14 cascade was in code that
PASSED CI and was only caught at production boot. CI builds
artifacts; staging would actually run them. The cost of one
duplicate droplet is tiny vs. the operational cost of every
production deploy being a debugging session.

### Why migration container isolation (Phase E)

Today every service runs migrations independently on boot. If two
services share a migration namespace (RLS install on `messaging.*`
runs both from messaging-service AND from a migration runner that
both services share), race conditions become possible.

Dedicated migration container:
- Single SQL session against the DB
- Atomic version bookkeeping
- Service rollback ≠ schema rollback
- Migration failures don't crash a random service mid-boot

## Consequences

### Positive

- Pre-flight (Phase A) immediately reduces "deploy gambles destroyed
  state on a bad commit" probability to near zero.
- Staging (Phase D) catches 80%+ of deploy failures before they
  reach production.
- Migration isolation (Phase E) decouples schema state from service
  state.
- Per-service health (Phase C) catches silent rot.
- Observability assertions (Phase F) shift from reactive to
  declarative — operators describe what GOOD looks like, deploy
  enforces it.

### Negative

- Phase D requires a second DigitalOcean droplet (operational cost).
- Phase E adds container-orchestration complexity (init container
  pattern, schema-version contract).
- Phase F requires services to emit specific log signals; back-fit
  across 14 services is a multi-week project.

### Neutral

- Phase A is fully backwards-compatible (just adds verification
  steps).
- Phase B already landed in prior architectural work.

## Implementation tracker

- [x] Phase A1 — always-run cert generation (this commit)
- [ ] Phase A2 — explicit `docker compose config` pre-step (FOLLOW-UP)
- [ ] Phase A3 — nats.conf drift assertion in deploy workflow (FOLLOW-UP)
- [ ] Phase A4 — required-secret presence check (FOLLOW-UP)
- [x] Phase B1-B3 — landed (ADR-011/013/014/015 work)
- [ ] Phase B4 — cert script reads services.yaml (BACKLOG-NATS-002)
- [ ] Phase C — per-service health (ROADMAP)
- [ ] Phase D — staging environment (ROADMAP — biggest single win)
- [x] Phase D-Topology — topology-aware staging gate (2026-05-10)
- [ ] Phase E — migration container isolation (ROADMAP)
- [ ] Phase F — observability assertion (ROADMAP)

## References

- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` — current deploy
- ADR-014 (NATS mTLS-only auth — legacy shared user removed)
- ADR-015 (NATS Cert-Is-Identity SSoT)
- `docs/runbooks/messaging-rls-rollout.md` — example of staging-first procedure
- `docs/reviews/messaging-expert/2026-04-14-ai-privacy-naming-drift.md`
