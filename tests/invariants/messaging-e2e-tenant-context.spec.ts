/**
 * Platform-wide invariant — DEFECT-3 / INFRA-CRITICAL-025:
 *
 * The messaging-service E2E test harness MUST expose a `withTenantContext`
 * helper that wraps direct `dataSource.*` calls in a synthetic
 * AsyncLocalStorage frame carrying `schemaName = tenant_<uuid>`.
 *
 * # Why
 *
 * Tenant routing in production goes through the request middleware chain
 * (UserContext → TenantContext → TenantSchema), which seeds ALS with
 * `schemaName`. The patched pg pool (TenantConnectionBootstrap) reads
 * ALS on every connection checkout and pins the search_path to the
 * tenant schema. The end-to-end SourceSchemaWriteGuardService trigger
 * sees writes hitting `tenant_<uuid>.<table>` and lets them through.
 *
 * Tests that hit the GraphQL HTTP surface via `gqlRequest()` get the
 * full chain automatically. Tests that perform DIRECT `dataSource`
 * calls (typical for fixture-bootstrap, OUTBOX inspection, assert
 * helpers reaching behind GraphQL) run OUTSIDE any request — ALS is
 * empty → search_path falls back to `messaging,public` → the write
 * hits the source schema → the trigger raises `TENANT_ISOLATION_VIOLATION`.
 *
 * `withTenantContext(tenantId, fn)` closes that gap by establishing the
 * ALS frame manually so the patched pool routes per-test direct queries
 * to the right tenant schema.
 *
 * # What this invariant locks
 *
 * 1. The helper exists at `apps/messaging-service/test/e2e-setup.ts`.
 * 2. The helper imports `requestContextStorage` from backend-common
 *    (the same singleton AsyncLocalStorage instance the production
 *    middleware chain uses).
 * 3. The helper composes the new ALS store WITH the parent store so
 *    upstream-set fields (correlationId, traceId, …) are not dropped.
 *
 * Future regressions that delete the helper, replace it with a thin
 * wrapper that doesn't compose, or import a different ALS instance
 * fail CI here.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const E2E_SETUP = resolve(
  REPO_ROOT,
  'apps/messaging-service/test/e2e-setup.ts',
);

describe('INVARIANT (DEFECT-3): messaging E2E exposes withTenantContext helper', () => {
  it('e2e-setup.ts defines and exports `withTenantContext`', () => {
    if (!existsSync(E2E_SETUP)) {
      throw new Error(`Expected ${E2E_SETUP} to exist (E2E test harness file).`);
    }
    const src = readFileSync(E2E_SETUP, 'utf8');

    // Export signature.
    if (!/export\s+async\s+function\s+withTenantContext\b/.test(src)) {
      throw new Error(
        'apps/messaging-service/test/e2e-setup.ts: missing `export async function withTenantContext(...)`. ' +
          'See the helper docblock in e2e-setup.ts for the canonical signature.',
      );
    }

    // Imports `requestContextStorage` from backend-common (the singleton
    // ALS instance used by the production middleware chain). A different
    // ALS instance would be silently broken — the patched pool reads the
    // production singleton.
    if (!/import\s*\{[^}]*\brequestContextStorage\b[^}]*\}\s*from\s*['"]@aquaculture\/backend-common['"]/.test(src)) {
      throw new Error(
        'apps/messaging-service/test/e2e-setup.ts: `withTenantContext` MUST import requestContextStorage ' +
          'from `@aquaculture/backend-common` (the singleton ALS instance used by the production ' +
          'middleware chain + TenantConnectionBootstrap). A locally-instantiated AsyncLocalStorage ' +
          'would be a silent no-op — the production pool patch would never see the test\'s store.',
      );
    }

    // Composes parent store. Without this, upstream context (correlationId,
    // traceId, userId, …) is silently dropped when the helper wraps a body
    // that itself runs inside an existing context.
    if (!/getStore\(\)/.test(src) || !/\.\.\.\s*\(?\s*currentStore\s*\??\s*\?\?\s*\{\s*\}\s*\)?/.test(src)) {
      throw new Error(
        'apps/messaging-service/test/e2e-setup.ts: `withTenantContext` MUST compose the new store ' +
          'with the existing store via `requestContextStorage.getStore()` and a spread `...(currentStore ?? {})`. ' +
          'Otherwise upstream-set fields (correlationId, traceId, …) are dropped when the helper is nested ' +
          'inside an existing context.',
      );
    }
  });
});
