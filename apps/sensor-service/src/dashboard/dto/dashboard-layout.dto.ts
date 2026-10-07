import { parsePresetKey } from '@aquaculture/shared-contracts';
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsBoolean,
  IsArray,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { WidgetConfig } from '../entities/dashboard-layout.entity';

/**
 * Every widget's `timeRange` must be a preset of the shared sensor-reading
 * time range. The widgets column is JSON, so without this a layout could store
 * a range no chart can resolve — which the dashboard used to turn silently
 * into one hour.
 */
@ValidatorConstraint({ name: 'widgetTimeRanges', async: false })
export class WidgetTimeRangesConstraint implements ValidatorConstraintInterface {
  validate(widgets: unknown): boolean {
    return (
      Array.isArray(widgets) &&
      widgets.every(
        (widget: unknown) =>
          typeof widget === 'object' &&
          widget !== null &&
          'timeRange' in widget &&
          parsePresetKey(widget.timeRange) !== null,
      )
    );
  }

  defaultMessage(): string {
    return 'every widget needs a timeRange that is a sensor-reading time-range preset';
  }
}

@InputType()
export class SaveDashboardLayoutInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  id?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON)
  @IsArray()
  @Validate(WidgetTimeRangesConstraint)
  widgets!: WidgetConfig[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  processBackground?: {
    processId: string | null;
    position: { x: number; y: number };
    scale: number;
    opacity: number;
  };

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  gridConfig?: {
    columns: number;
    cellHeight: number;
    margin: number;
  };

  @Field({ nullable: true })
  @IsOptional()
  gridVersion?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

@InputType()
export class CreateSystemDefaultLayoutInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON)
  @IsArray()
  @Validate(WidgetTimeRangesConstraint)
  widgets!: WidgetConfig[];
}
