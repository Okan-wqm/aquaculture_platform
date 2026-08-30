import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { PermissionOverridesInput } from '../tenant-role.dto';

/**
 * RBAC-MEDIUM-003 — the override arrays are bounded at the validation boundary
 * (defense-in-depth on top of the CapabilityAuthorityService catalogue whitelist)
 * so an abusive payload is rejected before it can inflate the JWT/assertion.
 */
describe('PermissionOverridesInput bounds (RBAC-MEDIUM-003)', () => {
  const violated = (input: { grants?: unknown; revokes?: unknown }): string[] =>
    validateSync(plainToInstance(PermissionOverridesInput, input)).map((e) => e.property);

  it('accepts a normal override payload', () => {
    expect(violated({ grants: ['roles:view', 'roles:create'], revokes: ['sites:view'] })).toEqual(
      [],
    );
  });

  it('rejects a grants array over the max size', () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => `r${i}:view`);
    expect(violated({ grants: tooMany, revokes: [] })).toContain('grants');
  });

  it('rejects a revokes array over the max size', () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => `r${i}:view`);
    expect(violated({ grants: [], revokes: tooMany })).toContain('revokes');
  });

  it('rejects an over-long capability string', () => {
    const longCap = 'x'.repeat(129);
    expect(violated({ grants: [longCap], revokes: [] })).toContain('grants');
  });

  it('accepts an array exactly at the max size', () => {
    const exact = Array.from({ length: 256 }, (_, i) => `r${i}:view`);
    expect(violated({ grants: exact, revokes: [] })).toEqual([]);
  });
});
