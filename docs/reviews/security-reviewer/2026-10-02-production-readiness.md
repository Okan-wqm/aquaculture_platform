# CI/CD and deploy-pipeline security — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `security-reviewer` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | .github/workflows deploy/backup/capacity lanes, tools/scripts/ci, production SSH path |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The production deploy pipeline still carries the INFRA-CRITICAL cluster; most of the registry
claims are confirmed against main, and the development lane bypasses the production stop-line.
This covers CI/CD and deploy-pipeline security only.

## WAL freshness failure: most likely not a script bug

- A wrong fingerprint format would fail earlier with a different message
  (`run-protected-ssh.sh:34`). If keyscan returned nothing, the script normally dies at `:71`
  instead (inferred from OpenSSH 9.x behaviour, not confirmed on the runner).
- The parse at `:89-95` is standard, so `:113-114` means some host answered with an ED25519 key
  that does not match the secret.
- Likeliest causes, in order:
  - (a) Old secret, new rule. The INFRA-MEDIUM-088 fix (2026-09-05) added `-t ed25519` (`:69`) and
    the algorithm check (`:108`); the first recorded failure is 2026-09-06
    (`docs/superpowers/plans/2026-09-06-aria-security-runtime-closure.md:158`). The
    `production-backup` fingerprint predates the 2026-07-18 ED25519 pin and may be an RSA or ECDSA
    fingerprint that used to match.
  - (b) Drift between scopes. `DROPLET_HOST` is a repository secret and the fingerprint is an
    Environment secret (`.github/provisioned-secrets.json:49-68`), so either can change without
    the other.
  - (c) A real host-key change, or a man-in-the-middle.
- How an operator can tell:
  - From the DigitalOcean console run `ssh-keygen -lf
    /etc/ssh/ssh_host_{ed25519,ecdsa,rsa}_key.pub -E sha256` and note the key files' modification
    times.
  - Run `ssh-keyscan HOST | ssh-keygen -lf - -E sha256` from outside and compare.
  - Compare GitHub's `updated_at` for the repo `DROPLET_HOST` and the Environment fingerprint.
  - If the console and the outside scan agree but differ from the secret, re-pin the secret. If
    the console and the outside scan disagree, treat it as an incident.
- Minor: the script never prints the fingerprints it saw (they are public) and throws away
  keyscan's stderr (`:70`).

## Blockers

- **B1. The stop-line is bypassed by the development lane.** `ci-affected.yml:1279-1298` runs
  `deploy-development.yml` on every push to main. It has no Environment and no
  `PRODUCTION_DEPLOY_ENABLED` check. It uses the same repo-scoped `DROPLET_*` secrets,
  `droplet-up.sh` and `.env` as production, and sends a token with contents and packages write
  access to the host (`:113-115`, `:186`, `:196`) over appleboy with no host-key check (`:86`,
  `:179`). Since the fingerprint mismatch is unexplained, a man-in-the-middle cannot be ruled out.
- **B2 (INFRA-CRITICAL-078). No host-key pinning on production SSH.**
  - No fingerprint check: `deploy-digitalocean.yml:1187`, `:1272`;
    `deploy-capacity-maintenance.yml:65`; `e2e-tests.yml:47`, `:107`, `:155`.
  - `production-post-deploy-verify.yml:105` uses `accept-new` with an empty known_hosts, so it
    trusts any key on first use.
  - The droplet's own Git checkout acts as the source of truth (`:1215-1219`, `:1335-1339`).
- **B3 (INFRA-CRITICAL-097). Production E2E.** It can be dispatched from any branch and is also
  triggered when a locked, no-op deploy concludes "success". It sends `JWT_SECRET` and
  `DB_PASSWORD` to the live host (`:53-54`, `:109-110`) and falls back to `npm install` there
  (`:67`, `:120`).

## Major

- **Two ARIA workflows leak an unmasked GitHub App token.** In `finding-state-sweep.yml:176` and
  `finding-closure-reconcile.yml:271` the token goes into a step output without `::add-mask::`, so
  it shows in plain text in the next step's env header.

## Minor

- `performance-benchmark.yml`, `fuzz-st-parser-nightly.yml` and `dependency-review.yml` have no
  `permissions:` block.
- The same appleboy SHA is labelled v1.2.5 in one place and v1.0.3 in another.
- The dev compose files have default passwords (dev only). The empty password defaults in
  `docker-compose.droplet.yml` fail closed at runtime (`platform-bootstrap.service.ts:213-238`).

## Registry status

The registry's `deploy-digitalocean.yml` line numbers point at the PR #1022 branch. Main still has
the older, unhardened code (INFRA-HIGH-141).

| ID | Status | Evidence |
| --- | ------ | -------- |
| INFRA-CRITICAL-078 | CONFIRMED | Blocker B2 |
| INFRA-CRITICAL-080 | CONFIRMED | `deploy-digitalocean.yml:240-241` and `:439` interpolate dispatch inputs into shell; no main or current-SHA guard |
| INFRA-CRITICAL-081 | CONFIRMED | `deploy-digitalocean.yml:1261-1263`, `:1287`, `:1298` |
| INFRA-CRITICAL-083 | CONFIRMED, worse than described | No ancestry check at all; per-branch concurrency (`:117-119`); tag force-pushed (`:1346-1347`); post-deploy-verify has no caller |
| INFRA-CRITICAL-085 | CONFIRMED | Inputs at `deploy-capacity-maintenance.yml:45-49`, `:74`, `:87-98` feed `droplet-capacity.sh:1178`, `:1204` |
| INFRA-CRITICAL-090 | CONFIRMED | `backup-production.yml:450-451` and `pitr-restore-production.yml:546-547` check `GITHUB\_SHA` against a checkout of `GITHUB\_SHA` (always true) |
| INFRA-CRITICAL-093 | STALE / not live | Fixed code is at `production-host-control-plane.sh:2287-2324`, but nothing calls it |
| INFRA-CRITICAL-095 | CONFIRMED in code | Generic secret names everywhere; `production-deploy-secrets.json` does not exist on main |
| INFRA-CRITICAL-096 | Code CONFIRMED; live settings UNVERIFIED | The tag update is a force-push, not the compare-and-swap the registry describes |
| INFRA-CRITICAL-097 | CONFIRMED | Blocker B3 |
| INFRA-CRITICAL-098 | CONFIRMED but latent | `deploy-staging.yml:163`, `:576`, `:718-719`; staging is not provisioned, so the production staging gate skips itself (`:213-218`) |
| INFRA-CRITICAL-100 | CONFIRMED in code | `droplet-bootstrap-env.sh:50-64` sets mode 0600 only when it creates the file and never checks an existing one |

## Not verified

- Live GitHub secrets, Environment protection, rulesets and the `PRODUCTION_DEPLOY_ENABLED` value;
  whether an Environment-level `DROPLET_HOST` overrides the repo one (if not, dev and prod are the
  same host); the live `.env` mode; run logs; the runner's actual ssh-keyscan exit behaviour.

## Registry entries

This review appended 4 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| INFRA-HIGH-202 | HIGH | Database WAL Archive Freshness fails on every run with "protected SSH fingerprint did not match exactly one advertised ED25519 host key", and nobody has established whether the cause is a pinned fingerprint that predates the ED25519-only rule, drift between the repo DROPLET\_HOST and the Environment fingerprint, or a real host-key change |
| INFRA-HIGH-203 | HIGH | deploy-development.yml runs on every push to main with no Environment and no PRODUCTION\_DEPLOY\_ENABLED check, using the same repo-scoped DROPLET\_\* secrets, droplet-up.sh and .env as production, sending a contents/packages-write token to the host over an unpinned appleboy SSH action and running db-migrate against the live database |
| SEC-HIGH-186 | HIGH | Two ARIA workflows write a GitHub App token to a step output without ::add-mask::, so the token appears in plain text in the next step's env header |
| SEC-LOW-187 | LOW | performance-benchmark.yml, fuzz-st-parser-nightly.yml and dependency-review.yml have no permissions: block, and the same appleboy SHA is labelled v1.2.5 in one place and v1.0.3 in another |
