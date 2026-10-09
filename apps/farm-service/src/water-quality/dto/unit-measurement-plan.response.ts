import { Field, ObjectType } from '@nestjs/graphql';

import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

@ObjectType({ description: 'One parameter to record at a unit, and whether it is required there' })
export class UnitMeasurementPlanEntry {
  @Field(() => WaterQualityParameterConfig)
  parameter!: WaterQualityParameterConfig;

  @Field({ description: 'Whether a measurement at this unit must carry this parameter' })
  required!: boolean;
}

@ObjectType({ description: 'What to record at a unit: its plan, or every active parameter' })
export class UnitMeasurementPlan {
  @Field({ description: 'Whether the unit has a plan of its own' })
  planned!: boolean;

  @Field(() => [UnitMeasurementPlanEntry])
  entries!: UnitMeasurementPlanEntry[];
}
