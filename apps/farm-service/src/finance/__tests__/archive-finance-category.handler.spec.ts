/**
 * ArchiveFinanceCategoryHandler — archive guards.
 *
 * Pins the structural protection of the ledger projection: categories
 * bound to a derived cost source (FEED, FINGERLINGS, …) or carrying a
 * computed rule can NEVER be archived; plain user categories can, and
 * the archival emits FinanceCategoryArchived atomically.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource, stub } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';

import { ArchiveFinanceCategoryHandler } from '../handlers/archive-finance-category.handler';
import { ArchiveFinanceCategoryCommand } from '../commands/archive-finance-category.command';
import {
  FinanceCategory,
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';
import { DERIVED_SYSTEM_CODES } from '../services/derived-cost-sources';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function makeHarness(category: Partial<FinanceCategory> | null) {
  const row: FinanceCategory | null =
    category === null
      ? null
      : ({
          id: 'cat-1',
          tenantId: TENANT_ID,
          name: 'Custom category',
          code: null,
          scope: FinanceCategoryScope.FARM_OPEX,
          kind: FinanceCategoryKind.EXPENSE,
          computedRule: null,
          isSystem: false,
          isActive: true,
          displayOrder: 0,
          ...category,
        } as FinanceCategory);

  const { mockDataSource, mockManager } = createMockDataSource();
  (mockManager.findOne as jest.Mock).mockResolvedValue(row);
  (mockManager.save as jest.Mock).mockImplementation(async (entity: unknown) => entity);

  const enqueue = jest.fn().mockResolvedValue(undefined);
  const handler = new ArchiveFinanceCategoryHandler(
    mockDataSource,
    stub<OutboxPublisher>({ enqueue }),
  );

  return { handler, enqueue };
}

describe('ArchiveFinanceCategoryHandler', () => {
  it('archives a plain user category and emits FinanceCategoryArchived', async () => {
    const { handler, enqueue } = makeHarness({});

    const result = await handler.execute(
      new ArchiveFinanceCategoryCommand(TENANT_ID, 'cat-1', USER_ID),
    );

    expect(result.isActive).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [event] = enqueue.mock.calls[0] as [Record<string, unknown>];
    expect(event.eventType).toBe('FinanceCategoryArchived');
  });

  it.each([...DERIVED_SYSTEM_CODES])(
    'refuses to archive the derived-bound system category %s',
    async (code) => {
      const { handler, enqueue } = makeHarness({ code, isSystem: true });

      await expect(
        handler.execute(new ArchiveFinanceCategoryCommand(TENANT_ID, 'cat-1', USER_ID)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('refuses to archive a computed-rule category', async () => {
    const { handler } = makeHarness({
      code: 'OTHER_VARIABLE',
      isSystem: true,
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 5, base: 'NON_COMPUTED' },
    });

    await expect(
      handler.execute(new ArchiveFinanceCategoryCommand(TENANT_ID, 'cat-1', USER_ID)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound for an unknown category', async () => {
    const { handler } = makeHarness(null);

    await expect(
      handler.execute(new ArchiveFinanceCategoryCommand(TENANT_ID, 'missing', USER_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
