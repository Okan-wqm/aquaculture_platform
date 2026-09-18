/**
 * FE-CRITICAL-014/015/016 — every tenant-admin cache key must carry the tenant.
 *
 * useTenantBilling and useTenantActivity cached under BARE keys
 * (['tenant-billing'], ['tenant-activity']) with no tenant prefix and no
 * session epoch, so tenant A's billing and login activity survived a switch to
 * tenant B and were served to it. Both now go through the useTenantQuery SSoT,
 * which supplies the prefix and the epoch.
 *
 * This is a SOURCE-level guard rather than a render test on purpose: the
 * defect is the SHAPE of the key a hook asks for, and a hook that reverts to
 * useQuery with a literal key would keep passing any behavioural test that
 * only ever renders one tenant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const HOOKS_DIR = resolve(__dirname, '..');

const read = (file: string): string => readFileSync(resolve(HOOKS_DIR, file), 'utf-8');

const TENANT_SCOPED_HOOKS = [
  'useTenantBilling.ts',
  'useTenantActivity.ts',
  'useTenantAuditLog.ts',
] as const;

describe('tenant-admin cache keys are tenant-scoped (FE-CRITICAL-014/015/016)', () => {
  it.each(TENANT_SCOPED_HOOKS)('%s resolves its key through the tenant-scoped SSoT', (file) => {
    const source = read(file);
    const usesSsot = source.includes('useTenantQuery') || source.includes('createTenantQueryKey');
    expect(usesSsot).toBe(true);
  });

  it.each(TENANT_SCOPED_HOOKS)('%s declares no bare, untenanted query key', (file) => {
    const source = read(file);
    // The pre-fix shape: a literal key array that starts with a domain string
    // instead of the tenant prefix.
    expect(source).not.toMatch(/queryKey:\s*\[\s*['"]tenant-/);
    expect(source).not.toMatch(/all:\s*\[\s*['"]tenant-\w+['"]\s*\]\s*as const/);
  });

  it('exports no key factory that would rebuild an untenanted key', () => {
    const barrel = read('index.ts');
    expect(barrel).not.toContain('billingKeys');
    expect(barrel).not.toContain('activityKeys');
  });
});
