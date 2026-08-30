import { BadRequestException } from '@nestjs/common';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';

import type { AuditLogService } from '../../database/services/audit-log.service';
import { CreateSiteCommand } from '../commands/create-site.command';
import { UpdateSiteCommand } from '../commands/update-site.command';
import { CreateSiteInput } from '../dto/create-site.input';
import { UpdateSiteInput } from '../dto/update-site.input';
import { Site, SiteStatus, SiteType } from '../entities/site.entity';
import { CreateSiteHandler } from '../handlers/create-site.handler';
import { UpdateSiteHandler } from '../handlers/update-site.handler';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

function collaborators() {
  return {
    audit: mock<AuditLogService>({
      logWithManager: jest.fn().mockResolvedValue({}),
    }),
    outbox: mock<OutboxPublisher>({
      enqueue: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

function existingSite(): Site {
  return Object.assign(new Site(), {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId: TENANT_ID,
    name: 'Existing',
    code: 'EX-01',
    type: SiteType.SEA_CAGE,
    status: SiteStatus.ACTIVE,
    isActive: true,
    isDeleted: false,
    location: { latitude: 60, longitude: 5 },
    monitoringRadiusM: 2_000,
    monitoringArea: null,
    monitoringLocationRevision: 3,
    timezone: 'Europe/Oslo',
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('site contract command handlers', () => {
  it('creates SEA_CAGE with the complete public contract and canonical defaults', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const repository = createMockRepository<Site>();
    repository.create.mockImplementation((site) => Object.assign(new Site(), site));
    repository.findOne.mockResolvedValue(null);
    repository.save.mockImplementation(async (site) =>
      Object.assign(new Site(), site, {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        version: 1,
      }),
    );
    mockManager.getRepository.mockReturnValue(repository);
    const { audit, outbox } = collaborators();
    const handler = new CreateSiteHandler(mockDataSource, audit, outbox);
    const input: CreateSiteInput = {
      name: 'North Cage',
      code: 'nc-01',
      type: SiteType.SEA_CAGE,
      location: { latitude: 60, longitude: 5 },
      region: 'Vestland',
      siteManager: 'Operations Team',
      totalArea: 12_500,
      lokalitetsnummer: 12_345,
      organisationNumberOverride: '999999999',
    };

    const result = await handler.execute(new CreateSiteCommand(input, TENANT_ID, USER_ID));

    expect(result).toEqual(
      expect.objectContaining({
        type: SiteType.SEA_CAGE,
        location: input.location,
        monitoringRadiusM: 2_000,
        monitoringArea: null,
        monitoringLocationRevision: 1,
        region: 'Vestland',
        siteManager: 'Operations Team',
        areaM2: 12_500,
        lokalitetsnummer: 12_345,
        organisationNumberOverride: '999999999',
      }),
    );
    expect(result.totalArea).toBe(12_500);
  });

  it('rejects SEA_CAGE without coordinates before opening a transaction', async () => {
    const { mockDataSource } = createMockDataSource();
    const { audit, outbox } = collaborators();
    const handler = new CreateSiteHandler(mockDataSource, audit, outbox);

    await expect(
      handler.execute(
        new CreateSiteCommand(
          {
            name: 'Missing Coordinates',
            code: 'MC-01',
            type: SiteType.SEA_CAGE,
          },
          TENANT_ID,
          USER_ID,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('round-trips drifted fields and increments revision only for monitoring changes', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const repository = createMockRepository<Site>();
    repository.create.mockImplementation((site) => Object.assign(new Site(), site));
    const site = existingSite();
    repository.findOne.mockResolvedValue(site);
    repository.save.mockImplementation(async (entity) => entity as Site);
    mockManager.getRepository.mockReturnValue(repository);
    const { audit, outbox } = collaborators();
    const handler = new UpdateSiteHandler(mockDataSource, audit, outbox);
    const input: UpdateSiteInput = {
      id: site.id,
      region: 'Trøndelag',
      siteManager: 'Marine Team',
      totalArea: 15_000,
      lokalitetsnummer: 54_321,
      organisationNumberOverride: '888888888',
    };

    const nonMonitoringResult = await handler.execute(
      new UpdateSiteCommand(site.id, input, TENANT_ID, USER_ID),
    );
    expect(nonMonitoringResult.monitoringLocationRevision).toBe(3);
    expect(nonMonitoringResult.totalArea).toBe(15_000);
    expect(nonMonitoringResult).toEqual(
      expect.objectContaining({
        region: 'Trøndelag',
        siteManager: 'Marine Team',
        lokalitetsnummer: 54_321,
        organisationNumberOverride: '888888888',
      }),
    );

    const monitoringResult = await handler.execute(
      new UpdateSiteCommand(
        site.id,
        {
          id: site.id,
          monitoringRadiusM: 3_000,
        },
        TENANT_ID,
        USER_ID,
      ),
    );
    expect(monitoringResult.monitoringLocationRevision).toBe(4);
  });
});
