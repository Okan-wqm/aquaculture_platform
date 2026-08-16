/**
 * Öğün kaydı/atlama GraphQL girdileri (Faz 5).
 *
 * `RecordMealFeedingInput` mobil idempotency zarfını (envelope) MİRAS ALIR ve
 * zarf ZORUNLUDUR (C-17): zarfsız komut central operation port'ta fail-closed
 * reddedilir — eski `recordDailyFeeding`'in legacy toleransı bu yola taşınmaz.
 * Miktar sınırları versioned feeding-contracts politikasının DTO izdüşümüdür.
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RequiredMobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { FEEDING_MEAL_QUANTITY_POLICY_V1 } from '@aquaculture/feeding-contracts';

import { FeedingMethod } from '../../feeding/entities/feeding-record.entity';

@InputType()
export class RecordMealFeedingInput extends RequiredMobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field(() => Float)
  @IsNumber({ maxDecimalPlaces: FEEDING_MEAL_QUANTITY_POLICY_V1.decimalPlaces })
  @Min(FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg)
  @Max(FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg)
  pourKg!: number;

  /** Operatör "öğün bitti" onayı — varyans + growth + kalan öğün recalc'ı. */
  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  finalize!: boolean;

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
  operationRequestId!: string;

  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  pourIndex!: number;

  @Field(() => Float)
  @IsNumber({ maxDecimalPlaces: FEEDING_MEAL_QUANTITY_POLICY_V1.decimalPlaces })
  @Min(FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg)
  @Max(FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg)
  correctedKg!: number;
}

/** Closes a partially-fed meal without inventing another pour or stock movement. */
@InputType()
export class FinalizeMealInput {
  @Field(() => ID)
  @IsUUID()
  operationRequestId!: string;

  @Field(() => ID)
  @IsUUID()
  mealId!: string;
}

@InputType()
export class SkipMealInput {
  @Field(() => ID)
  @IsUUID()
  operationRequestId!: string;

  @Field(() => ID)
  @IsUUID()
  mealId!: string;

  @Field()
  @IsString()
  @MaxLength(500)
  reason!: string;
}
