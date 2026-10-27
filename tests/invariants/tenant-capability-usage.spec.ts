/**
 * INVARIANT: the tenant capability catalogue offers only what a check reads, and every check reads
 * only what the catalogue offers (RBAC-HIGH-025, RBAC-MEDIUM-026; ADR-051 Enforcement; plan
 * PKG-03).
 *
 * Before it, the role editor offered 100 `resource:action` keys and backend checks read 18 of
 * them: a tenant admin who withheld `batches:create` or `employees:view` from a role restricted
 * nothing. In the other direction sensor-service enforced `edge:manage-io-config`, a key the
 * catalogue did not declare and the grant authority therefore refused, so no MODULE_MANAGER could
 * ever hold it. Nothing tied the enforced keys to the grantable ones.
 *
 *   1. Every capability a backend check reads is a catalogue capability. (The checks take
 *      `TenantCapability`, so the compiler refuses a literal; this also covers values the
 *      compiler sees as `string`, such as the persona requirements.)
 *   2. Every catalogue capability has a reader: a backend check, or `decideAccess` (whose
 *      `company` kind reads `company:view` — the one key the plan adds ahead of its Company
 *      projections, PKG-33), or a listed web reader the PKG-03 web part (release R2) removes.
 *   3. The scan cannot be fooled by indirection: an argument it cannot resolve fails, and every
 *      listed forwarding site and web reader must still exist.
 *
 * When it fails:
 *   - "read but not in the catalogue": add the key to TENANT_CAPABILITY_CATALOGUE
 *     (libs/shared-contracts/src/access/tenant-capabilities.ts) or fix the spelling at the check.
 *   - "in the catalogue but read by nothing": wire a check that reads it, or remove the key and
 *     clean the stored grants with a migration (precedent: admin-api
 *     1810500000000-RemoveInertTenantCapabilities).
 *   - "unresolved": read the capability through a literal, a const, a shared-contracts constant
 *     or a parameter of a function called in the same file.
 */
import {
  COMPANY_VIEW_CAPABILITY,
  TENANT_CAPABILITIES,
  isTenantCapability,
} from '@aquaculture/shared-contracts';

import { readRepoFile } from './helpers/module-dictionary-sources';
import {
  scanBackendCapabilityReads,
  scanCapabilityReads,
  stringLiterals,
  type ForwardingSite,
} from './helpers/tenant-capability-readers';

/** Checks that forward the capabilities their own caller names; they read none themselves. */
const FORWARDING_SITES: readonly ForwardingSite[] = [
  {
    file: 'libs/backend-common/src/decorators/require-permission.decorator.ts',
    argument: 'requiredPermissions',
    reason: 'hasAllResourcePermissions hands its caller’s capabilities to holdsTenantCapabilities',
  },
  {
    file: 'libs/backend-common/src/decorators/require-permission.decorator.ts',
    argument: '[requiredPermission]',
    reason: 'hasResourcePermission is the one-capability form of hasAllResourcePermissions',
  },
  {
    file: 'libs/backend-common/src/guards/tenant-permission.guard.ts',
    argument: 'requiredPermissions',
    reason: 'TenantPermissionGuard checks the capabilities @RequireTenantPermission stored',
  },
  {
    file: 'libs/shared-contracts/src/access/decide-access.ts',
    argument: '[spec.capability]',
    reason: 'the account kind checks the capability its AccessSpec names',
  },
];

/**
 * Catalogue keys read only by the web. Each must leave the catalogue once its web reader stops
 * reading it; an entry whose reader no longer names the key fails below.
 */
const WEB_ONLY_READERS: Readonly<
  Record<string, { readonly reader: string; readonly owner: string }>
> = {
  'settings:view': {
    // TENANT_PANEL_CAPABILITIES `satisfies readonly TenantCapability[]`: removing the key in R1
    // would break the web build, and web changes ship in release R2 (plan C1).
    reader: 'web/shared-ui/src/utils/tenant-capabilities.ts',
    owner: 'PKG-03 web part, release R2 (DelegatableTenantCapability)',
  },
};

/** decideAccess reads company:view in its `company` kind (ADR-051 §1). */
const DECIDE_ACCESS = 'libs/shared-contracts/src/access/decide-access.ts';

const scan = scanBackendCapabilityReads(FORWARDING_SITES);
const readers = new Map<string, string[]>();
for (const read of scan.reads) {
  readers.set(read.capability, [...(readers.get(read.capability) ?? []), read.where]);
}

describe('INVARIANT: tenant capability usage (RBAC-HIGH-025, RBAC-MEDIUM-026)', () => {
  describe('the scan', () => {
    it('follows each form a check is written in', () => {
      const source = `
        import { EDGE_DEVICE_IO_CONFIG_CAPABILITY } from '@aquaculture/shared-contracts';
        const SALARY = 'hr_finance:view_salary';
        class R {
          @RequireTenantPermission('roles:view', EDGE_DEVICE_IO_CONFIG_CAPABILITY)
          a() {}
          b(user) { return hasResourcePermission(user, SALARY); }
          c(user) { this.check(user, 'ai_settings:view'); }
          d(user, persona) { return hasAllResourcePermissions(user, persona.requiredCapabilities); }
          private check(user, capability) { hasResourcePermission(user, capability); }
          e(user, unknownValue) { return hasResourcePermission(user, unknownValue.key); }
        }`;
      const result = scanCapabilityReads('apps/x/src/fixture.ts', source, []);
      const read = new Set(result.reads.map((entry) => entry.capability));
      expect([...read]).toEqual(
        expect.arrayContaining([
          'roles:view',
          'edge_devices:manage_io_config',
          'hr_finance:view_salary',
          'ai_settings:view',
          'ai_personas:operator',
          'ai_specialties:farm',
        ]),
      );
      expect(result.unresolved).toEqual([
        'apps/x/src/fixture.ts:11 hasResourcePermission(… unknownValue.key …)',
      ]);
    });

    it('reads the backend checks it is meant to (a broken scan must not pass as "no reads")', () => {
      const files = new Set(scan.reads.map((read) => read.where.replace(/:\d+$/, '')));
      expect([...files]).toEqual(
        expect.arrayContaining([
          'apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts',
          'apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts',
          'apps/sensor-service/src/edge-device/edge-device.resolver.ts',
          'apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts',
          'apps/messaging-service/src/channel/resolvers/channel.resolver.ts',
          'apps/ai-service/src/tenant-config/agent-config.resolver.ts',
          'apps/gateway-api/src/websocket/ai-chat.gateway.ts',
          DECIDE_ACCESS,
        ]),
      );
    });

    it('resolves every capability argument it meets', () => {
      expect(scan.unresolved).toEqual([]);
    });

    it('meets every listed forwarding site (an entry naming no call fails)', () => {
      expect(
        FORWARDING_SITES.map((site) => `${site.file}#${site.argument}`).filter(
          (key) => !scan.forwardingMet.includes(key),
        ),
      ).toEqual([]);
    });
  });

  it('1. every capability a backend check reads is in the catalogue', () => {
    expect(
      [...readers.entries()]
        .filter(([capability]) => !isTenantCapability(capability))
        .map(([capability, where]) => `${capability} read at ${where.join(', ')}`),
    ).toEqual([]);
  });

  it('2. every catalogue capability is read by a backend check, decideAccess or a listed web reader', () => {
    const webOnly = new Set(Object.keys(WEB_ONLY_READERS));
    expect(
      TENANT_CAPABILITIES.filter(
        (capability) => !readers.has(capability) && !webOnly.has(capability),
      ),
    ).toEqual([]);
  });

  it('decideAccess is the reader of company:view', () => {
    expect(readers.get(COMPANY_VIEW_CAPABILITY)).toEqual([
      expect.stringMatching(new RegExp(`^${DECIDE_ACCESS}:\\d+$`)),
    ]);
  });

  describe('3. each web-only key is still read by its web reader, and by no backend check', () => {
    it.each(Object.entries(WEB_ONLY_READERS))('%s (%j)', (capability, { reader }) => {
      expect({
        catalogue: isTenantCapability(capability),
        webReads: stringLiterals(reader, readRepoFile(reader)).has(capability),
        backendReads: readers.get(capability) ?? [],
      }).toEqual({ catalogue: true, webReads: true, backendReads: [] });
    });
  });
});
