import { ConflictException } from '@nestjs/common';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { CreateWorkerCommand } from '../commands/create-worker.command';
import { CreateWorkerHandler } from '../handlers/create-worker.handler';
import { Worker, workerEmailBlindIndex } from '../entities/worker.entity';
import type { CreateWorkerInput } from '../dto/create-worker.input';
import type { FinanceSettingsService } from '../../finance/services/finance-settings.service';

/** Typed partial-mock helper (repo pattern — keeps mocks type-safe without a blanket cast). */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('CreateWorkerHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  // Currency SSoT resolver (FARM-HIGH-151) — the handler resolves the
  // tenant default currency through it instead of a hardcoded literal.
  const financeSettings = mock<FinanceSettingsService>({
    getDefaultCurrency: jest.fn().mockResolvedValue('NOK'),
  });

  const makeInput = (overrides: Partial<CreateWorkerInput> = {}): CreateWorkerInput => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '+90 555 000 0000',
    position: 'Operator',
    ...overrides,
  });

  it('rejects a duplicate email via the blind index without opening a transaction', async () => {
    const { mockDataSource } = createMockDataSource();
    const workerRepository = createMockRepository<Worker>();
    (workerRepository.findOne as jest.Mock).mockResolvedValueOnce({ id: 'existing' } as Worker);

    const handler = new CreateWorkerHandler(workerRepository, mockDataSource, financeSettings);

    await expect(
      handler.execute(new CreateWorkerCommand(makeInput(), tenantId, userId)),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(workerRepository.findOne).toHaveBeenCalledWith({
      where: { tenantId, emailHash: workerEmailBlindIndex('ada@example.com') },
    });
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('creates a worker inside the tenant transaction and returns the saved entity', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const workerRepository = createMockRepository<Worker>();

    // No existing employee numbers → the FOR UPDATE select returns [] (factory default),
    // so the first sequence number (EMP-<year>-00001) is assigned.
    (mockManager.save as jest.Mock).mockImplementation((entity: Worker) =>
      Promise.resolve({ ...entity, id: 'worker-1' }),
    );

    const handler = new CreateWorkerHandler(workerRepository, mockDataSource, financeSettings);
    const result = await handler.execute(new CreateWorkerCommand(makeInput(), tenantId, userId));

    const year = new Date().getFullYear();
    expect(result.id).toBe('worker-1');
    expect(result.employeeNumber).toBe(`EMP-${year}-00001`);
    expect(result.firstName).toBe('Ada');
    expect(result.email).toBe('ada@example.com');
    expect(result.isFarmWorker).toBe(true);
    expect(result.createdBy).toBe(userId);

    expect(mockManager.create).toHaveBeenCalledWith(Worker, expect.objectContaining({
      tenantId,
      employeeNumber: `EMP-${year}-00001`,
    }));
    expect(mockManager.save).toHaveBeenCalledTimes(1);
  });

  it('increments the employee number from the locked max row', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const workerRepository = createMockRepository<Worker>();

    const year = new Date().getFullYear();
    // queryRunner.query drives BOTH the boundary's pin/GUC/readback calls AND the
    // handler's FOR UPDATE select. The boundary issues 3 calls first (all []), then
    // the 4th call — the handler's FOR UPDATE — returns the existing max row.
    (mockQueryRunner.query as jest.Mock).mockResolvedValue([]);
    (mockQueryRunner.query as jest.Mock).mockResolvedValueOnce([]); // pin search_path
    (mockQueryRunner.query as jest.Mock).mockResolvedValueOnce([]); // GUC set_config
    (mockQueryRunner.query as jest.Mock).mockResolvedValueOnce([]); // GUC readback
    (mockQueryRunner.query as jest.Mock).mockResolvedValueOnce([
      { employeeNumber: `EMP-${year}-00041` },
    ]);
    (mockManager.save as jest.Mock).mockImplementation((entity: Worker) =>
      Promise.resolve({ ...entity, id: 'worker-2' }),
    );

    const handler = new CreateWorkerHandler(workerRepository, mockDataSource, financeSettings);
    const result = await handler.execute(new CreateWorkerCommand(makeInput(), tenantId, userId));

    expect(result.employeeNumber).toBe(`EMP-${year}-00042`);
  });
});
