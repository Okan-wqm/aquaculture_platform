/**
 * Welfare Assessment Service — writes structured welfare scores (gill / fin /
 * wound / deformity, 0–3 over a fish sample) per tank per date. Welfare
 * varsling and internal welfare trends consume these records instead of
 * free-string symptom arrays.
 *
 * Phase 6 (FARM-HIGH-214): recording is a plain insert (multiple assessments
 * per tank/date are legitimate — different samples), so mobile offline-queue
 * replays are deduplicated through the farm_mobile_command_receipts ledger:
 * begin() inside the write transaction either starts a receipt, or returns the
 * previously stored response for a replayed clientCommandId.
 *
 * @module FishHealth
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  MobileCommandReceiptService,
  mobileCommandEnvelopeFromInput,
} from '@aquaculture/backend-common/mobile-command';

import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { IncidentMediaType } from '../entities/farm-incident-media.entity';
import { RecordWelfareAssessmentInput } from '../dto/field-capture.inputs';
import { IncidentMediaService } from './incident-media.service';

@Injectable()
export class WelfareAssessmentService {
  private readonly logger = new Logger(WelfareAssessmentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
    private readonly incidentMediaService: IncidentMediaService,
  ) {}

  async record(
    tenantId: string,
    input: RecordWelfareAssessmentInput,
    userId: string,
  ): Promise<WelfareAssessment> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, WelfareAssessment, tenantId);

      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: mobileCommandEnvelopeFromInput(input),
        operationType: 'recordWelfareAssessment',
        responseType: 'WelfareAssessment',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await repo.findOne({ where: { id: receipt.responseId, tenantId } })
          : null;
        if (!replayed) {
          throw new NotFoundException(
            'Replayed welfare assessment no longer exists for this command receipt',
          );
        }
        return replayed;
      }

      const saved = await repo.save(
        repo.create({
          tenantId,
          siteId: input.siteId,
          tankId: input.tankId,
          batchId: input.batchId,
          assessedAt: input.assessedAt.slice(0, 10),
          fishSampled: input.fishSampled,
          gillScore: input.gillScore,
          finScore: input.finScore,
          woundScore: input.woundScore,
          deformityScore: input.deformityScore,
          assessedBy: userId,
          notes: input.notes,
        }),
      );

      await this.incidentMediaService.attach(
        queryRunner.manager,
        tenantId,
        IncidentMediaType.WELFARE,
        saved.id,
        input.mediaKeys,
        userId,
      );

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'WelfareAssessment',
        responseId: saved.id,
        responsePayload: { id: saved.id },
      });

      this.logger.log(
        `Recorded welfare assessment ${saved.id} (tank ${input.tankId}, ${saved.assessedAt})`,
      );
      return saved;
    });
  }
}
