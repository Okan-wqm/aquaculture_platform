# Package 05: infra-nats-per-service-accounts

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [infra-expert/CRITICAL-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The production NATS config uses a single authorization block with one user/password pair, shared across every backend service via the `x-nats-env` anchor. The broker cannot distinguish service identity or enforce per-service publish/subscribe boundaries, meaning one compromised service can impersonate any other on the message bus.

## Findings
`CRITICAL-002` (infra-expert): NATS still uses one shared broker identity for all services. Files: `docker-compose.droplet.yml:30-35,200-208`, `infrastructure/docker/nats/nats.conf:41-45`.

## Affected Files
- /var/aqua-saas/docker-compose.droplet.yml
- /var/aqua-saas/infrastructure/docker/nats/nats.conf

## Dependencies
None.

## Atomic Commit Plan
```
security(infra): implement per-service NATS accounts with subject ACLs

All backend services shared a single NATS user/password pair, allowing
any compromised service to impersonate others on the message bus and
publish to arbitrary subjects. This creates per-service NATS accounts
with explicit subject publish/subscribe ACLs, ensuring each service can
only access the subjects it owns.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/05-infra-nats-per-service-accounts.md
Closes: docs/reviews/infra-expert/2026-04-10-full-repo-audit.md#CRITICAL-002
```

## Test Plan
- Verify `nats.conf` defines per-service accounts with subject ACLs.
- Verify each service in `docker-compose.droplet.yml` has its own NATS credentials.
- Negative test: auth-service credentials cannot publish to farm-service subjects.
- Integration test: message delivery works across services with new credentials.

## Verification Command
`grep -c 'x-nats-env' /var/aqua-saas/docker-compose.droplet.yml | grep '^0$' && grep 'accounts' /var/aqua-saas/infrastructure/docker/nats/nats.conf`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

