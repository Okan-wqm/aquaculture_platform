import { InputType, Field, Int } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

@InputType()
export class UpdateWeatherSettingsInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  syncIntervalMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  forecastDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
