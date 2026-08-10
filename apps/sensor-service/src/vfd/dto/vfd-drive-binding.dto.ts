/**
 * GraphQL shape of "which unit does this drive serve?".
 *
 * WHY an explicit outcome instead of a nullable unit: "no unit" has four different
 * causes and they demand four different operator responses — bind the drive, wait
 * for (or chase) the owning service, note that a pump has no unit at all, or fix a
 * feeder whose assignments no longer cover it. A nullable field would collapse all
 * four into "empty", which is the same silence that let a mistyped tank id sit on
 * a drive unnoticed. The server-side API is a discriminated union
 * (`DrivenUnitResolution`); this is its faithful projection onto GraphQL.
 *
 * @module Vfd/Dto
 */
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';

import { VfdDriveBindingUnit } from '../entities/vfd-drive-binding-unit.entity';

export enum VfdDrivenUnitOutcome {
  /** No equipment recorded for this drive. It cannot be commanded. */
  UNBOUND = 'unbound',
  /** Bound, but the owning service has not confirmed the equipment. Cannot be commanded. */
  UNATTESTED = 'unattested',
  /** Confirmed once, but the confirmation aged out. Cannot be commanded. */
  EXPIRED = 'expired',
  /** A pump, a blower, …: it serves no unit, and that is the answer. */
  NOT_A_FEEDER = 'not_a_feeder',
  /** A feeder whose assignments have all ended — it currently feeds nothing. */
  FEEDER_WITHOUT_UNIT = 'feeder_without_unit',
  /** A feeder serving several units: no single unit exists, and none is guessed. */
  FEEDER_AMBIGUOUS = 'feeder_ambiguous',
  /** Exactly one unit — the only outcome where `units` has a single entry. */
  FEEDER_UNIT = 'feeder_unit',
}

registerEnumType(VfdDrivenUnitOutcome, {
  name: 'VfdDrivenUnitOutcome',
  description: 'Sürücünün hizmet ettiği ünite sorusunun kapalı küme cevabı',
});

@ObjectType('VfdDrivenUnitResolution', {
  description: 'What unit (if any) follows from the equipment this drive turns',
})
export class VfdDrivenUnitResolutionDto {
  @Field(() => VfdDrivenUnitOutcome)
  outcome!: VfdDrivenUnitOutcome;

  @Field(() => ID, { nullable: true })
  drivenEquipmentId?: string;

  /** `equipment_types.category` as attested — present once the binding is attested. */
  @Field({ nullable: true })
  equipmentCategory?: string;

  /**
   * Zero entries for every outcome except FEEDER_UNIT (exactly one) and
   * FEEDER_AMBIGUOUS (more than one). Reading `units[0]` without reading
   * `outcome` first is the bug this type exists to make visible.
   */
  @Field(() => [VfdDriveBindingUnit])
  units!: VfdDriveBindingUnit[];
}
