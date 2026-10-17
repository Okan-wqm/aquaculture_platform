# Lost-work re-land: findings registered on main (2026-10-16)

The lost-work audit of 2026-10-16 compared 58 unpushed local branches with `origin/main`. Its
"Re-land first" list names fixes that exist only on those branches. Each one is re-implemented
test-first on current main under a fresh registry id: an id carried by an old branch may name
another defect on main.

Owner: claude (implementation), okan (review).

## INFRA-CRITICAL-233

Ordinary certificate renewal regenerates the internal CA. Lost-work item 1; the old branch
`fix/login-permanent-recovery` (57ca1a0f3, PR #1452 closed unmerged) carried it as
ORPHAN-CRITICAL-820, which is not in main's registry.

- `scripts/deploy/droplet-up.sh:1009` runs `generate-internal-certs.sh --force` when the redis
  server leaf has under 30 days left.
- `infrastructure/docker/scripts/generate-internal-certs.sh:603-626`: `--force` also mints a new
  `ca-key.pem` and `ca-cert.pem`.
- `docker-compose.droplet.yml:631-633`: the NATS broker bind-mounts its server leaf and CA copy
  as single files, and an application rollout recreates it only when `nats.conf` changed.

Failure scenario: the first application rollout after 2027-04-28 (the live leaves expire
2027-05-28) runs `--force`. Restarted services trust the new CA and present leaves it signed.
The running broker keeps the old CA and the old server leaf, so every restarted service fails
the TLS handshake in both directions. A rollback restores the images, not the old CA.

Planned fix: leaf renewal becomes its own mode that keeps, and requires, the validated CA. CA
replacement gets an explicit name of its own that the deploy never passes.

The old row's second half, PostgreSQL mounts from mixed releases, is ORPHAN-CRITICAL-810 (OPEN)
and is not part of this row.

Landed: `--renew-leaves` re-issues every leaf under the existing, validated CA and refuses to
mint one; `--rotate-ca` replaces it; `--force` and unknown options exit 2. The deploy passes
`--renew-leaves`. `production-cert-identity-store.spec.ts` runs the deploy's own renewal argv.

## INFRA-MEDIUM-234

`validate_certificate_key_pair` and `validate_certificate_authority` end six failure branches
with a bare `return` right after `if ! x=$(...); then`. A bare `return` returns the status of
the last command, the negated test, which is 0. An unparseable certificate or key therefore
logs its error, the generator prints `[skip]`, and the run exits 0. With `garbage` in
`nats/nats-cert.pem` a default run on main does exactly that, so the deploy preflight passes
and NATS fails at container start.

Planned fix: every failure branch returns 1, and the spec refuses the bare-return pattern.

Landed: the six branches return 1. The spec breaks a server leaf, a client key, the CA
certificate and the CA key in turn; each run fails without `[skip]`, and the pattern is refused.

## INFRA-HIGH-235

A renewed server leaf never reaches the running NATS broker in an application rollout.
`ensure_nats_acl_loaded` (`scripts/deploy/droplet-up.sh:508-511`) keeps the broker when
`nats.conf` is unchanged and compares no TLS file. Renewal publishes the new leaf by rename, so
the broker keeps serving the old one. That certificate expires at most 30 days after renewal;
unless a full deploy or a `nats.conf` change recreates the broker first, every NATS client then
fails verification. The PostgreSQL server leaf has the same gap in development rollouts.

Not fixed by the INFRA-CRITICAL-233 change: it needs a deploy-path harness for the broker
recreate decision. Deadline 2026-12-16.
