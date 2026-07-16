/**
 * ProtocolAssignment handler'ları — protokolün üniteye bağlanma yolu.
 *
 * Güvenlik/doğruluk kuralları:
 *  - Ünite kimliği Equipment.id; ad/kod/site mevcut tank-lookup SSoT'sinden
 *    çözülür (`findTankOrEquipmentWithManager` + `resolveSiteIdFromDepartment`),
 *    site'sız ünite fail-closed reddedilir (SEC-HIGH-051 duruşu).
 *  - Tür uyumu (D-13/plan §1.2): protokolün speciesId'si, ünitedeki birincil
 *    batch'in türüyle karşılaştırılır; uyumsuzluk yalnız açık gerekçeyle
 *    (speciesMismatchReason — audit'e yazılır) geçilebilir. Birincil batch
 *    PRODUCTION tipinde olmalıdır (temizlikçi balık ünitesine protokol atanamaz).
 *  - DRAFT/ARCHIVED protokole atama yapılamaz (migration draft'ları operatör
 *    onayı olmadan plan üretemez — K-14 kapısının yapısal yarısı).
 *  - fcrOverrides yalnız protokol bandlarında GEÇEN feedId'lere yazılabilir.
 *  - Aynı ünitede ikinci aktif atama partial unique index'e çarpar; handler
 *    yine de mevcut aktifi ENDED'e çevirip değiştirme semantiği sunar
 *    (assignment history korunur — traceability C-4 bunu okur).
 *  - Atama/pause/end aynı transaction'da durable event üretir (P-12 deseni).
 *
 * @module FeedingProtocol/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import type {
  FeedingProtocolAssignedEvent,
  FeedingProtocolAssignmentPausedEvent,
} from '@platform/event-contracts';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import {
  AssignProtocolToUnitCommand,
  UnassignProtocolCommand,
  UpdateProtocolAssignmentCommand,
} from '../commands/feeding-protocol-v2.commands';
import {
  FeedingProtocolStatus,
  FeedingProtocolV2,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch, BatchType } from '../../batch/entities/batch.entity';

@CommandHandler(AssignProtocolToUnitCommand)
export class AssignProtocolToUnitHandler
  implements ICommandHandler<AssignProtocolToUnitCommand, ProtocolAssignment>
{
  private readonly logger = new Logger(AssignProtocolToUnitHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: AssignProtocolToUnitCommand): Promise<ProtocolAssignment> {
    const { input, tenantId, userId } = command;

    return this.dataSource.transaction(async (manager) => {
      const protocolRepo = tenantManagerRepo(manager, FeedingProtocolV2, tenantId);
      const assignmentRepo = tenantManagerRepo(manager, ProtocolAssignment, tenantId);

      const protocol = await protocolRepo.findOne({
        where: { id: input.protocolId, tenantId, isDeleted: false },
      });
      if (!protocol) {
        throw new NotFoundException(`Protokol bulunamadı: ${input.protocolId}`);
      }
      if (protocol.status !== FeedingProtocolStatus.ACTIVE) {
        throw new BadRequestException(
          `Yalnız ACTIVE protokoller atanabilir (mevcut durum: ${protocol.status}). ` +
            `Migration DRAFT'ları önce operatör onayıyla aktive edilmeli.`,
        );
      }

      // Ünite çözümü — tek tank/equipment lookup SSoT'si.
      const lookup = await findTankOrEquipmentWithManager(manager, input.unitId, tenantId);
      if (!lookup) {
        throw new NotFoundException(`Ünite bulunamadı: ${input.unitId}`);
      }
      const siteId = await resolveSiteIdFromDepartment(
        manager,
        lookup.equipment.departmentId,
        tenantId,
      );
      if (!siteId) {
        // SEC-HIGH-051 duruşu: site'sız ünite örtük izin DEĞİLDİR.
        throw new BadRequestException(
          `Ünitenin bağlı olduğu site çözülemedi (${input.unitId}) — atama fail-closed reddedildi`,
        );
      }

      // Tür uyumu + üretim-batch'i kontrolü (ünite doluysa).
      const tankBatch = await manager.findOne(TankBatch, {
        where: { tankId: input.unitId, tenantId },
      });
      if (tankBatch?.primaryBatchId) {
        const batch = await manager.findOne(Batch, {
          where: { id: tankBatch.primaryBatchId, tenantId },
        });
        if (batch) {
          if (batch.batchType !== BatchType.PRODUCTION) {
            throw new BadRequestException(
              'Protokol yalnız PRODUCTION batch taşıyan ünitelere atanabilir (temizlikçi balık yemlemesi kapsam dışı — ayrı izlenen iş)',
            );
          }
          if (
            protocol.speciesId &&
            batch.speciesId !== protocol.speciesId &&
            !input.speciesMismatchReason
          ) {
            throw new BadRequestException(
              'Protokol türü ünitedeki batch türüyle uyuşmuyor — bilinçli devam için speciesMismatchReason zorunlu',
            );
          }
        }
      }

      // fcrOverrides yalnız protokol bandlarındaki yemler için anlamlıdır.
      this.assertOverrideFeedsExist(protocol, input.overrides?.fcrOverrides?.map((o) => o.feedId));

      // Değiştirme semantiği: mevcut aktif atama tarihçeye iner (ENDED).
      const existingActive = await assignmentRepo.findOne({
        where: { tenantId, unitId: input.unitId, status: ProtocolAssignmentStatus.ACTIVE },
        lock: { mode: 'pessimistic_write' },
      });
      if (existingActive) {
        existingActive.status = ProtocolAssignmentStatus.ENDED;
        existingActive.endedAt = new Date();
        existingActive.updatedBy = userId;
        await assignmentRepo.save(existingActive);
      }

      const assignment = assignmentRepo.create({
        tenantId,
        unitId: input.unitId,
        unitType: input.unitType,
        unitName: lookup.equipment.name ?? '',
        unitCode: lookup.equipment.code ?? '',
        siteId,
        protocolId: input.protocolId,
        status: ProtocolAssignmentStatus.ACTIVE,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        overrides: input.overrides ?? {},
        suspensions: [],
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await assignmentRepo.save(assignment);

      const event: FeedingProtocolAssignedEvent = {
        ...createBaseEvent<FeedingProtocolAssignedEvent>('FeedingProtocolAssigned', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'ProtocolAssignment',
        }),
        userId,
        assignmentId: saved.id,
        unitId: saved.unitId,
        unitType: saved.unitType,
        unitCode: saved.unitCode,
        siteId,
        protocolId: saved.protocolId,
        protocolName: protocol.name,
        replacedAssignmentId: existingActive?.id,
        speciesMismatchReason: input.speciesMismatchReason,
      };
      await this.outboxPublisher.enqueue(event, manager);

      this.logger.log(
        `Protocol ${protocol.name} assigned to unit ${saved.unitCode} (${saved.id})` +
          (existingActive ? ` replacing ${existingActive.id}` : ''),
      );
      return saved;
    });
  }

  private assertOverrideFeedsExist(
    protocol: FeedingProtocolV2,
    overrideFeedIds: string[] | undefined,
  ): void {
    if (!overrideFeedIds?.length) return;
    const bandFeedIds = new Set(protocol.bands.map((band) => band.feedId));
    const unknown = overrideFeedIds.filter((feedId) => !bandFeedIds.has(feedId));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `fcrOverrides yalnız protokol bandlarındaki yemler için tanımlanabilir; bilinmeyen: ${unknown.join(', ')}`,
      );
    }
  }
}

@CommandHandler(UpdateProtocolAssignmentCommand)
export class UpdateProtocolAssignmentHandler
  implements ICommandHandler<UpdateProtocolAssignmentCommand, ProtocolAssignment>
{
  private readonly logger = new Logger(UpdateProtocolAssignmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateProtocolAssignmentCommand): Promise<ProtocolAssignment> {
    const { input, tenantId, userId } = command;

    return this.dataSource.transaction(async (manager) => {
      const assignmentRepo = tenantManagerRepo(manager, ProtocolAssignment, tenantId);
      const protocolRepo = tenantManagerRepo(manager, FeedingProtocolV2, tenantId);

      const assignment = await assignmentRepo.findOne({
        where: { id: input.assignmentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!assignment) {
        throw new NotFoundException(`Atama bulunamadı: ${input.assignmentId}`);
      }
      if (assignment.status === ProtocolAssignmentStatus.ENDED) {
        throw new BadRequestException('Sonlanmış atama güncellenemez — yeni atama oluşturun');
      }

      if (input.overrides?.fcrOverrides?.length) {
        const protocol = await protocolRepo.findOne({
          where: { id: assignment.protocolId, tenantId },
        });
        const bandFeedIds = new Set(protocol?.bands.map((band) => band.feedId) ?? []);
        const unknown = input.overrides.fcrOverrides
          .map((o) => o.feedId)
          .filter((feedId) => !bandFeedIds.has(feedId));
        if (unknown.length > 0) {
          throw new BadRequestException(
            `fcrOverrides yalnız protokol bandlarındaki yemler için tanımlanabilir; bilinmeyen: ${unknown.join(', ')}`,
          );
        }
      }

      for (const suspension of input.suspensions ?? []) {
        if (suspension.to < suspension.from) {
          throw new BadRequestException('Suspension penceresi: to >= from olmalı');
        }
        if (suspension.type === 'medication' && !suspension.medicatedFeedId) {
          throw new BadRequestException('medication penceresi medicatedFeedId gerektirir');
        }
      }

      const previousStatus = assignment.status;
      if (input.overrides !== undefined) assignment.overrides = input.overrides;
      if (input.suspensions !== undefined) {
        assignment.suspensions = input.suspensions.map((s) => ({
          from: s.from.toISOString().slice(0, 10),
          to: s.to.toISOString().slice(0, 10),
          type: s.type,
          reason: s.reason,
          medicatedFeedId: s.medicatedFeedId,
        }));
      }
      if (input.status !== undefined) {
        assignment.status =
          input.status === 'active'
            ? ProtocolAssignmentStatus.ACTIVE
            : ProtocolAssignmentStatus.PAUSED;
      }
      assignment.updatedBy = userId;
      const saved = await assignmentRepo.save(assignment);

      if (
        previousStatus === ProtocolAssignmentStatus.ACTIVE &&
        saved.status === ProtocolAssignmentStatus.PAUSED
      ) {
        const paused: FeedingProtocolAssignmentPausedEvent = {
          ...createBaseEvent<FeedingProtocolAssignmentPausedEvent>(
            'FeedingProtocolAssignmentPaused',
            tenantId,
            { aggregateId: saved.id, aggregateType: 'ProtocolAssignment' },
          ),
          userId,
          assignmentId: saved.id,
          unitId: saved.unitId,
          unitCode: saved.unitCode,
          protocolId: saved.protocolId,
          reason: 'operator_paused',
        };
        await this.outboxPublisher.enqueue(paused, manager);
      }

      this.logger.log(`Protocol assignment updated: ${saved.id} (status=${saved.status})`);
      return saved;
    });
  }
}

@CommandHandler(UnassignProtocolCommand)
export class UnassignProtocolHandler
  implements ICommandHandler<UnassignProtocolCommand, ProtocolAssignment>
{
  private readonly logger = new Logger(UnassignProtocolHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UnassignProtocolCommand): Promise<ProtocolAssignment> {
    const { assignmentId, tenantId, userId } = command;

    return this.dataSource.transaction(async (manager) => {
      const assignmentRepo = tenantManagerRepo(manager, ProtocolAssignment, tenantId);
      const assignment = await assignmentRepo.findOne({
        where: { id: assignmentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!assignment) {
        throw new NotFoundException(`Atama bulunamadı: ${assignmentId}`);
      }
      assignment.status = ProtocolAssignmentStatus.ENDED;
      assignment.endedAt = new Date();
      assignment.updatedBy = userId;
      const saved = await assignmentRepo.save(assignment);
      this.logger.log(`Protocol assignment ended: ${assignmentId}`);
      return saved;
    });
  }
}
