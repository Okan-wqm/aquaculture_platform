# Package 29: edge-scada-pwa-self-contained

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [edge-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/edge-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The embedded SCADA service worker precaches external CDN URLs alongside local paths. If any CDN fetch fails, the install step fails (all-or-nothing), and the local HMI loses its offline guarantee. On an edge device that may operate without internet access, this is an availability failure.

## Findings
`HIGH-002` (edge-expert): SCADA PWA install path depends on external CDNs. File: `sens-api-gateway/src/scada_server.rs`. `SERVICE_WORKER_JS` precaches external URLs at lines 118-128, and `cache.addAll(PRECACHE_URLS)` at lines 131-136 is all-or-nothing.

## Affected Files
- /var/aqua-saas/sens-api-gateway/src/scada_server.rs

## Dependencies
None.

## Atomic Commit Plan
```
fix(edge): vendor SCADA PWA assets locally and remove CDN dependencies

The SCADA service worker precached external CDN URLs, making the PWA
install an all-or-nothing operation that fails without internet access.
On edge devices that operate offline, this defeats the entire offline
guarantee. This vendors all SCADA UI assets into the edge image, caches
only same-origin resources, and removes third-party URLs from the
precache list so the service worker installs with no network.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/29-edge-scada-pwa-self-contained.md
Closes: docs/reviews/edge-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Verify no external URLs in the precache list.
- Verify all precached assets are same-origin paths.
- Test: service worker installs with network disabled.
- Test: SCADA HMI loads fully offline after initial install.

## Verification Command
`cd /var/aqua-saas/sens-api-gateway && cargo clippy --all-targets -- -D warnings && cargo test`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

