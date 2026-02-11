import { InputType, Field, Int } from '@nestjs/graphql';

@InputType()
export class UpdateWeatherSettingsInput {
  @Field(() => Int, { nullable: true })
  syncIntervalMinutes?: number;

  @Field(() => Int, { nullable: true })
  forecastDays?: number;

  @Field({ nullable: true })
  enabled?: boolean;
}
