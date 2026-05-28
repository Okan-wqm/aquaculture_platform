import { of } from 'rxjs';
import { DataSource, Repository } from 'typeorm';

import {
  createMockDataSource,
  createMockNatsClient,
  createMockQueryRunner,
  fakeUuid,
  MockNatsClient,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { KnowledgeEntry } from '../../entities/knowledge-entry.entity';
import {
  DomainEntityType,
  MessageEntityReference,
} from '../../entities/message-entity-reference.entity';
import { AiPrivacyService } from '../ai-privacy.service';
import { KnowledgeExtractionService } from '../knowledge-extraction.service';

describe('KnowledgeExtractionService', () => {
  let service: KnowledgeExtractionService;
  let queryRunner: MockQueryRunner;
  let dataSource: ReturnType<typeof createMockDataSource> & { query: jest.Mock };
  let natsClient: MockNatsClient;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantSchema = 'tenant_aaaaaaaaaaaa4aaa';

  beforeEach(() => {
    queryRunner = createMockQueryRunner();
    dataSource = createMockDataSource(queryRunner) as ReturnType<
      typeof createMockDataSource
    > & { query: jest.Mock };
    dataSource.query = jest.fn().mockResolvedValue([{ schema_name: tenantSchema }]);

    natsClient = createMockNatsClient();
    natsClient.send.mockReturnValue(
      of([{ id: fakeUuid('tnk'), code: 'A1', name: 'Tank A1' }]),
    );

    queryRunner.manager.findOne.mockResolvedValue(null);
    queryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT DISTINCT m."tenantId"')) {
        return Promise.resolve([{ tenantId }]);
      }
      if (sql.includes('SELECT m."id", m."tenantId"')) {
        return Promise.resolve([
          {
            id: fakeUuid('msg'),
            tenantId,
            channelId: fakeUuid('ch'),
            senderId: fakeUuid('usr'),
            content: 'Tank A1 was fed this morning',
            createdAt: new Date('2026-03-10T12:00:00Z'),
          },
        ]);
      }
      return Promise.resolve([]);
    });

    service = new KnowledgeExtractionService(
      {} as Repository<MessageEntityReference>,
      {} as Repository<KnowledgeEntry>,
      dataSource as unknown as DataSource,
      natsClient as never,
      { canAnalyzeMessage: jest.fn().mockResolvedValue(true) } as unknown as AiPrivacyService,
    );
  });

  it('pins tenant schema and persists tenantId on extracted references and knowledge entries', async () => {
    await service.processHourlyBatch();

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"${tenantSchema}", "messaging", public`],
    );
    expect(natsClient.send).toHaveBeenCalledWith(
      'request.farm.getTankRegistry',
      { tenantId, tenantSchema },
    );

    expect(queryRunner.manager.findOne).toHaveBeenCalledWith(
      MessageEntityReference,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          entityType: DomainEntityType.TANK,
        }),
      }),
    );
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      MessageEntityReference,
      expect.objectContaining({ tenantId, entityType: DomainEntityType.TANK }),
    );
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      KnowledgeEntry,
      expect.objectContaining({ tenantId }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });
});
