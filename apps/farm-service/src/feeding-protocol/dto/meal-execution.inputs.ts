/**
 * Öğün kaydı/atlama GraphQL girdileri (Faz 5).
 *
 * `RecordMealFeedingInput` mobil idempotency zarfını (envelope) MİRAS ALIR ve
 * zarf ZORUNLUDUR (C-17): zarfsız komut MealExecutionService'te fail-closed
 * reddedilir — eski `recordDailyFeeding`'in legacy toleransı bu yola taşınmaz.
 * Girdi sınırları NFR tablosunun birebir kodudur (0 < kg <= 10000).
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

import { FeedingMethod } from '../../feeding/entities/feeding-record.entity';
import { MAX_FEED_KG, MIN_FEED_KG } from '../constants';

@InputType()
export class RecordMealFeedingInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(MIN_FEED_KG)
  @Max(MAX_FEED_KG)
  pourKg!: number;

  /** Operatör "öğün bitti" onayı — varyans + growth + kalan öğün recalc'ı. */
  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  finalize!: boolean;

  /**
   * FARM-MEDIUM-257: kayıtlı GraphQL enum'ı. Serbest `string` iken değer
   * `feeding_records."feedingMethod"` PG ENUM kolonuna cast ediliyordu ve
   * enum üyesi olmayan her giriş `22P02` ile ÖĞÜN KAYDININ TAMAMINI rollback
   * ettiriyordu. Artık şema kapıda reddediyor.
   */
  @Field(() => FeedingMethod, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod?: FeedingMethod;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

@InputType()
export class CorrectMealPourInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  pourIndex!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(MIN_FEED_KG)
  @Max(MAX_FEED_KG)
  correctedKg!: number;
}

/**
 * Kısmi beslenen öğünü DÖKÜM EKLEMEDEN kapatır (W8 — FARM-MEDIUM-269).
 * `recordMealFeeding` zarfıyla aynı idempotency disiplinine tabidir: mobil
 * çevrimdışı kuyruk aynı komutu iki kez drain edebilir.
 */
@InputType()
export class FinalizeMealInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;
}

@InputType()
export class SkipMealInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field()
  @IsString()
  @MaxLength(500)
  reason!: string;
}
