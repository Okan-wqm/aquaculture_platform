import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { NatsRequestReply } from '@platform/event-bus';
import { FARM_SITE_ACCESS_QUERY_SUBJECTS } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import {
  FarmSiteAuthorityUnavailableError,
  ValidateSiteAssignmentResponder,
} from './validate-site-assignment.responder';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

describe('ValidateSiteAssignmentResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({
    subject: FARM_SITE_ACCESS_QUERY_SUBJECTS.VALIDATE_ASSIGNMENT,
    drain,
  });
  let responder: ValidateSiteAssignmentResponder;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { mockDataSource } = createMockDataSource();
    const module = await Test.createTestingModule({
      providers: [
        ValidateSiteAssignmentResponder,
        { provide: DataSource, useValue: mockDataSource },
        { provide: NatsRequestReply, useValue: { respond } },
      ],
    }).compile();
    responder = module.get(ValidateSiteAssignmentResponder);
  });

  it('registers and drains the exact shared request subject', async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      FARM_SITE_ACCESS_QUERY_SUBJECTS.VALIDATE_ASSIGNMENT,
      expect.any(Function),
      { queue: 'farm-service' },
    );

    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed identifiers without touching the tenant authority', async () => {
    await expect(
      responder.validateSiteAssignment({ tenantId: 'bad', siteId: SITE_ID }),
    ).resolves.toEqual({ assignable: false });
    await expect(
      responder.validateSiteAssignment({ tenantId: TENANT_ID, siteId: 'bad' }),
    ).resolves.toEqual({ assignable: false });
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('accepts only a live site found inside the requested tenant boundary', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: SITE_ID });
    mockRunInTenantRead.mockImplementation(
      async (
        _dataSource: unknown,
        schema: string,
        tenantId: string,
        read: (queryRunner: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT_ID);
        return read({ manager: { findOne } });
      },
    );

    await expect(
      responder.validateSiteAssignment({ tenantId: TENANT_ID, siteId: SITE_ID }),
    ).resolves.toEqual({ assignable: true });
    expect(findOne).toHaveBeenCalledWith(expect.any(Function), {
      select: { id: true },
      where: {
        id: SITE_ID,
        tenantId: TENANT_ID,
        isActive: true,
        isDeleted: false,
      },
    });
  });

  it('returns the same denial for absent, foreign, inactive, or deleted sites', async () => {
    mockRunInTenantRead.mockImplementation(
      async (
        _dataSource: unknown,
        _schema: string,
        _tenantId: string,
        read: (queryRunner: unknown) => Promise<unknown>,
      ) => read({ manager: { findOne: jest.fn().mockResolvedValue(null) } }),
    );

    await expect(
      responder.validateSiteAssignment({ tenantId: TENANT_ID, siteId: SITE_ID }),
    ).resolves.toEqual({ assignable: false });
  });

  it('surfaces an authority outage as a typed remote failure', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('database unavailable'));

    await expect(
      responder.validateSiteAssignment({ tenantId: TENANT_ID, siteId: SITE_ID }),
    ).rejects.toBeInstanceOf(FarmSiteAuthorityUnavailableError);
  });
});
