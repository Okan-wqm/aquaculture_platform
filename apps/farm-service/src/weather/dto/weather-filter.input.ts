import { InputType, Field } from '@nestjs/graphql';
import { WeatherDataType } from '../entities/weather-observation.entity';

@InputType()
export class WeatherFilterInput {
  @Field({ nullable: true })
  from?: Date;

  @Field({ nullable: true })
  to?: Date;

  @Field(() => WeatherDataType, { nullable: true })
  dataType?: WeatherDataType;
}
