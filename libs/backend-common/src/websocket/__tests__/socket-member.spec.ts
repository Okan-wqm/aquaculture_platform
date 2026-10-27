import { isUserCaller } from '@aquaculture/shared-contracts';

import { socketMemberOf, type SocketMember } from '../socket-member';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: USER,
    tenantId: TENANT,
    type: 'access',
    jti: 'j1',
    roles: ['MODULE_USER'],
    moduleAccess: { farm: 'MODULE_USER' },
    ...overrides,
  };
}

function memberOf(overrides: Record<string, unknown> = {}): SocketMember {
  const member = socketMemberOf(claims(overrides));
  if (member === null) throw new Error('expected the claims to describe a member');
  return member;
}

/**
 * The member a verified socket handshake token describes (ADR-051 §1, §2 Transport;
 * SEC-CRITICAL-206, SEC-CRITICAL-207). Every module-scoped socket decides its rooms from this one
 * parse, so a malformed claim refuses the handshake exactly as the subgraph middleware answers it
 * with 400, and a token minted before the claim means no grants.
 */
describe('socketMemberOf', () => {
  it('builds a verified member caller with the grants, capabilities and sites of the token', () => {
    const member = memberOf({ assignedSiteIds: [SITE], resourcePermissions: ['company:view'] });

    expect(member.tenantId).toBe(TENANT);
    expect(member.assignedSiteIds).toEqual([SITE]);
    expect(isUserCaller(member.caller)).toBe(true);
    expect(member.caller.userId).toBe(USER);
    expect(member.caller.tenantId).toBe(TENANT);
    expect(member.caller.moduleAccess).toEqual({ farm: 'MODULE_USER' });
    expect(member.caller.capabilities).toEqual(['company:view']);
    expect(member.caller.accountRole).toBeNull();
  });

  it('reads a token without moduleAccess or assignedSiteIds as no grants and no sites', () => {
    const member = memberOf({ moduleAccess: undefined });

    expect(member.caller.moduleAccess).toEqual({});
    expect(member.assignedSiteIds).toEqual([]);
  });

  it('keeps only the account role of the roles claim', () => {
    expect(memberOf({ roles: ['TENANT_ADMIN'] }).caller.accountRole).toBe('TENANT_ADMIN');
    expect(memberOf({ roles: ['MODULE_MANAGER'] }).caller.accountRole).toBeNull();
  });

  it.each([
    ['a missing subject', { sub: undefined }],
    ['an empty subject', { sub: '' }],
    ['a missing tenant', { tenantId: undefined }],
    ['a tenant that is no tenant id', { tenantId: 'tenant-1' }],
    ['a roles claim that is no string list', { roles: 'MODULE_USER' }],
    ['a grant in a module that owns nothing', { moduleAccess: { ai: 'MODULE_USER' } }],
    ['a grant of an account role', { moduleAccess: { farm: 'TENANT_ADMIN' } }],
    ['a capabilities claim that is no string list', { resourcePermissions: 'company:view' }],
    ['a site claim that is no string list', { assignedSiteIds: SITE }],
    ['a site claim holding a non-string', { assignedSiteIds: [SITE, 7] }],
  ])('refuses %s', (_case, overrides) => {
    expect(socketMemberOf(claims(overrides))).toBeNull();
  });

  it('copies the site list, so a later change to the claims cannot change the member', () => {
    const sites = [SITE];
    const member = memberOf({ assignedSiteIds: sites });
    sites.push('44444444-4444-4444-8444-444444444444');

    expect(member.assignedSiteIds).toEqual([SITE]);
    expect(Object.isFrozen(member.assignedSiteIds)).toBe(true);
  });
});
