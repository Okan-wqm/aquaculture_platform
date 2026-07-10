/**
 * Welfare Assessment Service — writes structured welfare scores (gill / fin /
 * wound / deformity, 0–3 over a fish sample) per tank per date. Welfare
 * varsling and internal welfare trends consume these records instead of
 * free-string symptom arrays.
 *
 * @module FishHealth
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { RecordWelfareAssessmentInput } from '../dto/field-capture.inputs';

@Injectable()
export class WelfareAssessmentService {
  private readonly logger = new Logger(WelfareAssessmentService.name);

  constructor(private readonly dataSource: DataSource) {}

  async record(
    tenantId: string,
    input: RecordWelfareAssessmentInput,
    userId: string,
  ): Promise<WelfareAssessment> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, WelfareAssessment, tenantId);
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
      this.logger.log(
        `Recorded welfare assessment ${saved.id} (tank ${input.tankId}, ${saved.assessedAt})`,
      );
      return saved;
    });
  }
}
