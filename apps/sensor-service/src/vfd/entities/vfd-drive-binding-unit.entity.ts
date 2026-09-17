/**
 * VfdDriveBindingUnit — a unit the drive's equipment currently serves.
 *
 * WHAT: rows exist ONLY when the driven equipment is a feeder and farm-service
 * attests that it has active feeder assignments. A drive on a pump or a blower
 * has none, and that is the right answer, not a missing one.
 *
 * WHY the served units are a table and not a column on the binding: a feeder can
 * legitimately serve more than one unit (a blower line feeding two cages), so
 * "the tank this drive feeds" is not always a single value. A column would have
 * to pick one, and picking one is exactly how a drive ends up dosing the wrong
 * container. Modelled as a set, the ambiguous case is representable, and
 * `VfdDriveBindingService` can refuse it instead of guessing.
 *
 * WHY the share is carried: the caller that splits a unit's dose needs to know
 * what portion this machine is responsible for. The authoritative copy stays in
 * farm-service `feeder_assignments`; this is the attested snapshot the drive acts
 * on, and it is replaced wholesale on every attestation.
 *
 * @module Vfd/Entities
 */
import { Entity, PrimaryColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { VfdDriveBinding } from './vfd-drive-binding.entity';

@ObjectType('VfdDriveBindingUnit', {
  description: 'A unit (tank/pond/cage) the driven equipment currently serves',
})
@Entity('vfd_drive_binding_units')
@Index(['tenantId', 'unitId'])
export class VfdDriveBindingUnit {
  @Field(() => ID)
  @PrimaryColumn({ type: 'uuid', name: 'vfd_device_id' })
  vfdDeviceId!: string;

  /** farm-service unit identity (`equipment.id`, or a legacy `tanks.id`). */
  @Field(() => ID)
  @PrimaryColumn({ type: 'uuid', name: 'unit_id' })
  unitId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'varchar', length: 16, name: 'unit_type' })
  unitType!: string;

  @Field()
  @Column({ type: 'varchar', length: 50, name: 'unit_code' })
  unitCode!: string;

  /** This equipment's share of the unit's daily dose (%), as attested. */
  @Field(() => Float)
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 3,
    name: 'dose_share_percent',
    transformer: new DecimalTransformer(),
  })
  doseSharePercent!: number;

  @ManyToOne(() => VfdDriveBinding, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vfd_device_id' })
  binding?: VfdDriveBinding;
}
