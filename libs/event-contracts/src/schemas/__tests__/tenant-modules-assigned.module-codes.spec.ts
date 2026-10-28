/**
 * TenantModulesAssigned carries module codes of the module dictionary (RBAC-MEDIUM-023).
 *
 * `moduleCodes` was typed `string[]` and validated as any short string: an untyped copy of the
 * module vocabulary, next to the six declared copies the review named. Its values are the codes of
 * the auth `modules` catalogue, which the dictionary's PLATFORM_MODULE declares, so the contract
 * and its trust-boundary validator admit exactly those. A GraphQL enum spelling ('FARM') or a code
 * the dictionary does not hold cannot cross.
 */
import { PLATFORM_MODULE_CODES, type PlatformModuleCode } from '@aquaculture/shared-contracts';

import type { TenantModulesAssignedEvent } from '../../tenant-events';
import { validateTenantEvent } from '../validator';

/** True when A and B are the same type: the type-level half of this spec. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function modulesAssigned(moduleCodes: readonly string[]): Record<string, unknown> {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'TenantModulesAssigned',
    timestamp: '2026-10-26T12:00:00.000Z',
    tenantId: '11111111-1111-4111-8111-111111111111',
    version: 2,
    moduleIds: ['44444444-4444-4444-8444-444444444444'],
    moduleCodes,
    assignedBy: '22222222-2222-4222-8222-222222222222',
  };
}

describe('TenantModulesAssigned.moduleCodes (RBAC-MEDIUM-023)', () => {
  it('is typed by the module dictionary', () => {
    const typedByDictionary: Equals<
      TenantModulesAssignedEvent['moduleCodes'],
      PlatformModuleCode[] | undefined
    > = true;
    expect(typedByDictionary).toBe(true);
  });

  it('accepts every module dictionary code', () => {
    const result = validateTenantEvent(
      'TenantModulesAssigned',
      modulesAssigned(PLATFORM_MODULE_CODES),
    );
    expect(result).toEqual({ valid: true });
  });

  it.each(['FARM', 'seapod', ''])('rejects %p, which is not a module dictionary code', (code) => {
    const result = validateTenantEvent('TenantModulesAssigned', modulesAssigned(['farm', code]));
    expect(result.valid).toBe(false);
  });
});
