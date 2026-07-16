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
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

@InputType()
export class RecordMealFeedingInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  @Max(10000)
  pourKg!: number;

  /** Operatör "öğün bitti" onayı — varyans + growth + kalan öğün recalc'ı. */
  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  finalize!: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  feedingMethod?: string;

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
  @Min(0.001)
  @Max(10000)
  correctedKg!: number;
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
