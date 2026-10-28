import type { ResolveCallerCapabilitiesResult } from '../../auth-user-queries';
import { validateResolveCallerCapabilitiesResultSchema } from '../auth-user-queries.schema';

const SITE_ID = '33333333-3333-4333-8333-333333333333';

const reply = (
  overrides: Partial<Record<keyof ResolveCallerCapabilitiesResult, unknown>> = {},
): Record<string, unknown> => ({
  success: true,
  found: true,
  active: true,
  roles: ['MODULE_USER'],
  resourcePermissions: ['ai_assistant:use'],
  moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_USER' },
  assignedSiteIds: [SITE_ID],
  ...overrides,
});

/**
 * RBAC-HIGH-028: the caller-capabilities reply carries the sender's module grants and sites
 * (ADR-051 §2 Transport), so the messaging AI bridge, which holds no JWT, can build the member
 * caller from it. The reply schema admits exactly the claim's shape: owner modules mapped to
 * module roles, and site ids.
 */
describe('resolveCallerCapabilities result schema (RBAC-HIGH-028)', () => {
  it('accepts the module grants and the site ids', () => {
    expect(validateResolveCallerCapabilitiesResultSchema(reply())).toBe(true);
    expect(validateResolveCallerCapabilitiesResultSchema(reply({ moduleAccess: {} }))).toBe(true);
    expect(validateResolveCallerCapabilitiesResultSchema(reply({ assignedSiteIds: [] }))).toBe(
      true,
    );
  });

  it.each([
    ['a module that owns no data', { alert: 'MODULE_USER' }],
    ['an unknown module', { greenhouse: 'MODULE_USER' }],
    ['an account role', { farm: 'TENANT_ADMIN' }],
    ['a role in another case', { farm: 'module_manager' }],
    ['a list instead of a map', ['farm']],
  ])('rejects a grant map naming %s', (_label, moduleAccess) => {
    expect(validateResolveCallerCapabilitiesResultSchema(reply({ moduleAccess }))).toBe(false);
  });

  it('rejects a site id that is not a uuid', () => {
    expect(validateResolveCallerCapabilitiesResultSchema(reply({ assignedSiteIds: ['S1'] }))).toBe(
      false,
    );
  });

  it('requires both fields: the responder always answers them', () => {
    const { moduleAccess: _moduleAccess, ...withoutGrants } = reply();
    const { assignedSiteIds: _assignedSiteIds, ...withoutSites } = reply();
    expect(validateResolveCallerCapabilitiesResultSchema(withoutGrants)).toBe(false);
    expect(validateResolveCallerCapabilitiesResultSchema(withoutSites)).toBe(false);
  });
});
