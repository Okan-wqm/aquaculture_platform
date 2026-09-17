import { ScadaPackageStatus } from '../../entities/scada-package.entity';
import { ScadaPackageService } from '../scada-package.service';
import { hashPin, isPinHash, verifyPin } from '../pin-hash.util';

import { createScadaPackageHarness } from './scada-package-harness';

/**
 * SENSOR-CRITICAL-006 — server-side control-security PIN.
 *
 * PINs guarding physical actuation were stored PLAINTEXT in packageData
 * (readable by any tenant member) and compared in the browser. The server now
 * owns the secret: save-boundary hardening (plaintext → salted scrypt hash,
 * stripped from widget config), read-path redaction, server-side
 * verification, and a tenant-wide pin-protected tag set for gateway
 * enforcement.
 */

const TENANT = 'tenant-uuid-1';

function docWithWidgetPin(pin = '904321'): Record<string, unknown> {
  return {
    meta: { schemaVersion: 2, packageName: 'P' },
    screens: [
      {
        id: 's1',
        name: 'Main',
        isDefault: true,
        widgets: [
          {
            id: 'w1',
            widgetType: 'input',
            position: { col: 0, row: 0, w: 2, h: 1 },
            config: { tagRef: 'EDGE-01/pump.cmd', requirePin: true, pin },
          },
        ],
      },
    ],
  };
}

describe('PIN control security (SENSOR-CRITICAL-006)', () => {
  let service: ScadaPackageService;
  let repo: { findOne: jest.Mock; find: jest.Mock; create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((e) => e),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    ({ service } = await createScadaPackageHarness({ scadaPackageRepository: repo }));
  });

  describe('pin-hash util', () => {
    it('hashes and verifies; wrong pin fails; format is marked', () => {
      const stored = hashPin('904321');
      expect(isPinHash(stored)).toBe(true);
      expect(stored).not.toContain('904321');
      expect(verifyPin('904321', stored)).toBe(true);
      expect(verifyPin('000000', stored)).toBe(false);
      expect(isPinHash('904321')).toBe(false);
    });
  });

  describe('save-boundary hardening', () => {
    it('strips widget plaintext pins into a package-level hash on create', async () => {
      const saved = await service.createScadaPackage(
        { name: 'P', packageData: docWithWidgetPin() },
        TENANT,
        'user-1',
      );

      const screens = saved.packageData.screens as Array<{ widgets: Array<{ id: string; config: Record<string, unknown> }> }>;
      const cfg = screens[0]!.widgets[0]!.config;
      expect(cfg.pin).toBeUndefined(); // plaintext never persists
      expect(cfg.requirePin).toBe(true);

      const cp = saved.packageData.controlPermissions as {
        pinHash: string;
        securityLevels: { pin: string[] };
      };
      expect(isPinHash(cp.pinHash)).toBe(true);
      expect(verifyPin('904321', cp.pinHash)).toBe(true);
      expect(cp.securityLevels.pin).toContain('w1');
    });

    it('preserves the stored hash when a redacted doc roundtrips through update', async () => {
      const storedHash = hashPin('904321');
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        name: 'P',
        status: ScadaPackageStatus.DRAFT,
        version: 1,
        packageData: {
          meta: { schemaVersion: 2 },
          screens: [],
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: ['w1'] }, pinHash: storedHash, emergencyStop: null },
        },
      });

      // The client saves back what it READ — pinHash redacted to the marker.
      const incoming = {
        meta: { schemaVersion: 2, packageName: 'P' },
        screens: [],
        controlPermissions: {
          securityLevels: { none: [], confirm: [], pin: ['w1'] },
          pinHash: '[REDACTED]',
          emergencyStop: null,
        },
      };
      const saved = await service.updateScadaPackage('pkg-1', { packageData: incoming }, TENANT, 'user-1');

      const cp = saved.packageData.controlPermissions as { pinHash: string };
      expect(cp.pinHash).toBe(storedHash); // marker never hashed, hash never lost
    });

    it('hashes a raw PIN the builder wrote into the pinHash field', async () => {
      const saved = await service.createScadaPackage(
        {
          name: 'P',
          packageData: {
            meta: { schemaVersion: 2, packageName: 'P' },
            screens: [],
            controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: '731902', emergencyStop: null },
          },
        },
        TENANT,
        'user-1',
      );
      const cp = saved.packageData.controlPermissions as { pinHash: string };
      expect(isPinHash(cp.pinHash)).toBe(true);
      expect(verifyPin('731902', cp.pinHash)).toBe(true);
    });
  });

  describe('read-path redaction', () => {
    it('getScadaPackage strips widget plaintext pins and redacts the hash', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        packageData: {
          ...docWithWidgetPin(),
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: hashPin('904321'), emergencyStop: null },
        },
      });

      const pkg = await service.getScadaPackage('pkg-1', TENANT);
      const screens = pkg!.packageData.screens as Array<{ widgets: Array<{ config: Record<string, unknown> }> }>;
      const cfg = screens[0]!.widgets[0]!.config;
      expect(cfg.pin).toBeUndefined();
      expect(cfg.requirePin).toBe(true);
      const cp = pkg!.packageData.controlPermissions as { pinHash: string };
      expect(cp.pinHash).toBe('[REDACTED]');
    });
  });

  describe('verifyPackagePin', () => {
    it('verifies against the stored hash', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        packageData: {
          screens: [],
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: hashPin('904321'), emergencyStop: null },
        },
      });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '904321')).resolves.toBe(true);
      await expect(service.verifyPackagePin('pkg-1', TENANT, '000000')).resolves.toBe(false);
    });

    it('falls back to legacy widget plaintext pins on pre-hardening rows', async () => {
      repo.findOne.mockResolvedValue({ id: 'pkg-1', tenantId: TENANT, packageData: docWithWidgetPin() });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '904321')).resolves.toBe(true);
      await expect(service.verifyPackagePin('pkg-1', TENANT, '000000')).resolves.toBe(false);
    });

    it('fails closed for an unknown package', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.verifyPackagePin('nope', TENANT, '904321')).resolves.toBe(false);
    });
  });

  describe('PIN policy at the set/hash boundary (M3)', () => {
    it('rejects a PIN shorter than 6 characters', async () => {
      await expect(
        service.createScadaPackage({ name: 'P', packageData: docWithWidgetPin('1234') }, TENANT, 'user-1'),
      ).rejects.toThrow(/at least 6/);
    });

    it('rejects repeated-only digits', async () => {
      await expect(
        service.createScadaPackage({ name: 'P', packageData: docWithWidgetPin('444444') }, TENANT, 'user-1'),
      ).rejects.toThrow(/too weak/);
    });

    it('rejects sequential-only digits (ascending and descending)', async () => {
      await expect(
        service.createScadaPackage({ name: 'P', packageData: docWithWidgetPin('234567') }, TENANT, 'user-1'),
      ).rejects.toThrow(/too weak/);
      await expect(
        service.createScadaPackage({ name: 'P', packageData: docWithWidgetPin('987654') }, TENANT, 'user-1'),
      ).rejects.toThrow(/too weak/);
    });

    it('rejects a weak raw PIN written into the pinHash field', async () => {
      await expect(
        service.createScadaPackage(
          {
            name: 'P',
            packageData: {
              meta: { schemaVersion: 2, packageName: 'P' },
              screens: [],
              controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: '123456', emergencyStop: null },
            },
          },
          TENANT,
          'user-1',
        ),
      ).rejects.toThrow(/too weak/);
    });

    it('accepts a 6+ character non-trivial PIN', async () => {
      const saved = await service.createScadaPackage(
        { name: 'P', packageData: docWithWidgetPin('904321') },
        TENANT,
        'user-1',
      );
      const cp = saved.packageData.controlPermissions as { pinHash: string };
      expect(verifyPin('904321', cp.pinHash)).toBe(true);
    });
  });

  describe('legacy plaintext migration on verify (M3)', () => {
    it('a successful legacy verify re-hashes the pin in place and strips widget plaintext', async () => {
      repo.findOne.mockResolvedValue({ id: 'pkg-1', tenantId: TENANT, packageData: docWithWidgetPin() });

      await expect(service.verifyPackagePin('pkg-1', TENANT, '904321')).resolves.toBe(true);

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0] as ScadaPackage;
      const cp = saved.packageData.controlPermissions as { pinHash: string };
      expect(isPinHash(cp.pinHash)).toBe(true);
      const screens = saved.packageData.screens as Array<{ widgets: Array<{ config: Record<string, unknown> }> }>;
      expect(screens[0]!.widgets[0]!.config.pin).toBeUndefined();
      expect(screens[0]!.widgets[0]!.config.requirePin).toBe(true);
    });

    it('a legacy plaintext pinHash verifies in constant time and migrates', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        packageData: {
          meta: { schemaVersion: 2 },
          screens: [],
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: '904321', emergencyStop: null },
        },
      });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '904321')).resolves.toBe(true);
      const saved = repo.save.mock.calls[0][0] as ScadaPackage;
      expect(isPinHash((saved.packageData.controlPermissions as { pinHash: string }).pinHash)).toBe(true);
    });

    it('a wrong legacy pin never migrates', async () => {
      repo.findOne.mockResolvedValue({ id: 'pkg-1', tenantId: TENANT, packageData: docWithWidgetPin() });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '000000')).resolves.toBe(false);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('getPinProtectedTagKeys', () => {
    it('collects tag keys from pin-protected widgets, skipping archived packages', async () => {
      repo.find.mockResolvedValue([
        { status: ScadaPackageStatus.DRAFT, packageData: docWithWidgetPin() },
        {
          status: ScadaPackageStatus.PUBLISHED,
          packageData: {
            screens: [{ widgets: [
              { id: 'w2', config: { tagRef: 'EDGE-01/valve.cmd' } }, // unprotected
              { id: 'w3', config: { tagRef: 'EDGE-01/estop.cmd', requirePin: true } },
            ] }],
            controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: null, emergencyStop: null },
          },
        },
        {
          status: ScadaPackageStatus.ARCHIVED,
          packageData: {
            screens: [{ widgets: [{ id: 'w4', config: { tagRef: 'EDGE-01/archived.cmd', requirePin: true } }] }],
          },
        },
      ]);

      const keys = await service.getPinProtectedTagKeys(TENANT);
      expect(keys.has('EDGE-01/pump.cmd')).toBe(true);
      expect(keys.has('EDGE-01/estop.cmd')).toBe(true);
      expect(keys.has('EDGE-01/valve.cmd')).toBe(false);
      expect(keys.has('EDGE-01/archived.cmd')).toBe(false);
    });
  });
});
