/**
 * CreateFinanceEntryHandler — transactional outbox + guard unit tests.
 *
 * Pins:
 *   1. Happy path: entry saved + FinanceEntryRecorded enqueued on the
 *      SAME EntityManager (atomic with the insert), amount as a
 *      string-encoded decimal.
 *   2. Currency omitted → resolved through FinanceSettingsService (the
 *      SSoT), never a hardcoded literal.
 *   3. Computed category → BadRequestException (no row, no event).
 *   4. Archived category → BadRequestException.
 *   5. Unknown category → NotFoundException.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { EntityManager } from 'typeorm';
import type { OutboxPublisher } from '@platform/outbox';

import { CreateFinanceEntryHandler } from '../handlers/create-finance-entry.handler';
import { CreateFinanceEntryCommand } from '../commands/create-finance-entry.command';
import {
  FinanceCategory,
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';
import type { CreateFinanceEntryInput } from '../dto/finance-inputs.dto';
import type { FinanceCategorySeedService } from '../services/finance-category-seed.service';
import type { FinanceSettingsService } from '../services/finance-settings.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Build a fully-typed partial double for an interface T (same helper
 * pattern as the feeding handler spec).
 */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  category?: Partial<FinanceCategory> | null;
  tenantCurrency?: string;
}

function makeHarness(opts: HarnessOpts = {}) {
  const category: FinanceCategory | null =
    opts.category === null
      ? null
      : ({
          id: CATEGORY_ID,
          tenantId: TENANT_ID,
          name: 'Electricity',
          code: 'ELECTRICITY',
          scope: FinanceCategoryScope.FARM_OPEX,
          kind: FinanceCategoryKind.EXPENSE,
          computedRule: null,
          isSystem: true,
          isActive: true,
          displayOrder: 10,
          ...(opts.category ?? {}),
        } as FinanceCategory);

  const { mockDataSource, mockManager } = createMockDataSource();
  (mockManager.findOne as jest.Mock).mockResolvedValue(category);
  (mockManager.save as jest.Mock).mockImplementation(async (entity: unknown) => ({
    id: 'entry-1',
    ...(entity as Record<string, unknown>),
  }));

  const enqueue = jest.fn().mockResolvedValue(undefined);
  const outboxPublisher = mock<OutboxPublisher>({ enqueue });

  const seedService = mock<FinanceCategorySeedService>({
    ensureDefaults: jest.fn().mockResolvedValue(undefined),
  });

  const settingsService = mock<FinanceSettingsService>({
    getDefaultCurrencyInTx: jest.fn().mockResolvedValue(opts.tenantCurrency ?? 'NOK'),
  });

  const handler = new CreateFinanceEntryHandler(
    mockDataSource,
    outboxPublisher,
    seedService,
    settingsService,
  );

  return { handler, mockManager, enqueue, seedService, settingsService };
}

const baseInput: CreateFinanceEntryInput = {
  categoryId: CATEGORY_ID,
  entryDate: '2026-07-01',
  amount: 1234.5,
} as CreateFinanceEntryInput;

describe('CreateFinanceEntryHandler', () => {
  it('saves the entry and enqueues FinanceEntryRecorded on the same manager', async () => {
    const { handler, mockManager, enqueue } = makeHarness();

    const result = await handler.execute(
      new CreateFinanceEntryCommand(TENANT_ID, { ...baseInput, currency: 'EUR' }, USER_ID),
    );

    expect(result.id).toBe('entry-1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [event, manager] = enqueue.mock.calls[0] as [Record<string, unknown>, EntityManager];
    expect(manager).toBe(mockManager);
    expect(event.eventType).toBe('FinanceEntryRecorded');
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.amount).toBe('1234.50'); // string-encoded decimal, never a JS number
    expect(event.currency).toBe('EUR');
    expect(event.scope).toBe('FARM_OPEX');
    expect(event.sourceService).toBe('farm-service');
  });

  it('resolves the currency from the tenant finance settings when omitted', async () => {
    const { handler, enqueue, settingsService } = makeHarness({ tenantCurrency: 'TRY' });

    await handler.execute(new CreateFinanceEntryCommand(TENANT_ID, baseInput, USER_ID));

    expect(settingsService.getDefaultCurrencyInTx).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
    );
    const [event] = enqueue.mock.calls[0] as [Record<string, unknown>];
    expect(event.currency).toBe('TRY');
  });

  it('rejects manual entries on computed categories', async () => {
    const { handler, enqueue, mockManager } = makeHarness({
      category: {
        computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 5, base: 'NON_COMPUTED' },
      },
    });

    await expect(
      handler.execute(new CreateFinanceEntryCommand(TENANT_ID, baseInput, USER_ID)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockManager.save).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects entries on archived categories', async () => {
    const { handler, enqueue } = makeHarness({ category: { isActive: false } });

    await expect(
      handler.execute(new CreateFinanceEntryCommand(TENANT_ID, baseInput, USER_ID)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown category', async () => {
    const { handler } = makeHarness({ category: null });

    await expect(
      handler.execute(new CreateFinanceEntryCommand(TENANT_ID, baseInput, USER_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
