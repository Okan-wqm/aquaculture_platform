import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { SecurityEventService, tenantFingerprint } from '@aquaculture/backend-common/security';

import { AiPrivacyService } from '../ai-privacy.service';
import { KnowledgeEntry } from '../../entities/knowledge-entry.entity';
import { KnowledgeExtractionService } from '../knowledge-extraction.service';
import { MessageEntityReference } from '../../entities/message-entity-reference.entity';
import { MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV } from '../../ai-trigger.config';
import { TankRegistryClient } from '../tank-registry.client';
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

  const OTHER_TENANT_ID = '0d4f8c33-5b1e-4f7a-9c2d-6e8a1b3c5d7f';
  /** K10 (MT-HIGH-062): the registry reply names the tenant it served. */
  const registryReply = (tenantId: string, rows: unknown[]): unknown => ({
    ok: true,
    tenantId,
    data: rows,
  });
  const send = jest.fn().mockReturnValue(of(registryReply(TENANT_ID, [])));
  /** K10 layer 3: a foreign reply is reported as a TenantAccessDenied security event. */
  const publishTenantAccessDenied = jest.fn().mockResolvedValue(undefined);
  /** Content of the one message the sweep reads — tests that exercise tank references override it. */
  let messageContent = 'routine status update';
  let lastQueryRunner: { manager: { create: jest.Mock } } | undefined;

  // A minimal QueryRunner double covering exactly the calls the sweep makes for
  // one tenant schema with a single message and an empty tank registry.
  const makeQueryRunner = (): Record<string, unknown> => {
    const qr = {
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
              content: messageContent,
              createdAt: new Date(),
              tenantId: TENANT_ID,
            },
          ]);
        }
        // search_path pin + RLS GUC bind/read-back + any other statement.
        return Promise.resolve([]);
      }),
    };
    lastQueryRunner = qr;
    return qr;
  };

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
  /** The REAL TankRegistryClient the service is wired with (its logger is a spy target). */
  let registryClient: TankRegistryClient;

  beforeEach(async () => {
    jest.clearAllMocks();
    send.mockReturnValue(of(registryReply(TENANT_ID, [])));
    messageContent = 'routine status update';
    lastQueryRunner = undefined;
    // MSGFIX-FAZ0: pipeline behaviour is tested with the gate OPEN.
    process.env[MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV] = 'true';
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeExtractionService,
        { provide: DataSource, useValue: dataSource },
        TankRegistryClient,
        { provide: 'NATS_SERVICE', useValue: { send } },
        { provide: SecurityEventService, useValue: { publishTenantAccessDenied } },
        { provide: AiPrivacyService, useValue: {} },
        { provide: ScheduledJobRunner, useValue: createScheduledJobTestExecutor().executor },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeExtractionService);
    registryClient = moduleRef.get(TankRegistryClient);
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

  it('links a tank named in a message when the registry reply is bound to this tenant', async () => {
    // SCENARIO: the message names tank A1 and farm answers for THIS tenant with A1 in its registry.
    // EXPECTS: an entity reference to the registry's tank id is created.
    messageContent = 'Tank A1 feeding done';
    send.mockReturnValue(
      of(
        registryReply(TENANT_ID, [
          { id: 'tank-a1', code: 'A1', name: 'Tank A1', status: 'ACTIVE' },
        ]),
      ),
    );

    await service.processHourlyBatch();

    expect(lastQueryRunner?.manager.create).toHaveBeenCalledWith(
      MessageEntityReference,
      expect.objectContaining({ entityId: 'tank-a1' }),
    );
  });

  it('keys every knowledge row it writes to the ledger tenant (K10 layer 5)', async () => {
    // SCENARIO: a feeding note names tank A1, which is in this tenant's bound registry.
    // EXPECTS: both the entity reference and the knowledge entry carry the batch's ledger
    //          tenantId (NOT NULL column — a row without it never persisted).
    messageContent = 'Tank A1 fed 12 kg pellet';
    send.mockReturnValue(
      of(
        registryReply(TENANT_ID, [
          { id: 'tank-a1', code: 'A1', name: 'Tank A1', status: 'ACTIVE' },
        ]),
      ),
    );

    await service.processHourlyBatch();

    expect(lastQueryRunner?.manager.create).toHaveBeenCalledWith(
      MessageEntityReference,
      expect.objectContaining({ tenantId: TENANT_ID, entityId: 'tank-a1' }),
    );
    expect(lastQueryRunner?.manager.create).toHaveBeenCalledWith(
      KnowledgeEntry,
      expect.objectContaining({ tenantId: TENANT_ID, sourceMessageId: 'msg-1' }),
    );
  });

  it('discards a registry reply served for another tenant — no foreign tank id reaches this tenant', async () => {
    // SCENARIO: the message names tank A1; the reply carries A1 but names another tenant.
    // EXPECTS: nothing is written from that registry and the boundary violation is logged.
    messageContent = 'Tank A1 feeding done';
    send.mockReturnValue(
      of(
        registryReply(OTHER_TENANT_ID, [
          { id: 'foreign-tank', code: 'A1', name: 'Tank A1', status: 'ACTIVE' },
        ]),
      ),
    );
    const errorSpy = jest
      .spyOn(registryClient['logger'], 'error')
      .mockImplementation(() => undefined);

    await service.processHourlyBatch();

    expect(lastQueryRunner?.manager.create).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTenantId: TENANT_ID, servedTenantId: OTHER_TENANT_ID }),
    );
    // K10 layer 3: the same security event ai-service writes — ids only, never the rows.
    expect(publishTenantAccessDenied).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      // V-T1a-10: the other tenant appears in this tenant's event only as a fingerprint.
      requestedTenantId: tenantFingerprint(OTHER_TENANT_ID),
      reason: 'knowledge_extraction_reply_tenant_mismatch:request.farm.getTankRegistry',
    });
    expect(JSON.stringify(publishTenantAccessDenied.mock.calls)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(publishTenantAccessDenied.mock.calls)).not.toContain('foreign-tank');
    errorSpy.mockRestore();
  });

  it('treats a pre-K10 bare-array reply as no registry', async () => {
    // SCENARIO: an old farm-service answers with a bare array.
    // EXPECTS: the envelope check fails, no tank reference is written, and the
    //          tenant-less reply is recorded as a security event.
    messageContent = 'Tank A1 feeding done';
    send.mockReturnValue(of([{ id: 'tank-a1', code: 'A1', name: 'Tank A1' }]));

    await service.processHourlyBatch();

    expect(lastQueryRunner?.manager.create).not.toHaveBeenCalled();
    expect(publishTenantAccessDenied).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      requestedTenantId: 'none',
      reason: 'knowledge_extraction_reply_without_tenant:request.farm.getTankRegistry',
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
        { provide: DataSource, useValue: dataSource },
        TankRegistryClient,
        { provide: 'NATS_SERVICE', useValue: { send } },
        { provide: SecurityEventService, useValue: { publishTenantAccessDenied: jest.fn() } },
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
