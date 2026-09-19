import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';

import { AiPrivacyService } from '../ai-privacy.service';
import { KnowledgeEntry } from '../../entities/knowledge-entry.entity';
import { KnowledgeExtractionService } from '../knowledge-extraction.service';
import { MessageEntityReference } from '../../entities/message-entity-reference.entity';
import { MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV } from '../../ai-trigger.config';
import { ScheduledJobRunner } from '@aquaculture/backend-common/scheduling';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';

/**
 * ORPHAN-MEDIUM-336 — the knowledge-extraction sweep must call the farm
 * getTankRegistry responder with the CANONICAL tenant UUID, not the lossy
 * tenant_<16hex> schema name the responder rejects as a non-UUID. This pins
 * the request payload shape.
 *
 * MSGFIX-FAZ3 3.6: the identity now comes from the schema-mapping LEDGER
 * (`listActiveTenantSchemaIdentities`) BEFORE any tenant read runs — the
 * DataSource mock below answers the platform mapping function call — and the
 * batch additionally binds the RLS tenant GUC per tenant transaction
 * (bindTenantRlsContext). The tank-registry payload assertion is unchanged.
 *
 * The pipeline specs run with the MSGFIX-FAZ0 ceasefire flag OPEN; the
 * default-OFF behaviour has its own describe at the bottom.
 */
describe('KnowledgeExtractionService — tank-registry request payload (ORPHAN-MEDIUM-336)', () => {
  const TENANT_ID = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
  const TENANT_SCHEMA = 'tenant_7f6b08ab90e246d3';
  /** Saved so the suite leaves the process env exactly as it found it. */
  const savedCronEnv = process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];

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
      // search_path pin + RLS GUC bind/read-back + any other statement.
      return Promise.resolve([]);
    }),
  });

  const dataSource = {
    // listActiveTenantSchemaIdentities() — platform ledger mapping rows.
    query: jest.fn().mockResolvedValue([
      {
        schema_name: TENANT_SCHEMA,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
    ]),
    createQueryRunner: jest.fn(() => makeQueryRunner()),
  };

  let service: KnowledgeExtractionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    send.mockReturnValue(of([]));
    // MSGFIX-FAZ0: pipeline behaviour is tested with the gate OPEN.
    process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV] = 'true';
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeExtractionService,
        { provide: getRepositoryToken(MessageEntityReference), useValue: {} },
        { provide: getRepositoryToken(KnowledgeEntry), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: 'NATS_SERVICE', useValue: { send } },
        { provide: AiPrivacyService, useValue: {} },
        { provide: ScheduledJobRunner, useValue: createScheduledJobTestExecutor().executor },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeExtractionService);
  });

  afterEach(() => {
    if (savedCronEnv === undefined) delete process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];
    else process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV] = savedCronEnv;
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

describe('KnowledgeExtractionService — MSGFIX-FAZ0 cron ceasefire (default OFF)', () => {
  const savedCronEnv = process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];
  const send = jest.fn().mockReturnValue(of([]));

  const buildService = async (dataSource: object) => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeExtractionService,
        { provide: getRepositoryToken(MessageEntityReference), useValue: {} },
        { provide: getRepositoryToken(KnowledgeEntry), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: 'NATS_SERVICE', useValue: { send } },
        { provide: AiPrivacyService, useValue: {} },
        { provide: ScheduledJobRunner, useValue: createScheduledJobTestExecutor().executor },
      ],
    }).compile();
    return moduleRef.get(KnowledgeExtractionService);
  };

  afterEach(() => {
    jest.clearAllMocks();
    if (savedCronEnv === undefined) delete process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];
    else process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV] = savedCronEnv;
  });

  it('a tick with the flag unset never touches the database nor NATS', async () => {
    delete process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];
    const dataSource = { query: jest.fn(), createQueryRunner: jest.fn() };
    const service = await buildService(dataSource);

    await service.processHourlyBatch();

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a non-true flag value also keeps the sweep parked (fails closed)', async () => {
    process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV] = 'yes';
    const dataSource = { query: jest.fn(), createQueryRunner: jest.fn() };
    const service = await buildService(dataSource);

    await service.processHourlyBatch();

    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('logs one INFO line at startup explaining how to re-enable', async () => {
    delete process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV];
    const service = await buildService({ query: jest.fn(), createQueryRunner: jest.fn() });

    const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    service.onModuleInit();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('disabled by config');
    logSpy.mockRestore();
  });
});
