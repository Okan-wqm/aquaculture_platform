/**
 * FE-MEDIUM-312 / FE-HIGH-314 — the tenant-admin pages scoped to the Suderra
 * page surface (production's nine, plus the four the restyle moved into it)
 * keep their `sd-page` root class.
 *
 * The class is how the Suderra stylesheet finds a page's surface; it has no
 * behaviour of its own, so dropping it from a page root (a restyle, a layout
 * refactor) passes every render test and only shows up as an unstyled page in
 * production. That is exactly how the class was lost the first time: the edits
 * lived only in an uncommitted production build (PROC-HIGH-047).
 *
 * A SOURCE-level guard on purpose, in both directions:
 *  - every listed page carries `sd-page` as its root's first class, once;
 *  - no page outside the list carries it, so adding the scope to a page means
 *    adding it here, and this list stays the one inventory of scoped pages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const PAGES_DIR = resolve(__dirname, '..');

const SD_PAGE_SCOPED = [
  'EdgeDeviceDetailPage.tsx',
  'EdgeDevicesPage.tsx',
  'TenantActivityPage.tsx',
  'TenantAnnouncementsPage.tsx',
  'TenantAuditLogPage.tsx',
  'TenantBillingPage.tsx',
  'TenantDashboard.tsx',
  'TenantDatabase.tsx',
  'TenantMessagesPage.tsx',
  'TenantModules.tsx',
  'TenantRolesPage.tsx',
  'TenantSupportPage.tsx',
  'TenantUsers.tsx',
] as const;

/** `className="sd-page"` or `className="sd-page …"` — the scope as the first class. */
const SD_PAGE_ROOT_CLASS = /className="sd-page(?:\s[^"]*)?"/g;

function scopeCount(file: string): number {
  const source = readFileSync(resolve(PAGES_DIR, file), 'utf-8');
  return source.match(SD_PAGE_ROOT_CLASS)?.length ?? 0;
}

describe('tenant-admin Suderra page scope (FE-MEDIUM-312)', () => {
  it.each(SD_PAGE_SCOPED)('%s carries sd-page exactly once', (file) => {
    expect(scopeCount(file)).toBe(1);
  });

  it('no page outside the inventory carries sd-page', () => {
    const scoped = readdirSync(PAGES_DIR)
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) => scopeCount(file) > 0)
      .sort();
    expect(scoped).toEqual([...SD_PAGE_SCOPED].sort());
  });
});
