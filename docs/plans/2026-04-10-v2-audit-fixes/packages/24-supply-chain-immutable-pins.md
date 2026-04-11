# Package 24: supply-chain-immutable-pins

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [security-reviewer/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Production Dockerfiles use mutable upstream tags, the Mosquitto image downloads a GitHub release artifact without checksum verification, and repo-owned GitHub Actions consume mutable tags instead of immutable SHAs. This leaves the build and deploy pipeline exposed to tag swaps, upstream compromise, and dependency substitution.

## Findings
`HIGH-003` (security-reviewer): Build/runtime supply-chain entry points still rely on mutable tags and unverified downloads. Files: `infrastructure/docker/Dockerfile.backend:16,73`, `infrastructure/docker/Dockerfile.frontend:11,48`, `infrastructure/docker/Dockerfile.shell:9`, `infrastructure/mosquitto/Dockerfile:16,31`, `.github/actions/setup-node-env/action.yml:48`, `.github/actions/docker-build-push/action.yml:90`, `.github/workflows/e2e-tests.yml:104`.

## Affected Files
- /var/aqua-saas/infrastructure/docker/Dockerfile.backend
- /var/aqua-saas/infrastructure/docker/Dockerfile.frontend
- /var/aqua-saas/infrastructure/docker/Dockerfile.shell
- /var/aqua-saas/infrastructure/mosquitto/Dockerfile
- /var/aqua-saas/.github/actions/setup-node-env/action.yml
- /var/aqua-saas/.github/actions/docker-build-push/action.yml
- /var/aqua-saas/.github/workflows/e2e-tests.yml

## Dependencies
None. Package 25 (infra-immutable-deploy-tags) depends on this package.

## Atomic Commit Plan
```
security(infra): pin base images by digest, actions by SHA, verify downloads

Production Dockerfiles used mutable upstream tags, GitHub Actions
consumed mutable tag refs, and the Mosquitto build downloaded binaries
without checksum verification. This pins all base images by digest
(@sha256:...), all third-party GitHub Actions by full commit SHA, and
adds checksum verification for every external binary download during
image builds.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/24-supply-chain-immutable-pins.md
Closes: docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Verify all FROM directives in Dockerfiles use @sha256 digest, not :tag.
- Verify all uses: directives in GitHub Actions reference full 40-char SHA.
- Verify Mosquitto Dockerfile includes checksum verification for downloads.
- CI test: build pipeline succeeds with pinned references.

## Verification Command
`grep -rn 'FROM ' /var/aqua-saas/infrastructure/docker/Dockerfile.* | grep -v '@sha256' | grep -c '' | grep '^0$'`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

