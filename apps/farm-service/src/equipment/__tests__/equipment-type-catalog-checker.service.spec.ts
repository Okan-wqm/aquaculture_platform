/**
 * EquipmentTypeCatalogCheckerService — Unit Tests
 *
 * Phase 7.5 final onboarding hook. The service never writes; its
 * contract is a read-only sanity check that logs a WARN when the
 * global equipment-types catalogue is empty (migration didn't run).
 *
 * The tests pin:
 *   1. Non-empty catalogue → returns skipped (no-op, but logs info).
 *   2. Empty catalogue → logs WARN and returns empty seeded/skipped.
 *   3. The `tenantId` argument is accepted but never used to shape
 *      the query — the catalogue is global. This pins the interface
 *      without coupling to internals.
 */
import type { Repository } from 'typeorm';

import { EquipmentTypeCatalogCheckerService } from '../services/equipment-type-catalog-checker.service';
import { EquipmentType } from '../entities/equipment-type.entity';

function makeRepo(activeCount: number): {
  repo: Repository<EquipmentType>;
  countMock: jest.Mock;
} {
  const countMock = jest.fn().mockResolvedValue(activeCount);
  const repo = {
    count: countMock,
  } as unknown as Repository<EquipmentType>;
  return { repo, countMock };
}

describe('EquipmentTypeCatalogCheckerService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  it('returns skipped=["equipment-types-global"] when the catalogue is populated', async () => {
    const { repo, countMock } = makeRepo(42);
    const service = new EquipmentTypeCatalogCheckerService(repo);

    const result = await service.seedDefaults(TENANT);

    expect(countMock).toHaveBeenCalledWith({ where: { isActive: true } });
    expect(result).toEqual({
      seeded: [],
      skipped: ['equipment-types-global'],
    });
  });

  it('logs WARN and returns fully-empty summary when the catalogue is empty', async () => {
    const { repo } = makeRepo(0);
    const service = new EquipmentTypeCatalogCheckerService(repo);
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const result = await service.seedDefaults(TENANT);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The warn message should mention the migration path so the
    // operator has a direct next-step instead of a vague alert.
    expect(warnSpy.mock.calls[0]![0]).toContain('007_seed_equipment_types');
    expect(result).toEqual({ seeded: [], skipped: [] });
  });

  it('never writes — the count query is the only repo interaction', async () => {
    const { repo, countMock } = makeRepo(5);
    const service = new EquipmentTypeCatalogCheckerService(repo);

    await service.seedDefaults(TENANT);

    // No save / create / update / delete should ever be called —
    // the global catalogue is migration-owned.
    expect(countMock).toHaveBeenCalledTimes(1);
    const repoAsAny = repo as unknown as Record<string, unknown>;
    expect(repoAsAny['save']).toBeUndefined();
    expect(repoAsAny['create']).toBeUndefined();
    expect(repoAsAny['update']).toBeUndefined();
    expect(repoAsAny['delete']).toBeUndefined();
  });
});
