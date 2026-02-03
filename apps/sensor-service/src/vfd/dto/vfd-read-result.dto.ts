import { ObjectType, Field, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * VFD Read Result DTO
 * GraphQL ObjectType for VFD parameter reading results
 */
@ObjectType({ description: 'Result of reading VFD parameters from device' })
export class VfdReadResultDto {
  @Field(() => GraphQLJSON, { description: 'VFD parameters read from device' })
  parameters!: Record<string, number | undefined>;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Parsed status bits' })
  statusBits?: Record<string, boolean | string | undefined>;

  @Field(() => GraphQLJSON, { description: 'Raw register values' })
  rawValues!: Record<string, number>;

  @Field({ description: 'Timestamp of the reading' })
  timestamp!: Date;

  @Field(() => Int, { description: 'Communication latency in milliseconds' })
  latencyMs!: number;

  @Field(() => [String], { nullable: true, description: 'Any errors during reading' })
  errors?: string[];
}
