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

Landed: renewal is the generator's decision. The deploy calls it with no option; once any
managed leaf is inside 30 days of expiry, it re-issues every leaf under the existing, validated
CA, and so does `--renew-leaves`. Neither mints a CA. Before anything is issued, every CA copy
must equal `ca/ca-cert.pem` and every leaf must chain to it. A CA is minted only into a store
that holds no identity issued under another, and no leaf is issued under a CA that expires
first. `--rotate-ca` replaces the CA; `--force` and unknown options exit 2; no deploy path
passes an option. `production-cert-identity-store.spec.ts` runs the deploy's own call.

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

A renewed leaf never reaches a consumer that the rollout does not recreate. Renewal re-issues
every server and client leaf in one run and publishes each by rename, and every consumer
bind-mounts its files as single files, so it keeps the inode it opened at start.

- The NATS broker: `ensure_nats_acl_loaded` (`scripts/deploy/droplet-up.sh:508-511`) keeps it
  when `nats.conf` is unchanged and compares no TLS file. It keeps serving the old server leaf.
- Application services: a selective rollout recreates only the services it rolls out
  (`scripts/deploy/droplet-up.sh:1479`). Every other service keeps presenting its old client
  leaf.
- PostgreSQL: a production selective rollout runs `up -d postgres redis minio` (`:1438`), which
  keeps an unchanged container, and a development rollout preserves it. The applications run
  `DATABASE_SSL=false`, so this part has low impact.

Each old leaf expires at most 30 days after renewal. Only the full-stack path removes every
container first (`:1162`); a `nats.conf` change recreates only the broker. Without a full-stack
deploy inside those 30 days, the broker presents an expired leaf to every NATS client, and every
service the rollout did not restart presents an expired leaf to the broker.

Not fixed by the INFRA-CRITICAL-233 change: it needs a deploy-path harness for the recreate
decision. The fix must cover every consumer of a renewed leaf, not the broker alone. Deadline
2026-12-16. The row was widened to this scope before merge, after the change's first
verification round.
