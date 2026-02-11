import { ObjectType, Field, Float } from '@nestjs/graphql';

@ObjectType()
export class CurrentWeatherResponse {
  @Field()
  siteId!: string;

  @Field()
  observedAt!: Date;

  // Weather fields
  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  windSpeed?: number;

  @Field(() => Float, { nullable: true })
  windDirection?: number;

  @Field(() => Float, { nullable: true })
  windGusts?: number;

  @Field(() => Float, { nullable: true })
  precipitation?: number;

  @Field(() => Float, { nullable: true })
  cloudCover?: number;

  @Field(() => Float, { nullable: true })
  pressureMsl?: number;

  @Field(() => Float, { nullable: true })
  relativeHumidity?: number;

  // Marine fields
  @Field(() => Float, { nullable: true })
  waveHeight?: number;

  @Field(() => Float, { nullable: true })
  waveDirection?: number;

  @Field(() => Float, { nullable: true })
  wavePeriod?: number;

  @Field(() => Float, { nullable: true })
  swellWaveHeight?: number;

  @Field(() => Float, { nullable: true })
  seaSurfaceTemperature?: number;

  @Field({ nullable: true })
  fetchedAt?: Date;
}

@ObjectType()
export class WeatherSyncResult {
  @Field()
  success!: boolean;

  @Field()
  totalWeather!: number;

  @Field()
  totalMarine!: number;

  @Field()
  sites!: number;
}
