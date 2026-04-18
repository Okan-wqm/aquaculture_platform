# Package 25: infra-immutable-deploy-tags

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 16K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 24-supply-chain-immutable-pins
Sprint: 1

## Closing-Findings
Closing-Findings: [infra-expert/HIGH-001, infra-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Two related infrastructure issues: (1) production compose files deploy from mutable `:latest` tags instead of the immutable `:{TAG}` refs the build workflow already publishes, making rollouts non-reproducible; (2) the Trivy image scan job only covers `gateway-api:latest`, leaving every other production image unscanned for vulnerabilities.

## Findings
`HIGH-001` (infra-expert): Production deploys are still mutable because they consume `:latest` images. Files: `scripts/deploy-do.sh:37-43`, `infrastructure/scripts/setup-droplet.sh:114-115`, `docker-compose.prod.yml` (18 image references), `docker-compose.droplet.yml` (22 image references), `.github/workflows/deploy-digitalocean.yml:626-627,692-693`.

`HIGH-002` (infra-expert): Image vulnerability scanning only covers `gateway-api`. Files: `.github/workflows/security-trivy.yml:60-75`, `.github/workflows/deploy-digitalocean.yml:618-693`.

## Affected Files
- /var/aqua-saas/docker-compose.prod.yml
- /var/aqua-saas/docker-compose.droplet.yml
- /var/aqua-saas/scripts/deploy-do.sh
- /var/aqua-saas/infrastructure/scripts/setup-droplet.sh
- /var/aqua-saas/.github/workflows/deploy-digitalocean.yml
- /var/aqua-saas/.github/workflows/security-trivy.yml

## Dependencies
24-supply-chain-immutable-pins -- base image pinning must be in place before switching to immutable deploy tags. The supply-chain fix ensures the build produces deterministic images; this package ensures those deterministic images are what production actually runs.

## Atomic Commit Plan
```
fix(infra): deploy by immutable tag and expand Trivy scanning to all images

Production compose files deployed from mutable :latest tags, making
rollouts non-reproducible and rollback ambiguous. The Trivy scan only
covered gateway-api, leaving all other images unscanned. This switches
deploy scripts and compose files to use immutable ${TAG} references,
and expands the Trivy scan matrix to cover every built/pushed release
image with a fail-on-HIGH/CRITICAL gate.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/25-infra-immutable-deploy-tags.md
Closes: docs/reviews/infra-expert/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/infra-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Verify no `:latest` tag appears in production compose files.
- Verify deploy scripts pass an explicit tag/digest, not `:latest`.
- Verify Trivy workflow scans all images in the deploy matrix.
- Verify Trivy workflow fails on HIGH/CRITICAL findings.
- CI test: deploy workflow with immutable tags produces reproducible rollout.

## Verification Command
`grep -rn ':latest' /var/aqua-saas/docker-compose.prod.yml /var/aqua-saas/docker-compose.droplet.yml | grep 'image:' | grep -c '' | grep '^0$'`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

