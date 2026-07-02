/**
 * RecordGradingHandler (FARM-MEDIUM-117)
 *
 * Orchestrates a grading operation as a sequence of TransferBatchCommand
 * dispatches (reason 'grading') — one per destination tank — then
 * publishes the operation-level BatchGraded summary event through the
 * transactional outbox.
 *
 * WHY composition instead of a bespoke ledger: TransferBatchHandler is
 * the single owner of the locked tank_operations/tank_allocations/
 * tank_batches movement ledger (TOCTOU locks, capacity enforcement,
 * site authorization on both legs, single-writer counts, mobile
 * idempotency). Duplicating that here would fork the most
 * safety-critical write path in the service; each grading output IS a
 * transfer, so it goes through the transfer SSoT. A failure at output N
 * leaves outputs 1..N-1 committed — matching physical reality (those
 * fish already moved through the grader) — and the error names the
 * completed outputs so the operator resumes with the remainder.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandBus, CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { BatchGradedEvent } from '@platform/event-contracts';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

import { RecordGradingCommand } from '../commands/record-grading.command';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { Batch } from '../entities/batch.entity';

const MAX_GRADING_OUTPUTS = 12;

@Injectable()
@CommandHandler(RecordGradingCommand)
export class RecordGradingHandler implements ICommandHandler<RecordGradingCommand, Batch> {
  private readonly logger = new Logger(RecordGradingHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: RecordGradingCommand): Promise<Batch> {
    const { tenantId, batchId, payload, gradedBy } = command;
    const { outputs, sourceTankId } = payload;

    if (outputs.length === 0) {
      throw new BadRequestException('Grading requires at least one output tank');
    }
    if (outputs.length > MAX_GRADING_OUTPUTS) {
      throw new BadRequestException(`Grading supports at most ${MAX_GRADING_OUTPUTS} output tanks`);
    }
    const destinationIds = new Set(outputs.map((o) => o.destinationTankId));
    if (destinationIds.size !== outputs.length) {
      throw new BadRequestException('Grading outputs must target distinct destination tanks');
    }
    if (destinationIds.has(sourceTankId)) {
      throw new BadRequestException('Grading outputs cannot target the source tank');
    }

    const gradedAt = payload.gradedAt || new Date();
    const completed: BatchGradedEvent['outputs'] = [];

    for (const output of outputs) {
      try {
        await this.commandBus.execute(
          new TransferBatchCommand(
            tenantId,
            batchId,
            {
              sourceTankId,
              destinationTankId: output.destinationTankId,
              quantity: output.quantity,
              avgWeightG: output.avgWeightG,
              transferReason: 'grading',
              transferredAt: gradedAt,
              notes: output.sizeClass
                ? `Grading size class: ${output.sizeClass}`
                : payload.notes,
            },
            gradedBy,
            command.userRoles,
            command.callerAssignedSiteIds,
            {
              clientCommandId: output.clientCommandId,
              payloadHash: output.payloadHash,
              deviceId: payload.deviceId,
              clientCreatedAt: payload.clientCreatedAt,
              schemaVersion: payload.schemaVersion,
              operationType: 'transferBatch',
            },
          ),
        );
        completed.push({
          destinationTankId: output.destinationTankId,
          quantity: output.quantity,
          avgWeightG: output.avgWeightG,
          biomassKg: (output.quantity * output.avgWeightG) / 1000,
          sizeClass: output.sizeClass,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new BadRequestException(
          `Grading stopped at output ${completed.length + 1}/${outputs.length} ` +
            `(tank ${output.destinationTankId}): ${message}. ` +
            `${completed.length} output(s) already committed: ` +
            `${completed.map((c) => c.destinationTankId).join(', ') || 'none'}. ` +
            'Resubmit the remaining outputs only.',
        );
      }
    }

    const totalQuantity = completed.reduce((sum, o) => sum + o.quantity, 0);
    const totalBiomassKg = completed.reduce((sum, o) => sum + o.biomassKg, 0);

    // Operation-level summary event, enqueued transactionally like every
    // other farm outbox publish.
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const gradedEvent: BatchGradedEvent = {
        ...createBaseEvent<BatchGradedEvent>('BatchGraded', tenantId, {
          aggregateId: batchId,
          aggregateType: 'Batch',
        }),
        userId: gradedBy,
        batchId,
        sourceTankId,
        totalQuantity,
        totalBiomassKg,
        gradedDate: toEventIso(gradedAt),
        outputs: completed,
        notes: payload.notes,
      };
      await this.outboxPublisher.enqueue(gradedEvent, queryRunner.manager);
    });

    this.logger.log(
      `Batch ${batchId} graded from tank ${sourceTankId} into ${completed.length} tanks, ` +
        `quantity=${totalQuantity}, tenant=${tenantId}`,
    );

    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });
    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }
    return batch;
  }
}
