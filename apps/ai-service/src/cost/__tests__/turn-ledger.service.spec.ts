import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TurnLedgerService } from '../turn-ledger.service';
import { ConversationTurn } from '../conversation-turn.entity';

/**
 * ORPHAN-MEDIUM-380 / DB-PEOPLE-MEDIUM-002 — durable per-turn cost ledger.
 *
 * London-School unit spec: the TypeORM repository is mocked; the assertions
 * pin the ledger CONTRACT — one append per invocation with correct per-class
 * token splits + costUsd, tenantId forced onto the row, empty flag lists
 * persisted as NULL, and (critically) a failed append LOGGING LOUDLY while
 * returning false instead of throwing into the chat path.
 */
describe('TurnLedgerService (ORPHAN-MEDIUM-380)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const conversationId = '11111111-2222-3333-4444-555555555555';

  let repositoryMock: {
    create: jest.Mock;
    save: jest.Mock;
  };

  const buildService = async (): Promise<TurnLedgerService> => {
    repositoryMock = {
      create: jest.fn((dto: Partial<ConversationTurn>) => dto),
      save: jest.fn((dto: Partial<ConversationTurn>) => Promise.resolve(dto)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TurnLedgerService,
        { provide: getRepositoryToken(ConversationTurn), useValue: repositoryMock },
      ],
    }).compile();
    return moduleRef.get(TurnLedgerService);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('appends exactly one row with correct token splits, tenant scoping, and costUsd', async () => {
    const service = await buildService();

    const persisted = await service.recordTurn({
      tenantId,
      conversationId,
      personaId: 'operator-v1',
      model: 'claude-sonnet-5',
      usage: { input: 100, output: 50, cacheRead: 30, cacheCreation: 20 },
      flaggedCategories: [],
    });

    expect(persisted).toBe(true);
    expect(repositoryMock.save).toHaveBeenCalledTimes(1);
    const row = repositoryMock.save.mock.calls[0][0] as Partial<ConversationTurn>;
    // TenantScopedRepository force-sets tenantId — cross-tenant rows are
    // structurally impossible through this path.
    expect(row.tenantId).toBe(tenantId);
    expect(row.conversationId).toBe(conversationId);
    expect(row.personaId).toBe('operator-v1');
    expect(row.model).toBe('claude-sonnet-5');
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cacheReadTokens).toBe(30);
    expect(row.cacheCreationTokens).toBe(20);
    // 100*3 + 50*15 + 30*0.3 + 20*3.75 per MTok = 0.001134 USD (cache
    // creation included — the finding's core defect).
    expect(row.costUsd).toBe('0.001134');
    // Empty flag list persists as NULL, not [] (clean turns are queryable
    // via IS NULL).
    expect(row.flaggedCategories).toBeNull();
  });

  it('persists non-empty flaggedCategories verbatim', async () => {
    const service = await buildService();

    await service.recordTurn({
      tenantId,
      conversationId,
      personaId: null,
      model: 'claude-haiku-4-5',
      usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      flaggedCategories: ['input:role_confusion', 'output:pii_redacted'],
    });

    const row = repositoryMock.save.mock.calls[0][0] as Partial<ConversationTurn>;
    expect(row.flaggedCategories).toEqual(['input:role_confusion', 'output:pii_redacted']);
    expect(row.personaId).toBeNull();
  });

  it('a failed append logs loudly and returns false — it never throws into the chat path', async () => {
    const service = await buildService();
    repositoryMock.save.mockRejectedValue(new Error('relation does not exist'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const persisted = await service.recordTurn({
      tenantId,
      conversationId,
      personaId: 'operator-v1',
      model: 'claude-sonnet-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      flaggedCategories: [],
    });

    expect(persisted).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    // Loud + actionable: the log carries tenant, conversation, model, and
    // token context so a lost row is reconstructable from logs.
    expect(logged).toContain(tenantId);
    expect(logged).toContain(conversationId);
    expect(logged).toContain('claude-sonnet-5');
    expect(logged).toContain('relation does not exist');
  });

  it('warns (but still records at default rates) when the model is missing from the catalog', async () => {
    const service = await buildService();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const persisted = await service.recordTurn({
      tenantId,
      conversationId,
      personaId: null,
      model: 'experimental-model-x',
      usage: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 },
      flaggedCategories: [],
    });

    expect(persisted).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('experimental-model-x'));
    const row = repositoryMock.save.mock.calls[0][0] as Partial<ConversationTurn>;
    // Default Sonnet-tier attribution — never a free-looking turn.
    expect(row.costUsd).toBe('0.003000');
  });
});
