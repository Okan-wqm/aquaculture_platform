/**
 * Ünite → yemleyici ataması GraphQL girdi tipleri.
 *
 * WHY the mutation is set-based (`SetUnitFeedersInput` carries the WHOLE feeder
 * list of one unit) rather than add-one/remove-one: a unit's shares must sum to
 * exactly 100, so "add a feeder" is never a standalone operation — it always
 * redistributes. Modelling the edit as a set makes the invariant statable in the
 * request itself, and makes the transient sub-100 state live inside one
 * transaction where the commit-time database constraint tolerates it.
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Bir ünitede aynı anda makul sayıda yemleyici olabilir; üst sınır kaza korumasıdır. */
export const MAX_FEEDERS_PER_UNIT = 12;

@InputType()
export class UnitFeederShareInput {
  /** FEEDING kategorisindeki Equipment satırı — dozajlayıcı makine. */
  @Field(() => ID)
  @IsUUID()
  feederEquipmentId!: string;

  /**
   * Bu yemleyicinin günlük dozdaki payı (%). Alan-bazlı doğrulama yalnız
   * aralığı görebilir; TOPLAMIN 100 olması hem handler'da hem de veritabanında
   * (feeder_assignment_unit_totals CHECK) zorlanır.
   */
  @Field(() => Float)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100)
  doseSharePercent!: number;
}

@InputType()
export class SetUnitFeedersInput {
  @Field(() => ID)
  @IsUUID()
  unitId!: string;

  /**
   * Ünitenin TAM yemleyici listesi. Boş liste = ünite elle yemleniyor; mevcut
   * tüm aktif atamalar sonlandırılır (satırlar silinmez).
   */
  @Field(() => [UnitFeederShareInput])
  @IsArray()
  @ArrayMaxSize(MAX_FEEDERS_PER_UNIT)
  @ValidateNested({ each: true })
  @Type(() => UnitFeederShareInput)
  feeders!: UnitFeederShareInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  effectiveFrom?: Date;
}
