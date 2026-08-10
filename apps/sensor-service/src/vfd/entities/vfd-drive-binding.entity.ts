/**
 * VfdDriveBinding — a drive and the equipment it DRIVES.
 *
 * WHAT: one row per VFD, naming the farm `equipment.id` this drive actuates, and
 * carrying what the owner of that equipment last said about it. The binding is
 * GENERIC on purpose: a VFD turns a feeder, a water pump, a blower, or any other
 * motorised equipment. Nothing here assumes a feeder.
 *
 * WHY it is a row and not a column on `vfd_devices`: the binding has a lifecycle
 * of its own. It is asserted by an operator, then attested by farm-service, then
 * kept current by farm-service's own lifecycle events, and it can lose validity
 * without the drive itself changing at all. A column could hold the id but has
 * nowhere to hold "and this is what its owner says it is, as of when".
 *
 * WHY the attested fields are stored here rather than read across the service
 * boundary on demand: this is the command path of an actuator. A synchronous read
 * would make a farm-service outage into "no fish are fed"; a cached id with no
 * attestation would make a deleted equipment row into "the drive spins anyway".
 * Holding the owner's last answer, and refusing to act without a fresh one, is the
 * only shape that fails in the safe direction.
 *
 * @module Vfd/Entities
 */
import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';

/**
 * What the equipment's owner last said about this binding.
 *
 * Only `ATTESTED` may actuate. The other three are refusals with a reason, and
 * they are deliberately distinct: "we have not asked yet" is an operational
 * condition that heals itself, while "that equipment does not exist" is a
 * commissioning error somebody has to fix.
 */
export enum VfdDriveBindingState {
  /** Asserted by an operator; the owner has not answered yet. Cannot actuate. */
  PENDING = 'pending',
  /** The owner confirmed the equipment; `attestedAt` says when. */
  ATTESTED = 'attested',
  /** The owner has no such equipment (never existed, or was deleted). */
  UNKNOWN_EQUIPMENT = 'unknown_equipment',
  /** The equipment exists but is out of service. */
  INACTIVE_EQUIPMENT = 'inactive_equipment',
}

registerEnumType(VfdDriveBindingState, {
  name: 'VfdDriveBindingState',
  description: 'Sürücü–ekipman bağının, ekipman sahibi tarafından tasdik durumu',
});

@ObjectType('VfdDriveBinding', {
  description: 'The equipment a VFD drives, as attested by the service that owns it',
})
@Entity('vfd_drive_bindings')
@Index(['tenantId', 'drivenEquipmentId'])
@Index(['tenantId', 'state'])
export class VfdDriveBinding {
  /**
   * `vfd_devices.id`. The primary key IS the device id — a drive turns one shaft,
   * so it drives exactly one piece of equipment, and a second binding row for the
   * same drive is unrepresentable rather than merely discouraged.
   */
  @Field(() => ID)
  @PrimaryColumn({ type: 'uuid', name: 'vfd_device_id' })
  vfdDeviceId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  /** farm-service `equipment.id` — cross-service soft reference (see class doc). */
  @Field(() => ID)
  @Column({ type: 'uuid', name: 'driven_equipment_id' })
  drivenEquipmentId!: string;

  @Field(() => VfdDriveBindingState)
  @Column({
    type: 'varchar',
    length: 32,
    default: VfdDriveBindingState.PENDING,
  })
  state!: VfdDriveBindingState;

  /**
   * `equipment_types.category` as attested (`feeding`, `pump`, `aeration`, …).
   * Null until attested. This is what separates "drives a feeder, so a unit is
   * meaningful" from "drives a pump, so asking for a unit is meaningless".
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, name: 'equipment_category', nullable: true })
  equipmentCategory?: string;

  /** Denormalised for display, the same discipline FeederAssignment uses. */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, name: 'equipment_code', nullable: true })
  equipmentCode?: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 200, name: 'equipment_name', nullable: true })
  equipmentName?: string;

  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'site_id', nullable: true })
  siteId?: string;

  /** When the drive last asked. Rate-limits re-asking; never null. */
  @Field()
  @Column({ type: 'timestamp with time zone', name: 'requested_at' })
  requestedAt!: Date;

  /**
   * When the owner last answered. Null while PENDING. The age of this stamp is
   * the whole residual risk of a cross-service binding, so it is stored rather
   * than inferred: `VfdDriveBindingService` refuses to actuate on an answer older
   * than `ATTESTATION_MAX_AGE_MS` and re-asks well before that.
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'attested_at', nullable: true })
  attestedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone', name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamp with time zone', name: 'updated_at' })
  updatedAt!: Date;

  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'bound_by', nullable: true })
  boundBy?: string;
}
