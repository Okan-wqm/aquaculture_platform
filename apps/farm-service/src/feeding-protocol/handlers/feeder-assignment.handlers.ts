/**
 * Ünite → yemleyici atama handler'ı.
 *
 * Kurallar (ProtocolAssignment disiplininin aynası):
 *  - Ünite kimliği Equipment.id (legacy Tank satırı da olabilir); ad/kod/site
 *    mevcut tank-lookup SSoT'sinden çözülür ve site'sız ünite fail-closed
 *    reddedilir (SEC-HIGH-051 duruşu).
 *  - Yemleyici HER ZAMAN FEEDING kategorisinde bir Equipment satırıdır. Bu
 *    kimlik kararı burada da, veritabanında da (FK_fa_feeder_equipment)
 *    zorlanır: bir SubEquipment id'si buraya yazılamaz.
 *  - Payların toplamı tam 100 olmalıdır (ya da liste boş olmalıdır). Handler bu
 *    kuralı operatöre okunur bir mesajla söyler; NİHAİ garanti veritabanındadır
 *    (feeder_assignment_unit_totals CHECK + commit-time constraint trigger), çünkü
 *    servis katmanını atlayan her yazıcı da bu kurala uymak zorundadır.
 *  - Değişiklik semantiği FARK tabanlıdır: dokunulmayan yemleyici satırı olduğu
 *    gibi kalır, kaldırılan ya da payı değişen satır ENDED'e iner ve yerine yeni
 *    bir kuşak satırı yazılır. Satır SİLİNMEZ — geçmiş yemleme kayıtlarının
 *    "hangi yemleyici, o gün hangi payla" sorusu cevaplanabilir kalsın.
 *
 * @module FeedingProtocol/Handlers
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { UnitFeederAssignmentsChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DataSource, EntityManager } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { SetUnitFeedersCommand } from '../commands/feeder-assignment.commands';
import { UnitFeederShareInput } from '../dto/feeder-assignment.inputs';
import { FeederAssignment, FeederAssignmentStatus } from '../entities/feeder-assignment.entity';
import { resolveUnitType } from '../utils/unit-type.util';

/**
 * Pay toplamı karşılaştırması TAM SAYI üzerinden yapılır (binde-bir çözünürlük):
 * 33.333 + 33.333 + 33.334 kayan noktada 100'e eşit çıkmayabilir, ama
 * 33333 + 33333 + 33334 = 100000 kesindir. Veritabanındaki `numeric` karşılığı
 * da tam aritmetiktir, yani iki kapı aynı yargıyı verir.
 */
const SHARE_SCALE = 1000;
const FULL_DOSE_UNITS = 100 * SHARE_SCALE;

function shareUnits(sharePercent: number): number {
  return Math.round(sharePercent * SHARE_SCALE);
}

function assertSharesAreWellFormed(feeders: readonly UnitFeederShareInput[]): void {
  if (feeders.length === 0) {
    return; // Elle yemlenen ünite — tüm aktif atamalar sonlandırılır.
  }

  const seen = new Set<string>();
  for (const feeder of feeders) {
    if (seen.has(feeder.feederEquipmentId)) {
      throw new BadRequestException(
        `Aynı yemleyici bir ünitede iki kez tanımlanamaz: ${feeder.feederEquipmentId}`,
      );
    }
    seen.add(feeder.feederEquipmentId);
  }

  const total = feeders.reduce((sum, feeder) => sum + shareUnits(feeder.doseSharePercent), 0);
  if (total !== FULL_DOSE_UNITS) {
    throw new BadRequestException(
      `Ünitenin yemleyici payları toplamı %${(total / SHARE_SCALE).toFixed(3)} — tam olarak %100 olmalı. ` +
        `Eksik toplam her gün sessizce eksik yemleme demektir.`,
    );
  }
}

/** Yemleyici kimliğinin tek yorumu: FEEDING kategorisinde bir Equipment satırı. */
async function loadFeederEquipment(
  manager: EntityManager,
  tenantId: string,
  feederEquipmentId: string,
): Promise<Equipment> {
  const equipmentRepo = tenantManagerRepo(manager, Equipment, tenantId);
  const feeder = await equipmentRepo.findOne({
    where: { id: feederEquipmentId, tenantId, isDeleted: false },
  });
  if (!feeder) {
    throw new NotFoundException(`Yemleyici ekipman bulunamadı: ${feederEquipmentId}`);
  }
  if (!feeder.isActive) {
    throw new BadRequestException(`Yemleyici ekipman pasif: ${feeder.code}`);
  }

  const equipmentType = feeder.equipmentTypeId
    ? await manager.findOne(EquipmentType, { where: { id: feeder.equipmentTypeId } })
    : null;
  if (equipmentType?.category !== EquipmentCategory.FEEDING) {
    throw new BadRequestException(
      `"${feeder.code}" bir yemleyici değil (ekipman kategorisi: ${equipmentType?.category ?? 'tanımsız'}). ` +
        `Yemleyici, FEEDING kategorisindeki bir ekipman satırıdır — kalibrasyonu da o satırda yaşar.`,
    );
  }

  return feeder;
}

@CommandHandler(SetUnitFeedersCommand)
export class SetUnitFeedersHandler
  implements ICommandHandler<SetUnitFeedersCommand, FeederAssignment[]>
{
  private readonly logger = new Logger(SetUnitFeedersHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: SetUnitFeedersCommand): Promise<FeederAssignment[]> {
    const { input, tenantId, userId } = command;

    assertSharesAreWellFormed(input.feeders);

    // WHY one transaction for the whole set: adding a second feeder necessarily
    // passes through a state where the shares do not sum to 100. The
    // constraint trigger judges the state at COMMIT, so the intermediate state
    // is legal only while it stays inside this boundary.
    return this.dataSource.transaction(async (manager) => {
      const assignmentRepo = tenantManagerRepo(manager, FeederAssignment, tenantId);

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

      const unitType = await resolveUnitType(manager, lookup.equipment.equipmentTypeId);
      const effectiveFrom = input.effectiveFrom ?? new Date();
      const now = new Date();

      const existingActive = await assignmentRepo.find({
        where: { tenantId, unitId: input.unitId, status: FeederAssignmentStatus.ACTIVE },
        order: { feederEquipmentId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const existingByFeeder = new Map(
        existingActive.map((row) => [row.feederEquipmentId, row] as const),
      );

      const desiredByFeeder = new Map(
        input.feeders.map((feeder) => [feeder.feederEquipmentId, feeder] as const),
      );

      // (1) Kaldırılan ya da payı değişen satırlar tarihçeye iner.
      const endedIds: string[] = [];
      for (const row of existingActive) {
        const desired = desiredByFeeder.get(row.feederEquipmentId);
        const unchanged =
          desired !== undefined &&
          shareUnits(desired.doseSharePercent) === shareUnits(row.doseSharePercent);
        if (unchanged) continue;

        row.status = FeederAssignmentStatus.ENDED;
        row.endedAt = now;
        row.updatedBy = userId;
        await assignmentRepo.save(row);
        endedIds.push(row.id);
      }

      // (2) Yeni ya da payı değişen yemleyiciler için yeni kuşak satırı.
      const created: FeederAssignment[] = [];
      for (const feeder of input.feeders) {
        const existing = existingByFeeder.get(feeder.feederEquipmentId);
        if (
          existing &&
          shareUnits(existing.doseSharePercent) === shareUnits(feeder.doseSharePercent)
        ) {
          continue;
        }

        const feederEquipment = await loadFeederEquipment(
          manager,
          tenantId,
          feeder.feederEquipmentId,
        );

        const assignment = assignmentRepo.create({
          tenantId,
          unitId: input.unitId,
          unitType,
          unitName: lookup.equipment.name ?? '',
          unitCode: lookup.equipment.code ?? '',
          siteId,
          feederEquipmentId: feederEquipment.id,
          feederName: feederEquipment.name,
          feederCode: feederEquipment.code,
          doseSharePercent: feeder.doseSharePercent,
          status: FeederAssignmentStatus.ACTIVE,
          effectiveFrom,
          createdBy: userId,
          updatedBy: userId,
        });
        created.push(await assignmentRepo.save(assignment));
      }

      const activeRows = await assignmentRepo.find({
        where: { tenantId, unitId: input.unitId, status: FeederAssignmentStatus.ACTIVE },
        order: { doseSharePercent: 'DESC', feederCode: 'ASC' },
      });

      const event: UnitFeederAssignmentsChangedEvent = {
        ...createBaseEvent<UnitFeederAssignmentsChangedEvent>(
          'UnitFeederAssignmentsChanged',
          tenantId,
          { aggregateId: input.unitId, aggregateType: 'FeederAssignment' },
        ),
        userId,
        unitId: input.unitId,
        unitType,
        unitCode: lookup.equipment.code ?? '',
        siteId,
        feeders: activeRows.map((row) => ({
          assignmentId: row.id,
          feederEquipmentId: row.feederEquipmentId,
          feederCode: row.feederCode,
          doseSharePercent: row.doseSharePercent,
        })),
        endedAssignmentIds: endedIds,
      };
      await this.outboxPublisher.enqueue(event, manager, { aggregateId: input.unitId });

      this.logger.log(
        `Unit ${lookup.equipment.code ?? input.unitId} feeder set updated: ` +
          `${activeRows.length} active, ${created.length} new generation row(s), ${endedIds.length} ended`,
      );
      return activeRows;
    });
  }
}
