/**
 * WelfareAssessmentService — plain-insert capture with mobile at-most-once
 * semantics (Phase 6, FARM-HIGH-214): several assessments per tank/day are
 * legitimate (different samples), so replays dedup through the
 * farm_mobile_command_receipts ledger, not a natural key.
 */
import { NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';

const runInTenantTransaction = jest.fn();
const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { WelfareAssessmentService } from '../services/welfare-assessment.service';
import type { RecordWelfareAssessmentInput } from '../dto/field-capture.inputs';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER = 'uuuuuuuu-1111-4222-8333-444444444444';

const BASE_INPUT: RecordWelfareAssessmentInput = {
  siteId: 'site-1',
  tankId: 'tank-1',
  assessedAt: '2026-07-11',
  fishSampled: 10,
  gillScore: 1,
  finScore: 0,
  woundScore: 2,
  deformityScore: 0,
};

interface FakeRepo {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function setup(existing: object | null = null): {
  service: WelfareAssessmentService;
  repo: FakeRepo;
  receiptBegin: jest.Mock;
  receiptComplete: jest.Mock;
} {
  const txManager: Partial<EntityManager> = {};
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: txManager }),
  );
  const repo: FakeRepo = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((values: object) => values),
    save: jest.fn(async (values: object) => ({ id: 'welfare-1', ...values })),
  };
  tenantManagerRepo.mockReturnValue(repo);
  const receiptBegin = jest.fn().mockResolvedValue({ mode: 'legacy' });
  const receiptComplete = jest.fn().mockResolvedValue(undefined);
  const service = new WelfareAssessmentService(
    {} as Partial<DataSource> as DataSource,
    {
      begin: receiptBegin,
      complete: receiptComplete,
    } as Partial<MobileCommandReceiptService> as MobileCommandReceiptService,
  );
  return { service, repo, receiptBegin, receiptComplete };
}

describe('WelfareAssessmentService (FARM-HIGH-214)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records the four scores + sample size and stamps the assessor', async () => {
    const { service, repo } = setup();

    const saved = await service.record(TENANT, BASE_INPUT, USER);

    expect(saved).toMatchObject({
      id: 'welfare-1',
      tenantId: TENANT,
      siteId: 'site-1',
      tankId: 'tank-1',
      assessedAt: '2026-07-11',
      fishSampled: 10,
      gillScore: 1,
      finScore: 0,
      woundScore: 2,
      deformityScore: 0,
      assessedBy: USER,
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('completes a started mobile-command receipt with the assessment id', async () => {
    const { service, receiptBegin, receiptComplete } = setup();
    receiptBegin.mockResolvedValue({ mode: 'started', receiptId: 'receipt-1' });

    await service.record(
      TENANT,
      {
        ...BASE_INPUT,
        clientCommandId: 'cccccccc-1111-4222-8333-444444444444',
        payloadHash: 'hash-1',
      },
      USER,
    );

    expect(receiptBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableName: 'farm_mobile_command_receipts',
        tenantId: TENANT,
        operationType: 'recordWelfareAssessment',
      }),
    );
    expect(receiptComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        responseType: 'WelfareAssessment',
        responseId: 'welfare-1',
      }),
    );
  });

  it('REPLAY: a replayed clientCommandId returns the original row and inserts NOTHING', async () => {
    const original = { id: 'welfare-1', tenantId: TENANT };
    const { service, repo, receiptBegin, receiptComplete } = setup(original);
    receiptBegin.mockResolvedValue({
      mode: 'replay',
      responseType: 'WelfareAssessment',
      responseId: 'welfare-1',
      responsePayload: { id: 'welfare-1' },
    });

    const replayed = await service.record(
      TENANT,
      {
        ...BASE_INPUT,
        clientCommandId: 'cccccccc-1111-4222-8333-444444444444',
        payloadHash: 'hash-1',
      },
      USER,
    );

    expect(replayed).toBe(original);
    expect(repo.save).not.toHaveBeenCalled();
    expect(receiptComplete).not.toHaveBeenCalled();
  });

  it('REPLAY: a receipt pointing at a deleted assessment fails loudly', async () => {
    const { service, receiptBegin } = setup(null);
    receiptBegin.mockResolvedValue({
      mode: 'replay',
      responseType: 'WelfareAssessment',
      responseId: 'welfare-gone',
      responsePayload: { id: 'welfare-gone' },
    });

    await expect(
      service.record(
        TENANT,
        {
          ...BASE_INPUT,
          clientCommandId: 'cccccccc-1111-4222-8333-444444444444',
          payloadHash: 'hash-1',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
