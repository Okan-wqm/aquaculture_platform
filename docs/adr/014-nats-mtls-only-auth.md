# ADR-014: NATS Authentication Model — mTLS-Only Endpoint Reached

**Status:** Accepted
**Date:** 2026-04-14
**Deciders:** platform team
**Related:** ADR-013 (Messaging Isolation Convergence), CLAUDE.md hierarchy (Make-impossible > Automatic > Detectable > Documented)

## Context

The platform's NATS authentication architecture went through a 4-phase
migration during 2026-04-12 → 2026-04-14:

| Phase | Commit | What landed |
|---|---|---|
| 1 | `4ba2a0c0` (04-12) | Per-service NATS users with subject-level ACLs in `nats.conf` |
| 2 | `adb25b7c` (04-12) | docker-compose graceful fallback `${PER_SVC:-${SHARED:-default}}` + legacy_shared user in `nats.conf` as migration safety net |
| 3 | `a265eeef` (04-13) | mTLS enforced — `verify: true` rejects any client without a CA-signed cert |
| 4 | `11c21fda` (04-14) | Per-service mTLS client certs + `verify_and_map: true` — cert CN maps directly to NATS user identity |

The Phase-2 graceful fallback was correct **during** the migration: any
service that hadn't been re-deployed with per-service credentials yet
could fall back to the shared `$NATS_USER`/`$NATS_PASS` account and keep
operating while operators rolled out per-service config tenant-by-tenant.

After Phase 4 the fallback became **structurally unreachable**:

- Production mounts `nats-tls-enabled.conf` which sets `verify: true` —
  any client without a CA-signed cert is dropped at TLS handshake.
- `verify_and_map: true` makes the cert's CN the NATS user identity
  directly. Username/password fields in CONNECT frames are ignored.
- `infrastructure/docker/scripts/generate-internal-certs.sh` only
  generates per-service certs — there is no cert with CN matching the
  shared `nats_internal` user.

So a client trying to use the shared account would need to:
1. Possess a CA-signed cert AND
2. That cert's CN would have to be `nats_internal` AND
3. Such a cert is never minted by any code path

The fallback path is, by construction, dead.

## Decision

**Remove the legacy shared NATS account from all three layers** (Compose,
NATS config, environment requirements). Document the removal here so
future maintainers understand why no shared NATS user exists anywhere
on the platform.

Specifically removed (commit `fd5a2284`):

1. **`docker-compose.droplet.yml`** — the `x-nats-env` YAML anchor (was
   defined but had ZERO `<<: *nats-env` mergers anywhere in the file —
   verified via grep). Anchor body's `:?` strict env requirements for
   `NATS_USER`/`NATS_PASS` were blocking deploy with a misleading
   "(legacy shared account) required" error for an account that no
   client had ever consumed.

2. **`docker-compose.droplet.yml`** — the `NATS_USER`/`NATS_PASS` env
   vars on the `nats:` container's `environment:` block. They were
   passed to the NATS server only so that `nats.conf`'s shared-user
   entry could `$`-interpolate them.

3. **`infrastructure/docker/nats/nats.conf`** — the `{ user:
   $NATS_USER, password: $NATS_PASS, permissions: ... }` entry in
   the `users:` array, marked in-source as "legacy/shared fallback
   (migration period)".

## Rationale

### Why removal beats "keep it dormant just in case"

Three reasons:

1. **Latent attack surface.** A dormant shared credential is precisely
   the kind of "just in case" pattern that creates exploitable
   regressions. If a future operator disables mTLS for a debug session
   and forgets to re-enable it, the dormant shared user becomes a live
   backdoor with `AQUACULTURE_EVENTS.>` publish/subscribe rights —
   wide-open access to every service's event stream.

2. **CLAUDE.md hierarchy.** Make-impossible > Automatic > Detectable >
   Documented. Removing the shared user makes a shared-credential
   compromise structurally impossible (no shared credential exists).
   Keeping it as dormant code with a comment ("ignore this, it's
   dead") is the Documented tier — the weakest position.

3. **Operational clarity.** Future engineers reading `nats.conf` should
   see exactly the auth model in use today, not the auth models that
   used to be in use plus the current one. Dormant code rots: in 6
   months no one will remember whether the shared user is "still
   needed for X" or "left over from old migration." The ADR record
   here provides the institutional memory; the code stays minimal.

### What if mTLS is disabled in an emergency?

The correct response is to fix mTLS, not to fall back to shared
credentials. mTLS being disabled in production is itself an incident;
adding "shared NATS access" as a side effect of that incident would
multiply the blast radius rather than contain it.

For development environments where mTLS is intentionally off
(`nats-tls.conf` mounted instead of `nats-tls-enabled.conf`), each
developer's per-service `.env` provides per-service NATS credentials
(generated idempotently by the deploy script's
"per-service credentials provisioned" step). The shared user was
never intended for dev work either.

### What about external operator scripts?

Verified via grep that no shell script under `scripts/`, no helm
template under `infrastructure/helm/`, no GitHub Actions workflow
references bare `NATS_USER` / `NATS_PASS`. Per-service variants
(`NATS_AUTH_USER`, `NATS_FARM_USER`, etc.) are the only NATS credential
references anywhere in the repository.

If an external operator script outside this repo references the shared
account, it is broken-by-design under mTLS enforcement — the fix is
to update the operator script to use a per-service account, not to
preserve the shared account on the server side.

## Consequences

### Positive

- One auth model on the platform: per-service mTLS + per-service
  account with subject ACLs. No fallback. No alternates. Easier to
  reason about, easier to audit.
- Shared-credential compromise structurally impossible.
- Deploy errors stop misrepresenting the architecture (no more
  "(legacy shared account) required" messages for an account that
  doesn't exist in the consuming code).
- `nats.conf` contains exactly the user entries that correspond to
  active services; reading the config is unambiguous.

### Negative

- If mTLS is disabled in a debug session AND per-service env vars are
  also missing from a particular environment's `.env`, no NATS
  authentication path works at all — services fail to connect rather
  than degrade to shared auth. This is the intended consequence of
  removing the safety net but is worth flagging for operators.

### Neutral

- Per-service auth migration was already complete in production well
  before this ADR; the change has zero behavioral impact on running
  services.

## References

- `docker-compose.droplet.yml` lines 30-44 (post-fix — see commit
  `fd5a2284`)
- `infrastructure/docker/nats/nats.conf` lines 240-247 (post-fix)
- `infrastructure/docker/nats/nats-tls-enabled.conf` lines 7-29 (mTLS
  enforcement that made the shared-user path unreachable)
- ADR-013 (Messaging Isolation Convergence — same architectural era)
- Commit `adb25b7c` (introduced graceful fallback during migration)
- Commit `11c21fda` (final phase: per-service mTLS + verify_and_map)
- Commit `fd5a2284` (removed shared user across all three layers)
