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
import { DataSource, EntityManager } from 'typeorm';
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
  AssignProtocolToBatchUnitsCommand,
  AssignProtocolToUnitCommand,
  UnassignProtocolCommand,
  UpdateProtocolAssignmentCommand,
} from '../commands/feeding-protocol-v2.commands';
import {
  FeedingProtocolStatus,
  FeedingProtocolV2,
} from '../entities/feeding-protocol-v2.entity';
import {
  FeedingUnitType,
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch, BatchType } from '../../batch/entities/batch.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';

// ============================================================================
// PAYLAŞILAN ÜNİTE-ATAMA ÇEKİRDEĞİ — tekil ve batch-toplu yolun TEK gövdesi
// ============================================================================

interface UnitAssignmentArgs {
  tenantId: string;
  userId: string;
  unitId: string;
  protocolId: string;
  /** Verilmezse ünitenin ekipman kategorisinden türetilir (FE eşlemesiyle aynı). */
  unitType?: FeedingUnitType;
  effectiveFrom?: Date;
  overrides?: ProtocolAssignment['overrides'];
  speciesMismatchReason?: string;
}

function assertOverrideFeedsExist(
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

/** Ekipman kategorisi → FeedingUnitType (AssignmentsTab eşlemesinin BE ikizi değil, SSoT'si: FE yalnız görsel seçim yapar). */
async function resolveUnitType(
  manager: EntityManager,
  equipmentTypeId: string | null | undefined,
): Promise<FeedingUnitType> {
  if (!equipmentTypeId) return FeedingUnitType.TANK;
  const equipmentType = await manager.findOne(EquipmentType, {
    where: { id: equipmentTypeId },
  });
  switch (equipmentType?.category) {
    case EquipmentCategory.POND:
      return FeedingUnitType.POND;
    case EquipmentCategory.CAGE:
      return FeedingUnitType.CAGE;
    default:
      return FeedingUnitType.TANK;
  }
}

/**
 * Tek ünitenin atama akışı — protokol çağıran tarafından doğrulanmış (ACTIVE)
 * gelir; ünite/site çözümü, tür uyumu, override doğrulaması, değiştirme
 * semantiği ve durable event BURADA yaşar (iki handler tek gövdeyi çağırır).
 */
async function performUnitAssignment(
  manager: EntityManager,
  outboxPublisher: OutboxPublisher,
  logger: Logger,
  protocol: FeedingProtocolV2,
  args: UnitAssignmentArgs,
): Promise<ProtocolAssignment> {
  const { tenantId, userId } = args;
  const assignmentRepo = tenantManagerRepo(manager, ProtocolAssignment, tenantId);

  // Ünite çözümü — tek tank/equipment lookup SSoT'si.
  const lookup = await findTankOrEquipmentWithManager(manager, args.unitId, tenantId);
  if (!lookup) {
    throw new NotFoundException(`Ünite bulunamadı: ${args.unitId}`);
  }
  const siteId = await resolveSiteIdFromDepartment(
    manager,
    lookup.equipment.departmentId,
    tenantId,
  );
  if (!siteId) {
    // SEC-HIGH-051 duruşu: site'sız ünite örtük izin DEĞİLDİR.
    throw new BadRequestException(
      `Ünitenin bağlı olduğu site çözülemedi (${args.unitId}) — atama fail-closed reddedildi`,
    );
  }

  // Tür uyumu + üretim-batch'i kontrolü (ünite doluysa).
  const tankBatch = await manager.findOne(TankBatch, {
    where: { tankId: args.unitId, tenantId },
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
        !args.speciesMismatchReason
      ) {
        throw new BadRequestException(
          'Protokol türü ünitedeki batch türüyle uyuşmuyor — bilinçli devam için speciesMismatchReason zorunlu',
        );
      }
    }
  }

  // fcrOverrides yalnız protokol bandlarındaki yemler için anlamlıdır.
  assertOverrideFeedsExist(protocol, args.overrides?.fcrOverrides?.map((o) => o.feedId));

  // Değiştirme semantiği: mevcut aktif atama tarihçeye iner (ENDED).
  const existingActive = await assignmentRepo.findOne({
    where: { tenantId, unitId: args.unitId, status: ProtocolAssignmentStatus.ACTIVE },
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
    unitId: args.unitId,
    unitType: args.unitType ?? (await resolveUnitType(manager, lookup.equipment.equipmentTypeId)),
    unitName: lookup.equipment.name ?? '',
    unitCode: lookup.equipment.code ?? '',
    siteId,
    protocolId: args.protocolId,
    status: ProtocolAssignmentStatus.ACTIVE,
    effectiveFrom: args.effectiveFrom ?? new Date(),
    overrides: args.overrides ?? {},
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
    speciesMismatchReason: args.speciesMismatchReason,
  };
  await outboxPublisher.enqueue(event, manager);

  logger.log(
    `Protocol ${protocol.name} assigned to unit ${saved.unitCode} (${saved.id})` +
      (existingActive ? ` replacing ${existingActive.id}` : ''),
  );
  return saved;
}

/** ACTIVE-protokol yükleme + doğrulama — her iki atama yolunun ortak ilk adımı. */
async function loadActiveProtocol(
  manager: EntityManager,
  tenantId: string,
  protocolId: string,
): Promise<FeedingProtocolV2> {
  const protocolRepo = tenantManagerRepo(manager, FeedingProtocolV2, tenantId);
  const protocol = await protocolRepo.findOne({
    where: { id: protocolId, tenantId, isDeleted: false },
  });
  if (!protocol) {
    throw new NotFoundException(`Protokol bulunamadı: ${protocolId}`);
  }
  if (protocol.status !== FeedingProtocolStatus.ACTIVE) {
    throw new BadRequestException(
      `Yalnız ACTIVE protokoller atanabilir (mevcut durum: ${protocol.status}). ` +
        `Migration DRAFT'ları önce operatör onayıyla aktive edilmeli.`,
    );
  }
  return protocol;
}

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
      const protocol = await loadActiveProtocol(manager, tenantId, input.protocolId);
      return performUnitAssignment(manager, this.outboxPublisher, this.logger, protocol, {
        tenantId,
        userId,
        unitId: input.unitId,
        protocolId: input.protocolId,
        unitType: input.unitType,
        effectiveFrom: input.effectiveFrom,
        overrides: input.overrides,
        speciesMismatchReason: input.speciesMismatchReason,
      });
    });
  }
}

@CommandHandler(AssignProtocolToBatchUnitsCommand)
export class AssignProtocolToBatchUnitsHandler
  implements ICommandHandler<AssignProtocolToBatchUnitsCommand, ProtocolAssignment[]>
{
  private readonly logger = new Logger(AssignProtocolToBatchUnitsHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Plan §1.2 kolaylık yolu: batch'in GÜNCEL ünitelerine (primary ya da
   * batchDetails payı — C-4 traceability sorgusuyla aynı üyelik tanımı) tek
   * transaction'da toplu atama. Üniteler unitId-artan sırayla işlenir
   * (deterministik kilit edinimi); her ünite tekil yolun AYNI çekirdeğinden
   * geçer — ikinci bir atama gövdesi yoktur.
   */
  async execute(command: AssignProtocolToBatchUnitsCommand): Promise<ProtocolAssignment[]> {
    const { batchId, protocolId, tenantId, userId, speciesMismatchReason } = command;

    return this.dataSource.transaction(async (manager) => {
      const batch = await manager.findOne(Batch, { where: { id: batchId, tenantId } });
      if (!batch) {
        throw new NotFoundException(`Batch bulunamadı: ${batchId}`);
      }

      const protocol = await loadActiveProtocol(manager, tenantId, protocolId);

      const unitRows: Array<{ unitId: string }> = await manager.query(
        `SELECT tb."tankId" AS "unitId"
           FROM "tank_batches" tb
          WHERE tb."tenantId" = $1
            AND (tb."primaryBatchId" = $2 OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) detail
              WHERE detail->>'batchId' = $2))
          ORDER BY tb."tankId" ASC`,
        [tenantId, batchId],
      );
      if (unitRows.length === 0) {
        throw new BadRequestException(
          `Batch hiçbir ünitede değil (${batchId}) — atanacak ünite yok`,
        );
      }

      const assignments: ProtocolAssignment[] = [];
      for (const { unitId } of unitRows) {
        assignments.push(
          await performUnitAssignment(manager, this.outboxPublisher, this.logger, protocol, {
            tenantId,
            userId,
            unitId,
            protocolId,
            speciesMismatchReason,
          }),
        );
      }
      this.logger.log(
        `Protocol ${protocol.name} assigned to ${assignments.length} unit(s) of batch ${batchId}`,
      );
      return assignments;
    });
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
