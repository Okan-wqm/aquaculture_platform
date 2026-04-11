# Package 04: infra-postgres-per-service-roles

## Metadata
Status: PENDING
Estimated Tokens: 16K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [infra-expert/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The droplet deployment wires every backend service to `${POSTGRES_USER:-aquaculture}` instead of the per-service roles already created by the init script. This means any compromised container gets superuser-equivalent access across all schemas, effectively bypassing the schema isolation the init script establishes.

## Findings
`CRITICAL-001` (infra-expert): Production PostgreSQL still uses the shared superuser in the droplet deployment. The init script creates per-service roles (`auth_service`, `farm_service`, etc.) but production services never consume those credentials. Files: `infrastructure/scripts/setup-droplet.sh:114-115`, `docker-compose.droplet.yml` (lines 297, 402, 453, 501, 562, 612, 655, 698, 741, 784, 832, 870, 913), `infrastructure/docker/init-scripts/00-init-schemas.sh:170-215`.

## Affected Files
- /var/aqua-saas/docker-compose.droplet.yml
- /var/aqua-saas/infrastructure/scripts/setup-droplet.sh
- /var/aqua-saas/infrastructure/docker/init-scripts/00-init-schemas.sh

## Dependencies
None.

## Atomic Commit Plan
```
security(infra): switch production PostgreSQL to per-service database roles

All backend services connected to PostgreSQL using a shared superuser
credential, meaning any compromised container had superuser-equivalent
access across all schemas. This switches each service in the droplet
compose to its dedicated service role (auth_service, farm_service, etc.)
already created by the init script, and removes the shared application
user from the production path.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/04-infra-postgres-per-service-roles.md
Closes: docs/reviews/infra-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Verify each service in `docker-compose.droplet.yml` uses its own `POSTGRES_USER` and `POSTGRES_PASSWORD`.
- Verify the shared `aquaculture` user is not referenced by any service container.
- Integration test: deploy with new compose and confirm each service can access only its own schema.
- Negative test: farm-service credentials cannot access auth schema tables.

## Verification Command
`grep -c 'POSTGRES_USER:-aquaculture' /var/aqua-saas/docker-compose.droplet.yml | grep '^0$'`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

