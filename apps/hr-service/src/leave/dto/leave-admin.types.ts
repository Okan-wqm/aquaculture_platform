import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

import { LeaveRequestStatus } from '../entities/leave-request.entity';

/**
 * Result of the carryOverLeaveBalances mutation.
 *
 * Mirrors the FE CARRY_OVER_LEAVE_BALANCES selection set
 * (web/modules/hr-module/src/graphql/leave.operations.ts):
 *   { processed, successful, failed, errors }.
 */
@ObjectType()
export class CarryOverLeaveBalancesResult {
  @Field(() => Int, { description: 'Number of source-year balances examined' })
  processed!: number;

  @Field(() => Int, { description: 'Number of balances carried over into the target year' })
  successful!: number;

  @Field(() => Int, { description: 'Number of balances that failed to carry over' })
  failed!: number;

  @Field(() => [String], { description: 'Human-readable error messages for failed carry-overs' })
  errors!: string[];
}

/**
 * A leave request that overlaps a proposed range — the conflicting subset
 * surfaced by the checkLeaveOverlap query.
 */
@ObjectType()
export class OverlappingLeaveRequest {
  @Field()
  id!: string;

  @Field()
  requestNumber!: string;

  @Field()
  startDate!: string;

  @Field()
  endDate!: string;

  @Field(() => LeaveRequestStatus)
  status!: LeaveRequestStatus;
}

/**
 * Result of the checkLeaveOverlap query.
 */
@ObjectType()
export class LeaveOverlapResult {
  @Field()
  hasOverlap!: boolean;

  @Field(() => [OverlappingLeaveRequest])
  overlappingRequests!: OverlappingLeaveRequest[];
}

/**
 * Result of the calculateLeaveDays query — a pure calendar computation
 * (no entity write) honoring weekends and tenant holidays.
 */
@ObjectType()
export class LeaveDaysResult {
  @Field(() => Float, { description: 'Calendar days in range, adjusted for half-day start/end' })
  totalDays!: number;

  @Field(() => Float, { description: 'Working days (excludes weekends and holidays), half-day adjusted' })
  workingDays!: number;

  @Field(() => Int, { description: 'Number of weekend days in the range' })
  weekends!: number;

  @Field(() => Int, { description: 'Number of holiday days (non-weekend) in the range' })
  holidays!: number;
}
