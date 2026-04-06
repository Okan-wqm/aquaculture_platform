/**
 * UpdateBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — batch field updates.
 */
import { NotFoundException } from '@nestjs/common';
import { UpdateBatchHandler } from '../../handlers/update-batch.handler';
import { UpdateBatchCommand } from '../../commands/update-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockRepository } from '@aquaculture/testing';

describe('UpdateBatchHandler', () => {
  let handler: UpdateBatchHandler;
  const mockBatchRepo = createMockRepository<Batch>();

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new UpdateBatchHandler(mockBatchRepo as any);
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  it('should update batch name', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, name: 'Old Name',
      status: BatchStatus.GROWING, isActive: true,
    } as Batch;

    mockBatchRepo.findOne.mockResolvedValueOnce(batch);
    mockBatchRepo.save.mockImplementation((b) => Promise.resolve(b as Batch));

    const result = await handler.execute(
      new UpdateBatchCommand(TENANT, 'batch-1', { name: 'New Name' }, USER),
    );

    expect(result.name).toBe('New Name');
  });

  it('should not overwrite fields that are not in payload', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, name: 'Keep This',
      notes: 'Keep These Notes', status: BatchStatus.GROWING, isActive: true,
    } as Batch;

    mockBatchRepo.findOne.mockResolvedValueOnce(batch);
    mockBatchRepo.save.mockImplementation((b) => Promise.resolve(b as Batch));

    const result = await handler.execute(
      new UpdateBatchCommand(TENANT, 'batch-1', { notes: 'Updated Notes' }, USER),
    );

    expect(result.name).toBe('Keep This');
    expect(result.notes).toBe('Updated Notes');
  });

  it('should throw NotFoundException when batch not found', async () => {
    mockBatchRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new UpdateBatchCommand(TENANT, 'nonexistent', { name: 'X' }, USER)),
    ).rejects.toThrow(NotFoundException);
  });

  it('should set updatedBy on save', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, name: 'Name',
      status: BatchStatus.GROWING, isActive: true,
    } as Batch;

    mockBatchRepo.findOne.mockResolvedValueOnce(batch);
    mockBatchRepo.save.mockImplementation((b) => Promise.resolve(b as Batch));

    const result = await handler.execute(
      new UpdateBatchCommand(TENANT, 'batch-1', { name: 'Updated' }, USER),
    );

    expect(result.updatedBy).toBe(USER);
  });
});
