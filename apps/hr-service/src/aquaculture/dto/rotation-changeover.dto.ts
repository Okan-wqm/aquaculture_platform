import { ObjectType, Field, ID } from '@nestjs/graphql';

/**
 * A single crew movement on a changeover day — either an employee going
 * offshore (rotation starts that day) or returning onshore (rotation ends that
 * day). `transportMethod` is the relevant transport leg's method, when known.
 */
@ObjectType()
export class ChangeoverMovement {
  @Field(() => ID)
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field()
  workAreaName!: string;

  @Field({ nullable: true })
  transportMethod?: string;

  @Field(() => ID)
  rotationId!: string;
}

/**
 * All crew movements grouped by changeover date within the queried window.
 * `goingOffshore` = rotations whose startDate falls on the day;
 * `returningOnshore` = rotations whose endDate falls on the day.
 */
@ObjectType()
export class RotationChangeoverDay {
  @Field()
  date!: string;

  @Field(() => [ChangeoverMovement])
  goingOffshore!: ChangeoverMovement[];

  @Field(() => [ChangeoverMovement])
  returningOnshore!: ChangeoverMovement[];
}
