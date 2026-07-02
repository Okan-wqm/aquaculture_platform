/**
 * RecordGradingHandler — orchestration unit tests (FARM-MEDIUM-117).
 *
 * Grading composes the TransferBatchCommand SSoT (one dispatch per output,
 * reason 'grading', per-output idempotency envelope) and then publishes the
 * operation-level BatchGraded summary through the transactional outbox.
 */
import { BadRequestException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { CommandBus } from '@platform/cqrs';
import type { BatchGradedEvent } from '@platform/event-contracts';
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';

import { RecordGradingHandler } from '../../handlers/record-grading.handler';
import { RecordGradingCommand } from '../../commands/record-grading.command';
import { TransferBatchCommand } from '../../commands/transfer-batch.command';
import { Batch } from '../../entities/batch.entity';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const BATCH_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const SOURCE_TANK = 'cccccccc-1111-4222-8333-444444444444';

function output(n: number, overrides: Record<string, unknown> = {}) {
  return {
    destinationTankId: `dddddddd-1111-4222-8333-44444444444${n}`,
    quantity: 100 * n,
    avgWeightG: 50 * n,
    sizeClass: `S${n}`,
    clientCommandId: `eeeeeeee-1111-4222-8333-44444444444${n}`,
    payloadHash: `hash-${n}`,
    ...overrides,
  };
}

function makeHarness() {
  const mocks = createMockDataSource();
  const execute = jest.fn().mockResolvedValue({ id: BATCH_ID });
  const commandBus: Pick<CommandBus, 'execute'> = { execute };
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const outbox: Pick<OutboxPublisher, 'enqueue'> = { enqueue };
  const batch = new Batch();
  batch.id = BATCH_ID;
  const findOne = jest.fn().mockResolvedValue(batch);
  const batchRepo: Pick<Repository<Batch>, 'findOne'> = { findOne };

  const handler = new RecordGradingHandler(
    commandBus as CommandBus,
    mocks.mockDataSource,
    batchRepo as Repository<Batch>,
    outbox as OutboxPublisher,
  );
  return { handler, execute, enqueue, mocks, batch };
}

function command(outputs: ReturnType<typeof output>[]) {
  return new RecordGradingCommand(
    TENANT_ID,
    BATCH_ID,
    {
      sourceTankId: SOURCE_TANK,
      gradedAt: new Date('2026-07-01T08:00:00.000Z'),
      notes: 'Summer grading',
      outputs,
      deviceId: 'device-1',
    },
    'user-1',
  );
}

describe('RecordGradingHandler', () => {
  it('dispatches one grading transfer per output with its own envelope', async () => {
    const { handler, execute, enqueue, batch } = makeHarness();

    const result = await handler.execute(command([output(1), output(2)]));

    expect(result).toBe(batch);
    expect(execute).toHaveBeenCalledTimes(2);
    const first = execute.mock.calls[0][0] as TransferBatchCommand;
    expect(first).toBeInstanceOf(TransferBatchCommand);
    expect(first.payload.sourceTankId).toBe(SOURCE_TANK);
    expect(first.payload.transferReason).toBe('grading');
    expect(first.payload.notes).toBe('Grading size class: S1');
    expect(first.mobileCommand?.clientCommandId).toBe(output(1).clientCommandId);
    expect(first.mobileCommand?.payloadHash).toBe('hash-1');
    const second = execute.mock.calls[1][0] as TransferBatchCommand;
    expect(second.mobileCommand?.clientCommandId).toBe(output(2).clientCommandId);

    // Summary event with derived totals
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [event] = enqueue.mock.calls[0] as [BatchGradedEvent];
    expect(event.eventType).toBe('BatchGraded');
    expect(event.sourceTankId).toBe(SOURCE_TANK);
    expect(event.totalQuantity).toBe(300);
    expect(event.totalBiomassKg).toBeCloseTo(100 * 50 / 1000 + 200 * 100 / 1000);
    expect(event.outputs).toHaveLength(2);
  });

  it('rejects an empty output list before touching the transfer path', async () => {
    const { handler, execute } = makeHarness();
    await expect(handler.execute(command([]))).rejects.toThrow(BadRequestException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate destination tanks', async () => {
    const { handler, execute } = makeHarness();
    await expect(
      handler.execute(command([output(1), output(2, { destinationTankId: output(1).destinationTankId })])),
    ).rejects.toThrow('distinct destination tanks');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an output targeting the source tank', async () => {
    const { handler, execute } = makeHarness();
    await expect(
      handler.execute(command([output(1, { destinationTankId: SOURCE_TANK })])),
    ).rejects.toThrow('source tank');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports committed outputs and skips the summary event when a movement fails midway', async () => {
    const { handler, execute, enqueue } = makeHarness();
    execute
      .mockResolvedValueOnce({ id: BATCH_ID })
      .mockRejectedValueOnce(new Error('capacity exceeded'));

    await expect(handler.execute(command([output(1), output(2), output(3)]))).rejects.toThrow(
      /Grading stopped at output 2\/3 .*capacity exceeded.*1 output\(s\) already committed/,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
