/**
 * CreateHarvestRecordHandler
 *
 * CreateHarvestRecordCommand'ı işler ve harvest kaydı oluşturur.
 * Tank ve Batch'i günceller.
 *
 * The harvest write itself (locks, compliance gates, record + ledger rows,
 * batch + tank-composition decrement, BatchHarvested outbox event) is owned by
 * HarvestRecordWriter, which takes this handler's transaction manager. The
 * handler owns what is specific to a DIRECT harvest: the backdate policy, the
 * mobile-command receipt (idempotent replay) and the transaction boundary.
 * CompleteHarvestPlanHandler drives the same writer for every tank of a plan
 * inside ONE transaction (FARM-HIGH-394).
 *
 * @module Harvest/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { ConflictException, Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import { defaultMobileCommandReceiptsForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { HarvestRecord } from '../entities/harvest-record.entity';
import { HarvestRecordWriter } from '../services/harvest-record-writer.service';

@Injectable()
@CommandHandler(CreateHarvestRecordCommand)
// Return HarvestRecord so the GraphQL resolver can expose harvest-specific fields to clients
export class CreateHarvestRecordHandler
  implements ICommandHandler<CreateHarvestRecordCommand, HarvestRecord>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly backdatePolicy: BackdatePolicyService,
    // Currency SSoT (FARM-HIGH-151): harvest_records.totalRevenue feeds the
    // HARVEST_REVENUE derived-cost line — the currency must be the tenant
    // default from finance_settings, never a hardcoded literal.
    private readonly financeSettings: FinanceSettingsService,
    // The single owner of the harvest write (FARM-HIGH-394).
    private readonly harvestRecordWriter: HarvestRecordWriter,
    private readonly mobileCommandReceipts: MobileCommandReceiptService = defaultMobileCommandReceiptsForDirectHandlerConstruction(),
  ) {}

  async execute(command: CreateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, input, recordedBy } = command;

    const harvestDate =
      typeof input.harvestDate === 'string' ? new Date(input.harvestDate) : input.harvestDate;

    // Backdate policy: harvest may be logged up to HARVEST_BACKDATE_LIMIT_DAYS
    // (default 7) after the physical event. Future dates are rejected
    // unconditionally — a harvest record with a harvestDate in the future
    // would falsely advance lot traceability timelines.
    this.backdatePolicy.validate({
      context: 'harvest',
      proposedDate: harvestDate,
      subjectLabel: `batch ${input.batchId}`,
    });

    // Currency SSoT (FARM-HIGH-151): resolve the tenant default before the
    // transaction so revenue + customer-delivery lines book in it.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    // The fail-closed tenant boundary pins search_path + the RLS GUC and
    // commits / rolls back / releases around the callback.
    const result = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
          tableName: 'farm_mobile_command_receipts',
          tenantId,
          envelope: command.mobileCommand,
          operationType: 'createHarvestRecord',
          responseType: 'HarvestRecord',
        });
        if (receipt.mode === 'replay') {
          const replayed = receipt.responseId
            ? await queryRunner.manager.findOne(HarvestRecord, {
                where: { id: receipt.responseId, tenantId },
              })
            : null;
          if (!replayed) {
            throw new ConflictException('Mobile command receipt response is no longer available');
          }
          // Replay short-circuits the write path: no final-harvest close
          // chain re-runs (the original harvest already dispatched it).
          return { harvestRecord: replayed, isFinalHarvest: false, recordCode: null };
        }

        const written = await this.harvestRecordWriter.write(queryRunner.manager, {
          tenantId,
          input,
          harvestDate,
          caller: {
            sub: recordedBy,
            roles: command.userRoles,
            assignedSiteIds: command.callerAssignedSiteIds,
          },
          defaultCurrency,
        });

        await this.mobileCommandReceipts.complete(queryRunner.manager, {
          tableName: 'farm_mobile_command_receipts',
          receipt,
          responseType: 'HarvestRecord',
          responseId: written.harvestRecord.id,
          responsePayload: { id: written.harvestRecord.id },
        });

        // Domain writes + outbox row commit atomically when the boundary
        // commits the callback. The final-harvest close chain runs AFTER the
        // commit (below), never inside this transaction.
        return written;
      },
    );

    if (result.isFinalHarvest && result.recordCode !== null) {
      await this.harvestRecordWriter.closeBatchAfterFinalHarvest(
        tenantId,
        input.batchId,
        recordedBy,
        result.recordCode,
      );
    }

    return result.harvestRecord;
  }
}
