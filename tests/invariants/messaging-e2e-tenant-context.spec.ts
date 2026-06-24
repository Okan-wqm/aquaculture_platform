/**
 * Platform-wide invariant -- DEFECT-3 / INFRA-CRITICAL-025.
 *
 * Messaging E2E tests may perform direct repository/query work for fixtures and
 * assertions. Those calls must use the same tenant context SSoT as production:
 * `@aquaculture/backend-common/context.withTenantContext`.
 *
 * No test harness is allowed to create its own AsyncLocalStorage wrapper. A
 * local helper silently drifts from production context composition and can route
 * writes to the source schema instead of `tenant_<uuid>`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const E2E_SETUP = resolve(
  REPO_ROOT,
  'apps/messaging-service/test/e2e-setup.ts',
);

describe('INVARIANT (INFRA-CRITICAL-025): messaging E2E uses canonical tenant context', () => {
  it('re-exports withTenantContext from backend-common/context and does not define a local ALS helper', () => {
    if (!existsSync(E2E_SETUP)) {
      throw new Error(`Expected ${E2E_SETUP} to exist (E2E test harness file).`);
    }

    const src = readFileSync(E2E_SETUP, 'utf8');

    expect(src).toMatch(
      /export\s*\{\s*withTenantContext\s*\}\s*from\s*['"]@aquaculture\/backend-common\/context['"]/,
    );
    expect(src).not.toMatch(/export\s+async\s+function\s+withTenantContext\b/);
    expect(src).not.toMatch(/\brequestContextStorage\b/);
    expect(src).not.toMatch(/\bAsyncLocalStorage\b/);
    expect(src).not.toMatch(/getStore\(\)/);
    expect(src).not.toMatch(/\.run\(\s*newStore\s*,/);
  });
});
