/**
 * FeederAssignment — hangi ünitenin günlük dozunu hangi yemleyici(ler) dağıtır.
 *
 * WHAT: one row binds one unit (tank/pond/cage) to one FEEDING-category
 * Equipment row (the dosing machine) and records that feeder's SHARE of the
 * unit's daily dose. A unit may carry several feeders; the active shares for a
 * unit sum to exactly 100%.
 *
 * WHY it mirrors ProtocolAssignment rather than reusing `equipment_systems`:
 * grouping models peer membership ("these three machines form one system") and
 * a membership row has nowhere to carry a dose share. Feeding is a directed,
 * proportional relation — unit → feeder → share — so it needs its own
 * assignment, exactly as protocol→unit does.
 *
 * WHY the lifecycle ends rows instead of deleting them: a feeding record written
 * yesterday names the feeder that delivered it. Deleting the assignment would
 * strand that record's provenance. An ENDED row keeps `doseSharePercent` frozen
 * at the value that was in force, so "what share did feeder X have on 12 March"
 * stays answerable.
 *
 * Ünite kimliği ProtocolAssignment ile AYNIdır (Equipment.id / TankBatch.tankId
 * — legacy `tanks` satırları da olabildiği için unitId üzerinde FK YOKTUR).
 * `feederEquipmentId` ise HER ZAMAN bir Equipment satırıdır ve migration'da
 * gerçek bir FK ile bağlanır.
 *
 * @module FeedingProtocol/Entities
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { FeedingUnitType } from './protocol-assignment.entity';

export enum FeederAssignmentStatus {
  /** Yürürlükte — günlük doz bu satırın payına göre bölünür. */
  ACTIVE = 'active',
  /** Sonlandı — tarihsel kayıt; yemleme kayıtlarının izlenebilirliği bunu okur. */
  ENDED = 'ended',
}

registerEnumType(FeederAssignmentStatus, {
  name: 'FeederAssignmentStatus',
  description: 'Ünite-yemleyici atamasının yaşam döngüsü durumu',
});

@ObjectType('FeederAssignment')
@Entity('feeder_assignments')
// Aynı yemleyici bir ünitede iki kez aktif olamaz (pay ikiye bölünemez).
@Index(['tenantId', 'unitId', 'feederEquipmentId'], { unique: true, where: `"status" = 'active'` })
@Index(['tenantId', 'unitId', 'status'])
@Index(['tenantId', 'feederEquipmentId', 'status'])
@Index(['tenantId', 'siteId'])
export class FeederAssignment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  @Index()
  tenantId!: string;

  /** Equipment.id (ya da legacy Tank.id) — ProtocolAssignment.unitId ile aynı kimlik. */
  @Field(() => ID)
  @Column('uuid')
  unitId!: string;

  @Field(() => FeedingUnitType)
  @Column({ type: 'enum', enum: FeedingUnitType })
  unitType!: FeedingUnitType;

  /** Denormalize görünüm alanları (ProtocolAssignment emsali). */
  @Field()
  @Column({ length: 200 })
  unitName!: string;

  @Field()
  @Column({ length: 50 })
  unitCode!: string;

  /** Site-scoped okumalar indeksli olsun diye denormalize. */
  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  /** FEEDING kategorisindeki Equipment satırı — dozajlayıcı makinenin kendisi. */
  @Field(() => ID)
  @Column('uuid')
  feederEquipmentId!: string;

  @Field()
  @Column({ length: 200 })
  feederName!: string;

  @Field()
  @Column({ length: 50 })
  feederCode!: string;

  /**
   * Bu yemleyicinin günlük dozdaki payı (%). Bir ünitenin AKTİF paylarının
   * toplamı tam olarak 100 olmalıdır — bu kural veritabanında zorlanır
   * (feeder_assignment_unit_totals + commit-time constraint trigger).
   */
  @Field(() => Float)
  @Column({ type: 'numeric', precision: 6, scale: 3, transformer: new DecimalTransformer() })
  doseSharePercent!: number;

  @Field(() => FeederAssignmentStatus)
  @Column({
    type: 'enum',
    enum: FeederAssignmentStatus,
    default: FeederAssignmentStatus.ACTIVE,
  })
  status!: FeederAssignmentStatus;

  @Field()
  @Column({ type: 'date' })
  effectiveFrom!: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version!: number;
}
