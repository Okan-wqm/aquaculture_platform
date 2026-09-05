/**
 * INVARIANT — every mutating admin route names its platform capability, and
 * the capability model has one enum, one projection and one guard
 * (ADR-0016, SEC-HIGH-059).
 *
 * Until 2026-09-05 the SUPER_ADMIN role was the entire authorization model of
 * the platform-admin surface. Now:
 *
 *   1. Every @Post/@Put/@Patch/@Delete handler in admin-api carries
 *      @RequiresCapability(...) in its decorator block (or @Public(), which
 *      has no principal), or is listed in the governed ratchet
 *      `.claude/allowlists/uncapability-admin-routes.yaml` with owner, future
 *      expiry, findingId and reason under a ceiling that only decreases.
 *   2. PlatformCapabilityGuard is registered as an APP_GUARD in admin-api
 *      AFTER PlatformAdminGuard — it must only ever see admitted requests.
 *   3. auth-service's TokenService projects the claim from
 *      auth.platform_capability_grants, and the admin PlatformAdminGuard
 *      copies it onto the request narrowed to the closed enum.
 *   4. The capability vocabulary is declared once: no other file spells out
 *      the enum values as a list.
 *   5. DestructiveActionGuard requires `break-glass`, and the NATS ACL grants
 *      admin-api the three capability command subjects.
 */

import * as yaml from 'js-yaml';

import {
  allAdminMutationHandlers,
  readRepoFile,
  stripComments,
} from './lib/admin-mutation-handlers';

const ALLOWLIST = '.claude/allowlists/uncapability-admin-routes.yaml';

interface AllowlistEntry {
  handler: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

describe('INVARIANT (ADR-0016): platform capabilities — one enum, one projection, one guard, every mutation named', () => {
  const handlers = allAdminMutationHandlers();
  const doc = yaml.load(readRepoFile(ALLOWLIST)) as {
    ceiling?: number;
    entries?: AllowlistEntry[];
  };
  const entries = doc.entries ?? [];
  const ceiling = doc.ceiling ?? 0;
  const today = new Date().toISOString().slice(0, 10);

  const uncovered = handlers
    .filter((h) => !h.isPublic)
    .filter((h) => !/@RequiresCapability\(/.test(h.block))
    .map((h) => h.id)
    .sort();

  it('reflects on the fleet of admin mutation handlers (sanity)', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(200);
  });

  it('every non-public mutation handler names a capability or is governed by the ratchet', () => {
    const governed = new Set(entries.map((e) => e.handler));
    expect(uncovered.filter((id) => !governed.has(id))).toEqual([]);
  });

  it('the ratchet only shrinks: a ceiling, and entries that are genuinely uncovered, with owner, future expiry and finding', () => {
    expect(entries.length).toBeLessThanOrEqual(ceiling);
    const actual = new Set(uncovered);
    for (const entry of entries) {
      expect(actual.has(entry.handler)).toBe(true);
      expect(entry.owner).toMatch(/\S/);
      expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
      expect(entry.reason).toMatch(/\S/);
      const expiry =
        entry.expiry instanceof Date ? entry.expiry.toISOString().slice(0, 10) : entry.expiry;
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(expiry > today).toBe(true);
    }
  });

  it('a capability decorator never appears at class level: GETs stay admitted by the role alone', () => {
    const offenders = handlers
      .filter((h) => /@RequiresCapability\(/.test(h.classDecorators))
      .map((h) => h.file);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('PlatformCapabilityGuard is the APP_GUARD registered after PlatformAdminGuard in admin-api', () => {
    const appModule = stripComments(readRepoFile('apps/admin-api-service/src/app.module.ts'));
    const registrations = [
      ...appModule.matchAll(/provide:\s*APP_GUARD,\s*(?:useExisting|useClass):\s*(\w+)/g),
    ].map((m) => m[1]);
    expect(registrations[0]).toBe('PlatformAdminGuard');
    expect(registrations).toContain('PlatformCapabilityGuard');
    expect(registrations.indexOf('PlatformCapabilityGuard')).toBeGreaterThan(
      registrations.indexOf('PlatformAdminGuard'),
    );
    expect(registrations.filter((g) => g === 'PlatformCapabilityGuard')).toHaveLength(1);
  });

  it('auth-service projects the claim from the grant table with the shared live predicate', () => {
    const token = stripComments(
      readRepoFile('apps/auth-service/src/modules/authentication/services/token.service.ts'),
    );
    expect(token).toMatch(/platformCapabilities\?: PlatformCapability\[\]/);
    expect(token).toMatch(/"auth"\."platform_capability_grants"/);
    expect(token).toMatch(/LIVE_PLATFORM_CAPABILITY_GRANT_SQL/);
    expect(token).toMatch(/platformCapabilities\.length > 0 \? \{ platformCapabilities \} : \{\}/);
    expect(token).toMatch(/toPlatformCapabilities\(/);
  });

  it('the admin authentication guard copies the claim onto the request narrowed to the enum', () => {
    const guard = stripComments(
      readRepoFile('apps/admin-api-service/src/guards/platform-admin.guard.ts'),
    );
    expect(guard).toMatch(
      /platformCapabilities:\s*toPlatformCapabilities\(payload\.platformCapabilities\)/,
    );
  });

  it('the capability vocabulary is declared once', () => {
    const enumFile = readRepoFile('libs/event-contracts/src/enums/platform-capability.enum.ts');
    expect(enumFile).toMatch(/'break-glass',\n\] as const;/);
    // The writer's CHECK constraint mirrors the enum by design and is pinned to it here.
    const migration = readRepoFile(
      'apps/auth-service/src/migrations/1808500000000-PlatformCapabilityGrants.ts',
    );
    for (const capability of [
      'billing-ops',
      'support-ops',
      'security-ops',
      'platform-read-only',
      'break-glass',
    ]) {
      expect(enumFile).toContain(`'${capability}'`);
      expect(migration).toContain(`'${capability}'`);
    }
  });

  it('DestructiveActionGuard requires break-glass, and the decorator defaults it on', () => {
    const guard = stripComments(
      readRepoFile('libs/backend-common/src/guards/destructive-action.guard.ts'),
    );
    expect(guard).toMatch(/includes\('break-glass'\)/);
    const decorator = stripComments(
      readRepoFile('libs/backend-common/src/decorators/destructive.decorator.ts'),
    );
    expect(decorator).toMatch(/requiresBreakGlass: options\.requiresBreakGlass \?\? true/);
  });

  it('admin-api may publish the three capability command subjects (NATS ACL SSoT)', () => {
    const acl = readRepoFile('infrastructure/nats/services.yaml');
    const adminBlock = acl.slice(acl.indexOf('- name: admin_api_service'));
    for (const subject of [
      'request.auth.admin.grantPlatformCapability',
      'request.auth.admin.revokePlatformCapability',
      'request.auth.admin.listPlatformCapabilityGrants',
    ]) {
      expect(adminBlock).toContain(`'${subject}'`);
    }
  });
});
