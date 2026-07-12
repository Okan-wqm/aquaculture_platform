/**
 * Escape Incident Service — records that an escape happened operationally and
 * closes the incident once recapture ends.
 *
 * Recording enqueues EscapeIncidentRecordedEvent into the transactional
 * outbox atomically with the row (notification-service reminds the manager
 * that the rømming varsling is legally IMMEDIATE — the varsling submission
 * itself stays on the desktop regulatory path, one submission path).
 *
 * Phase 6 (FARM-HIGH-214): recording is a plain insert AND fans out a legally
 * significant notification, so mobile offline-queue replays are deduplicated
 * through the farm_mobile_command_receipts ledger — a replayed
 * clientCommandId returns the original incident instead of double-filing an
 * escape (and double-reminding the manager).
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
import type { EscapeIncidentRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import {
  EscapeIncident,
  EscapeIncidentCause,
  EscapeIncidentStatus,
} from '../entities/escape-incident.entity';
import { CloseEscapeIncidentInput, RecordEscapeIncidentInput } from '../dto/field-capture.inputs';

@Injectable()
export class EscapeIncidentService {
  private readonly logger = new Logger(EscapeIncidentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
  ) {}

  async record(
    tenantId: string,
    input: RecordEscapeIncidentInput,
    userId: string,
  ): Promise<EscapeIncident> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, EscapeIncident, tenantId);

      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: mobileCommandEnvelopeFromInput(input),
        operationType: 'recordEscapeIncident',
        responseType: 'EscapeIncident',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await repo.findOne({ where: { id: receipt.responseId, tenantId } })
          : null;
        if (!replayed) {
          throw new NotFoundException(
            'Replayed escape incident no longer exists for this command receipt',
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
          detectedAt: new Date(input.detectedAt),
          speciesId: input.speciesId,
          estimatedCount: input.estimatedCount,
          avgWeightG: input.avgWeightG,
          cause: input.cause ?? EscapeIncidentCause.UNKNOWN,
          causeDetails: input.causeDetails,
          recoveryOngoing: input.recoveryOngoing ?? false,
          status: EscapeIncidentStatus.OPEN,
          createdBy: userId,
          notes: input.notes,
        }),
      );

      const event: EscapeIncidentRecordedEvent = {
        ...createBaseEvent<EscapeIncidentRecordedEvent>('EscapeIncidentRecorded', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'EscapeIncident',
          userId,
        }),
        incidentId: saved.id,
        siteId: saved.siteId,
        tankId: saved.tankId,
        speciesId: saved.speciesId,
        estimatedCount: saved.estimatedCount,
        cause: saved.cause,
        detectedAt: toEventIso(saved.detectedAt),
        recordedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        idempotencyKey: `escape-incident:${saved.id}`,
        aggregateId: saved.siteId,
      });

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'EscapeIncident',
        responseId: saved.id,
        responsePayload: { id: saved.id },
      });

      this.logger.warn(
        `Escape incident ${saved.id} recorded for site ${saved.siteId} (~${saved.estimatedCount} fish) — varsling is legally immediate`,
      );
      return saved;
    });
  }

  async close(
    tenantId: string,
    input: CloseEscapeIncidentInput,
    userId: string,
  ): Promise<EscapeIncident> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, EscapeIncident, tenantId);
      const incident = await repo.findOne({ where: { id: input.id, tenantId } });
      if (!incident) {
        throw new NotFoundException(`Escape incident ${input.id} not found`);
      }

      if (input.recoveredCount !== undefined) {
        incident.recoveredCount = input.recoveredCount;
      }
      incident.recoveryOngoing = false;
      incident.status = EscapeIncidentStatus.CLOSED;

      const saved = await repo.save(incident);
      this.logger.log(`Escape incident ${saved.id} closed by ${userId}`);
      return saved;
    });
  }
}
