import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ScadaPackage, ScadaPackageStatus } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { ScadaPackageService } from '../scada-package.service';
import { hashPin, isPinHash, verifyPin } from '../pin-hash.util';

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

function docWithWidgetPin(): Record<string, unknown> {
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
            config: { tagRef: 'EDGE-01/pump.cmd', requirePin: true, pin: '4321' },
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScadaPackageService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getRepositoryToken(ScadaPackage), useValue: repo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    service = module.get(ScadaPackageService);
  });

  describe('pin-hash util', () => {
    it('hashes and verifies; wrong pin fails; format is marked', () => {
      const stored = hashPin('4321');
      expect(isPinHash(stored)).toBe(true);
      expect(stored).not.toContain('4321');
      expect(verifyPin('4321', stored)).toBe(true);
      expect(verifyPin('0000', stored)).toBe(false);
      expect(isPinHash('4321')).toBe(false);
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
      expect(verifyPin('4321', cp.pinHash)).toBe(true);
      expect(cp.securityLevels.pin).toContain('w1');
    });

    it('preserves the stored hash when a redacted doc roundtrips through update', async () => {
      const storedHash = hashPin('4321');
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
            controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: '9999', emergencyStop: null },
          },
        },
        TENANT,
        'user-1',
      );
      const cp = saved.packageData.controlPermissions as { pinHash: string };
      expect(isPinHash(cp.pinHash)).toBe(true);
      expect(verifyPin('9999', cp.pinHash)).toBe(true);
    });
  });

  describe('read-path redaction', () => {
    it('getScadaPackage strips widget plaintext pins and redacts the hash', async () => {
      repo.findOne.mockResolvedValue({
        id: 'pkg-1',
        tenantId: TENANT,
        packageData: {
          ...docWithWidgetPin(),
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: hashPin('4321'), emergencyStop: null },
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
          controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: hashPin('4321'), emergencyStop: null },
        },
      });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '4321')).resolves.toBe(true);
      await expect(service.verifyPackagePin('pkg-1', TENANT, '0000')).resolves.toBe(false);
    });

    it('falls back to legacy widget plaintext pins on pre-hardening rows', async () => {
      repo.findOne.mockResolvedValue({ id: 'pkg-1', tenantId: TENANT, packageData: docWithWidgetPin() });
      await expect(service.verifyPackagePin('pkg-1', TENANT, '4321')).resolves.toBe(true);
      await expect(service.verifyPackagePin('pkg-1', TENANT, '9999')).resolves.toBe(false);
    });

    it('fails closed for an unknown package', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.verifyPackagePin('nope', TENANT, '4321')).resolves.toBe(false);
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
