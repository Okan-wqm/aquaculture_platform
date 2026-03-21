import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';

@ObjectType()
export class CrewAssignment {
  @Field(() => ID)
  workAreaId!: string;

  @Field(() => String)
  workAreaName!: string;

  @Field(() => [String])
  assignedEmployeeIds!: string[];

  @Field(() => Int)
  currentCount!: number;

  @Field(() => Int)
  maxCapacity!: number;

  @Field(() => Float)
  occupancyRate!: number;
}
