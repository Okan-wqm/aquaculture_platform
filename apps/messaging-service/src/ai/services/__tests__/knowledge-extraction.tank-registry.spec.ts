import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';

import { AiPrivacyService } from '../ai-privacy.service';
import { KnowledgeEntry } from '../../entities/knowledge-entry.entity';
import { KnowledgeExtractionService } from '../knowledge-extraction.service';
import { MessageEntityReference } from '../../entities/message-entity-reference.entity';

/**
 * ORPHAN-MEDIUM-336 — the knowledge-extraction sweep must call the farm
 * getTankRegistry responder with the CANONICAL tenant UUID (recovered from the
 * tenant's own message rows), not the lossy tenant_<16hex> schema name the
 * responder rejects as a non-UUID. This pins the request payload shape.
 */
describe('KnowledgeExtractionService — tank-registry request payload (ORPHAN-MEDIUM-336)', () => {
  const TENANT_ID = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
  const TENANT_SCHEMA = 'tenant_7f6b08ab90e246d3';

  const send = jest.fn().mockReturnValue(of([]));

  // A minimal QueryRunner double covering exactly the calls the sweep makes for
  // one tenant schema with a single message and an empty tank registry.
  const makeQueryRunner = (): Record<string, unknown> => ({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: false,
    manager: {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    },
    query: jest.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM "messages"')) {
        // The message carries the authoritative tenantId (Message.tenantId).
        return Promise.resolve([
          {
            id: 'msg-1',
            channelId: 'chan-1',
            senderId: 'user-1',
            content: 'routine status update',
            createdAt: new Date(),
            tenantId: TENANT_ID,
          },
        ]);
      }
      // search_path pin + any other statement.
      return Promise.resolve([]);
    }),
  });

  const dataSource = {
    // listTenantSchemas()
    query: jest.fn().mockResolvedValue([{ schema_name: TENANT_SCHEMA }]),
    createQueryRunner: jest.fn(() => makeQueryRunner()),
  };

  let service: KnowledgeExtractionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    send.mockReturnValue(of([]));
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeExtractionService,
        { provide: getRepositoryToken(MessageEntityReference), useValue: {} },
        { provide: getRepositoryToken(KnowledgeEntry), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: 'NATS_SERVICE', useValue: { send } },
        { provide: AiPrivacyService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeExtractionService);
  });

  it('requests the tank registry with the canonical {tenantId}, not the schema name', async () => {
    await service.processHourlyBatch();

    expect(send).toHaveBeenCalledWith('request.farm.getTankRegistry', {
      tenantId: TENANT_ID,
    });
    // Regression guard: it must NOT send the lossy schema name (the old bug).
    expect(send).not.toHaveBeenCalledWith('request.farm.getTankRegistry', {
      tenantSchema: TENANT_SCHEMA,
    });
  });
});
