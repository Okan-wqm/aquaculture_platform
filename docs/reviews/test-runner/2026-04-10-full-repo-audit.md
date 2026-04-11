# Test Runner Review
**Date:** 2026-04-10  
**Scope:** Full-repo audit of test quality, coverage strategy, build/test health configuration, and verification gaps

**Decision:** `BLOCK`

I ran one targeted Vitest check for `tenant-admin`; the rest of this audit is static analysis of test files, configs, and CI/workflow wiring.

## Summary
| Area | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Total | 0 | 2 | 1 | 0 |

## Findings

### HIGH-001 `tenant-admin` React tests run in the wrong Vitest environment
`web/modules/tenant-admin/package.json` exposes `test` and `test:watch`, and `web/modules/tenant-admin/src/pages/__tests__/TenantUsers.spec.tsx` is a React Testing Library test that requires a DOM. However `web/modules/tenant-admin/vite.config.ts` defines no `test` block at all, unlike the working MFE pattern in `web/modules/dashboard/vite.config.ts`.

I verified the failure directly with `npx vitest run src/pages/__tests__/TenantUsers.spec.tsx --reporter=basic` in `web/modules/tenant-admin`; it failed with `document is not defined` across the suite.

Evidence:
- [web/modules/tenant-admin/package.json](/var/aqua-saas/web/modules/tenant-admin/package.json#L6)
- [web/modules/tenant-admin/vite.config.ts](/var/aqua-saas/web/modules/tenant-admin/vite.config.ts#L16)
- [web/modules/tenant-admin/src/pages/__tests__/TenantUsers.spec.tsx](/var/aqua-saas/web/modules/tenant-admin/src/pages/__tests__/TenantUsers.spec.tsx#L12)
- [web/modules/dashboard/vite.config.ts](/var/aqua-saas/web/modules/dashboard/vite.config.ts#L65)

Remediation:
- Add a Vitest `test` block to `web/modules/tenant-admin/vite.config.ts` with `environment: 'jsdom'`, `globals: true`, and `setupFiles`, mirroring the repo's other React MFEs.
- Keep the test command non-watch in CI and make the missing DOM environment a hard failure before merge.

Cross-domain dependency:
- `frontend-expert`, `security-reviewer`

### HIGH-002 Several backend services have empty test suites despite declared test targets
`apps/config-service/project.json`, `apps/notification-service/project.json`, and `apps/observability-service/project.json` each define a Jest `test` target, so `ci-affected.yml` and `ci-full.yml` will treat them as testable workspace projects. In practice, a static scan found no `*.spec.ts`, `*.test.ts`, `*.spec.tsx`, or `*.test.tsx` files under those source trees, which means the workspace can report green test runs without exercising any runtime behavior in those services.

Evidence:
- [apps/config-service/project.json](/var/aqua-saas/apps/config-service/project.json#L49)
- [apps/notification-service/project.json](/var/aqua-saas/apps/notification-service/project.json#L51)
- [apps/observability-service/project.json](/var/aqua-saas/apps/observability-service/project.json#L52)
- [.github/workflows/ci-affected.yml](/var/aqua-saas/.github/workflows/ci-affected.yml#L133)
- [.github/workflows/ci-full.yml](/var/aqua-saas/.github/workflows/ci-full.yml#L114)

Remediation:
- Add real service-level unit and integration tests for startup, handlers, persistence, and health behavior.
- Add a minimum coverage floor or an explicit "no empty suite" gate so these projects cannot silently pass CI with zero exercised code.

Cross-domain dependency:
- `platform-services`, `context-manager`

### MEDIUM-003 `hydroponics-module` is shipped in build/deploy matrices but has no test harness
`web/modules/hydroponics-module/package.json` has only `dev`, `build`, and `preview` scripts, and `web/modules/hydroponics-module/vite.config.ts` has no `test` block. The module is still included in the root frontend build script, the full CI frontend build matrix, and the DigitalOcean deploy service list, so it participates in release flow without any automated test path.

Evidence:
- [web/modules/hydroponics-module/package.json](/var/aqua-saas/web/modules/hydroponics-module/package.json#L7)
- [web/modules/hydroponics-module/vite.config.ts](/var/aqua-saas/web/modules/hydroponics-module/vite.config.ts#L13)
- [package.json](/var/aqua-saas/package.json#L62)
- [.github/workflows/ci-full.yml](/var/aqua-saas/.github/workflows/ci-full.yml#L196)
- [.github/workflows/deploy-digitalocean.yml](/var/aqua-saas/.github/workflows/deploy-digitalocean.yml#L90)

Remediation:
- Add a Vitest configuration and at least one smoke/component test path for module bootstrap and critical user flows.
- Wire the module into the same coverage and CI expectations as the other production MFEs.

Cross-domain dependency:
- `frontend-expert`, `platform-services`

## Notes
- I did not run the full workspace test suite.
- The audit focused on configuration and test inventory, plus one targeted Vitest execution to validate the `tenant-admin` failure mode.
