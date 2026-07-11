/**
 * SlaughterFacilityService — at most one default per tenant (first facility
 * becomes default automatically), duplicate approval numbers are conflicts,
 * and the assembler's default read is active-only.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

const runInTenantTransaction = jest.fn();
const runInTenantRead = jest.fn();
const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  runInTenantRead: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantRead(ds, schema, tenantId, cb),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { SlaughterFacilityService } from '../services/slaughter-facility.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';

interface FakeRepo {
  findOne: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function setup(options: { duplicate?: object | null; count?: number; existing?: object | null }): {
  service: SlaughterFacilityService;
  repo: FakeRepo;
} {
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: {} as Partial<EntityManager> }),
  );
  const repo: FakeRepo = {
    // create() looks up duplicates first, update() the target row first.
    findOne: jest.fn().mockResolvedValueOnce(options.duplicate ?? options.existing ?? null),
    count: jest.fn().mockResolvedValue(options.count ?? 0),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((values: object) => values),
    save: jest.fn(async (values: object) => ({ id: 'sf-1', ...values })),
  };
  tenantManagerRepo.mockReturnValue(repo);
  return { service: new SlaughterFacilityService({} as Partial<DataSource> as DataSource), repo };
}

describe('SlaughterFacilityService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('makes the FIRST facility the default automatically', async () => {
    const { service, repo } = setup({ count: 0 });

    const saved = await service.create(TENANT, {
      name: 'Slakteriet AS',
      godkjenningsnummer: 'S123',
    });

    expect(saved).toMatchObject({ isDefault: true, isActive: true });
    expect(repo.update).toHaveBeenCalledWith(
      { tenantId: TENANT, isDefault: true },
      { isDefault: false },
    );
  });

  it('a later non-default facility does NOT steal the default', async () => {
    const { service, repo } = setup({ count: 2 });

    const saved = await service.create(TENANT, { name: 'Second', godkjenningsnummer: 'S456' });

    expect(saved).toMatchObject({ isDefault: false });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('creating an explicit default clears the previous one in the same transaction', async () => {
    const { service, repo } = setup({ count: 2 });

    const saved = await service.create(TENANT, {
      name: 'New default',
      godkjenningsnummer: 'S789',
      isDefault: true,
    });

    expect(saved).toMatchObject({ isDefault: true });
    expect(repo.update).toHaveBeenCalledWith(
      { tenantId: TENANT, isDefault: true },
      { isDefault: false },
    );
  });

  it('rejects a duplicate godkjenningsnummer', async () => {
    const { service } = setup({ duplicate: { id: 'sf-existing' } });

    await expect(
      service.create(TENANT, { name: 'Dup', godkjenningsnummer: 'S123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update: unknown facility is a NotFoundException', async () => {
    const { service } = setup({ existing: null });

    await expect(service.update(TENANT, { id: 'missing', name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('update: promoting to default demotes the previous default', async () => {
    const { service, repo } = setup({
      existing: { id: 'sf-2', tenantId: TENANT, isDefault: false, godkjenningsnummer: 'S456' },
    });

    const saved = await service.update(TENANT, { id: 'sf-2', isDefault: true });

    expect(saved).toMatchObject({ isDefault: true });
    expect(repo.update).toHaveBeenCalledWith(
      { tenantId: TENANT, isDefault: true },
      { isDefault: false },
    );
  });

  it('getDefaultFacility reads the active default only', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 'sf-1', godkjenningsnummer: 'S123' });
    runInTenantRead.mockImplementation(
      async (
        _ds,
        _schema,
        _tenant,
        cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
      ) => cb({ manager: { findOne } as Partial<EntityManager> }),
    );
    const service = new SlaughterFacilityService({} as Partial<DataSource> as DataSource);

    const facility = await service.getDefaultFacility(TENANT);

    expect(facility).toMatchObject({ godkjenningsnummer: 'S123' });
    expect(findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId: TENANT, isDefault: true, isActive: true },
    });
  });
});
