import type { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ScadaPackage } from '../../entities/scada-package.entity';
import { Process } from '../../entities/process.entity';
import { EdgeDeviceService } from '../../../edge-device/edge-device.service';
import { ScadaPackageService } from '../scada-package.service';
import { createScadaPackageTestingModule } from './scada-package-service.testing';

/**
 * 6d — V2 `packageData` backfill.
 *
 * `backfillPackageDocsToV2` rewrites legacy (pre-Faz2, schemaVersion ≠ 2) rows
 * to the canonical ScadaPackageDocV2 using the SAME upcaster + deviceCode
 * resolution the save/read boundaries use, so the read-path upcast eventually
 * becomes a no-op. These pin the properties an ops-run depends on: idempotency,
 * dry-run safety, deviceCode-driven tagRef promotion, and that a malformed row
 * is left untouched (never partially written) without aborting the batch, and
 * that a row edited concurrently (its `version` moved) is NOT clobbered — the
 * write is a conditional UPDATE guarded on the version we read.
 */

const TENANT = 'tenant-uuid-1';

/** A representative legacy (V1) document as the pre-Faz2 serializer wrote it. */
function legacyV1Doc(): Record<string, unknown> {
  return {
    meta: {
      version: 1,
      packageName: 'RAS Ana Ekran',
      processId: 'proc-1',
      edgeDeviceId: 'device-uuid-1',
    },
    screens: [
      {
        id: 'scr-1',
        name: 'Main',
        isDefault: true,
        widgets: [
          {
            id: 'w1',
            widgetType: 'gauge',
            position: { col: 0, row: 0, w: 4, h: 3 },
            config: { tagName: 'tank1.do' },
          },
          {
            id: 'w2',
            widgetType: 'numeric',
            position: { col: 4, row: 0, w: 2, h: 2 },
            config: { tagId: 'tank1.temp' },
          },
        ],
      },
    ],
    alarmRules: [],
    controlPermissions: {
      securityLevels: { none: [], confirm: [], pin: [] },
      pinHash: null,
      emergencyStop: null,
    },
    trendConfig: { retentionDays: 7, sampleIntervalSec: 60, tags: [] },
  };
}

/** An already-migrated (V2) document — the backfill must leave it alone. */
function v2Doc(): Record<string, unknown> {
  const doc = legacyV1Doc();
  (doc.meta as Record<string, unknown>).schemaVersion = 2;
  return doc;
}

/** A malformed legacy row: a widget missing the required `position`. */
function malformedDoc(): Record<string, unknown> {
  return {
    meta: { version: 1 },
    screens: [{ id: 's', widgets: [{ id: 'bad', widgetType: 'gauge', config: {} }] }],
  };
}

// The backfill only reads id/packageData and writes packageData/updatedBy, so a
// partial row is the honest fixture — the repo mock returns `any`, so no cast
// is needed to hand these to the service.
function pkgRow(id: string, packageData: Record<string, unknown>): Partial<ScadaPackage> {
  return { id, tenantId: TENANT, version: 3, packageData };
}

describe('ScadaPackageService — 6d V2 packageData backfill', () => {
  let service: ScadaPackageService;
  let repo: { find: jest.Mock; manager: { transaction: jest.Mock } };
  // The row read + write happen through the transaction's EntityManager under
  // a pessimistic_write lock, so the mock manager stands in for that.
  let manager: { findOne: jest.Mock; save: jest.Mock };
  let edgeDeviceService: { findByIdOrFail: jest.Mock };

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };
    repo = {
      find: jest.fn(),
      manager: {
        transaction: jest
          .fn()
          .mockImplementation((cb: (m: typeof manager) => unknown) => cb(manager)),
      },
    };
    edgeDeviceService = {
      findByIdOrFail: jest
        .fn()
        .mockResolvedValue({ id: 'device-uuid-1', deviceCode: 'EDGE-AABB1122' }),
    };

    const module: TestingModule = await createScadaPackageTestingModule([
      { provide: getRepositoryToken(ScadaPackage), useValue: repo },
      { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      { provide: EdgeDeviceService, useValue: edgeDeviceService },
    ]);

    service = module.get(ScadaPackageService);
  });

  /** Enumeration returns id-only rows; the locked re-read returns the row. */
  function idRow(id: string): Partial<ScadaPackage> {
    return { id };
  }

  it('migrates legacy rows and skips ones already at V2', async () => {
    repo.find.mockResolvedValue([idRow('legacy-1'), idRow('already-v2')]);
    manager.findOne
      .mockResolvedValueOnce(pkgRow('legacy-1', legacyV1Doc()))
      .mockResolvedValueOnce(pkgRow('already-v2', v2Doc()));

    const result = await service.backfillPackageDocsToV2(TENANT);

    expect(result).toMatchObject({ scanned: 2, migrated: 1, skipped: 1, failed: 0, dryRun: false });
    // The re-read is done under a pessimistic_write lock (not the stale
    // enumeration snapshot) — that is what closes the lost-update window.
    expect(manager.findOne).toHaveBeenCalledWith(ScadaPackage, {
      where: { id: 'legacy-1', tenantId: TENANT },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.save).toHaveBeenCalledTimes(1);
    const saved = manager.save.mock.calls[0][0] as ScadaPackage;
    expect(saved.id).toBe('legacy-1');
    expect((saved.packageData.meta as Record<string, unknown>).schemaVersion).toBe(2);
    expect(saved.updatedBy).toBe('system-backfill');
  });

  it('promotes legacy tagName/tagId to full tagRefs via the resolved deviceCode', async () => {
    repo.find.mockResolvedValue([idRow('legacy-1')]);
    manager.findOne.mockResolvedValue(pkgRow('legacy-1', legacyV1Doc()));

    await service.backfillPackageDocsToV2(TENANT);

    const saved = manager.save.mock.calls[0][0] as ScadaPackage;
    const screens = saved.packageData.screens as Array<{
      widgets: Array<{ config: Record<string, unknown> }>;
    }>;
    const widgets = screens[0]?.widgets ?? [];
    expect(widgets[0]?.config.tagRef).toBe('EDGE-AABB1122/tank1.do');
    expect(widgets[1]?.config.tagRef).toBe('EDGE-AABB1122/tank1.temp');
  });

  it('is idempotent: a re-run over all-V2 rows migrates nothing', async () => {
    repo.find.mockResolvedValue([idRow('a'), idRow('b')]);
    manager.findOne
      .mockResolvedValueOnce(pkgRow('a', v2Doc()))
      .mockResolvedValueOnce(pkgRow('b', v2Doc()));

    const result = await service.backfillPackageDocsToV2(TENANT);

    expect(result).toMatchObject({ scanned: 2, migrated: 0, skipped: 2, failed: 0 });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('dryRun previews the migration count without writing any row', async () => {
    repo.find.mockResolvedValue([idRow('legacy-1')]);
    manager.findOne.mockResolvedValue(pkgRow('legacy-1', legacyV1Doc()));

    const result = await service.backfillPackageDocsToV2(TENANT, { dryRun: true });

    expect(result).toMatchObject({ scanned: 1, migrated: 1, skipped: 0, failed: 0, dryRun: true });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('leaves a malformed row untouched and continues the batch', async () => {
    repo.find.mockResolvedValue([idRow('bad'), idRow('legacy-1')]);
    manager.findOne
      .mockResolvedValueOnce(pkgRow('bad', malformedDoc()))
      .mockResolvedValueOnce(pkgRow('legacy-1', legacyV1Doc()));

    const result = await service.backfillPackageDocsToV2(TENANT);

    expect(result).toMatchObject({ scanned: 2, migrated: 1, skipped: 0, failed: 1 });
    // Only the good row was written; the malformed one was never saved.
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect((manager.save.mock.calls[0][0] as ScadaPackage).id).toBe('legacy-1');
  });

  it('reads the row under lock so a concurrent edit is never clobbered', async () => {
    // Enumeration saw an old (V1) snapshot, but a user migrated/edited the row
    // to V2 before we acquired the lock — the locked re-read returns V2, so we
    // skip and never overwrite the newer data.
    repo.find.mockResolvedValue([idRow('legacy-1')]);
    manager.findOne.mockResolvedValue(pkgRow('legacy-1', v2Doc()));

    const result = await service.backfillPackageDocsToV2(TENANT);

    expect(result).toMatchObject({ scanned: 1, migrated: 0, skipped: 1, failed: 0 });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('counts a row deleted between enumeration and lock as skipped', async () => {
    repo.find.mockResolvedValue([idRow('gone')]);
    manager.findOne.mockResolvedValue(null);

    const result = await service.backfillPackageDocsToV2(TENANT);

    expect(result).toMatchObject({ scanned: 1, migrated: 0, skipped: 1, failed: 0 });
    expect(manager.save).not.toHaveBeenCalled();
  });
});
