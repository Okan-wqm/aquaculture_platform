# Frontend Review Report
**Date:** 2026-04-10  
**Scope:** `web/shell/**`, `web/shared-ui/**`, `web/modules/dashboard/**`, `web/apps/aquamobil/**`

## Deployment Decision
**BLOCK**
- Blocking findings: `FE-CRITICAL-001`, `FE-CRITICAL-002`

## Summary
| Area | CRITICAL | HIGH | MEDIUM | LOW |
| --- | ---: | ---: | ---: | ---: |
| Shell / federation security | 1 | 1 | 0 | 0 |
| Shared UI / offline cache | 1 | 0 | 0 | 0 |
| Total | 2 | 1 | 0 | 0 |

## Critical Findings

### FE-CRITICAL-001 - Remote integrity guard bypasses every non-`remoteEntry` script
- Files: [web/shell/src/utils/remoteIntegrity.ts:113](/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts)
- Evidence: `validateAndEnforceScriptSrc()` exits early unless `src.includes('remoteEntry')` is true. The createElement/setAttribute patches therefore only inspect URLs containing `remoteEntry`, while any other injected script path skips allowlist and SRI enforcement entirely.
- Why it matters: this is a straight bypass of the shell's remote-script security boundary. A compromised remote, a malicious extension, or any injected code can load non-`remoteEntry` scripts without the allowlist or integrity check ever running.
- Remediation: validate every script URL inserted by the federation runtime, not just `remoteEntry` files; fail closed when a federation script URL has no manifest pin in production; enforce integrity at the runtime `createScript` hook so the browser performs the check before execution.

### FE-CRITICAL-002 - Tenant-scoped offline caches are missing tenant prefixes
- Files: [web/apps/aquamobil/src/pwa/offline-queue.ts:300](/var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts), [web/apps/aquamobil/src/hooks/useMySchedule.ts:115](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMySchedule.ts), [web/apps/aquamobil/src/hooks/useMessages.ts:93](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMessages.ts)
- Evidence: `cacheData()` stores entries as `cache_${key}` with no tenant component. Callers then pass keys like `schedule_${weekStartDate}` and `messaging_messages_${channelId}` without `tenantId`. Those values are tenant-specific data, but the IndexedDB cache namespace is shared across the whole origin.
- Why it matters: on tenant switch, impersonation, or shared-device reuse, AquaMobil can serve cached schedule/message data from a previous tenant. This is the exact cross-tenant browser-storage leak the tenant-isolation rules are meant to prevent.
- Remediation: make tenant ID a required part of the cache API, namespace all offline keys as `cache_${tenantId}:${key}` or equivalent, and clear the previous tenant namespace on tenant switch, not only on logout.

## High Priority Findings

### FE-HIGH-001 - Shell fallback CSP still allows inline script execution
- Files: [web/shell/index.html:17](/var/aqua-saas/web/shell/index.html)
- Evidence: the fallback CSP includes `script-src 'self' 'unsafe-inline' ...` and `script-src-elem 'self' 'unsafe-inline' ...`. There is no inline script requirement in the document itself, so the allowance is broader than needed.
- Why it matters: if the HTTP header is absent or misconfigured, the app falls back to a policy that permits inline script execution, which materially weakens XSS defense-in-depth.
- Remediation: remove `unsafe-inline` from script directives, keep any intentional inline script behind a nonce or hash, and align the fallback policy with the production header rather than making it permissive.

## Cross-Domain Dependencies
| From | To | Note |
| --- | --- | --- |
| `web/apps/aquamobil/src/pwa/offline-queue.ts` | AquaMobil schedule and messaging hooks | The storage API is shared by `useMySchedule()` and `useMessages()`, so a namespace fix must be applied centrally, not per hook. |
| `web/shell/src/utils/remoteIntegrity.ts` | Shell MFEs | The integrity guard affects every remote module loaded by the shell, so the fix has to be enforced at the host runtime, not inside a single remote. |

## Notes
- Static review only. Tests were not run.
