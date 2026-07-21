import { InputType, Field, ObjectType, ID, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  Min,
  Max,
} from 'class-validator';

import {
  TicketPriority,
  TicketStatus,
  TicketCategory,
} from '../entities/support-ticket.entity';
import { CommentAuthorType, TicketAttachment } from '../entities/ticket-comment.entity';

/**
 * Input for creating a new ticket
 */
@InputType()
export class CreateTicketInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  subject!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  description!: string;

  @Field(() => TicketCategory)
  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @Field(() => TicketPriority, { defaultValue: TicketPriority.MEDIUM })
  @IsEnum(TicketPriority)
  priority!: TicketPriority;

  @Field(() => [String], { nullable: true })
  tags?: string[];
}

/**
 * Input for adding a comment to a ticket
 */
@InputType()
export class AddTicketCommentInput {
  @Field()
  @IsUUID()
  ticketId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  content!: string;

  @Field({ defaultValue: false })
  isInternal!: boolean; // Only for admins
}

/**
 * Input for updating ticket status (SuperAdmin)
 */
@InputType()
export class UpdateTicketStatusInput {
  @Field()
  @IsUUID()
  ticketId!: string;

  @Field(() => TicketStatus)
  @IsEnum(TicketStatus)
  status!: TicketStatus;
}

/**
 * Input for assigning ticket (SuperAdmin)
 */
@InputType()
export class AssignTicketInput {
  @Field()
  @IsUUID()
  ticketId!: string;

  @Field()
  @IsUUID()
  assigneeId!: string;
}

/**
 * Input for changing ticket priority (SuperAdmin).
 * Recomputes the SLA deadlines from the new priority's SLA config.
 */
@InputType()
export class UpdateTicketPriorityInput {
  @Field()
  @IsUUID()
  ticketId!: string;

  @Field(() => TicketPriority)
  @IsEnum(TicketPriority)
  priority!: TicketPriority;
}

/**
 * Input for rating ticket satisfaction
 */
@InputType()
export class RateTicketInput {
  @Field()
  @IsUUID()
  ticketId!: string;

  @Field(() => Int)
  @Min(1)
  @Max(5)
  rating!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  comment?: string;
}

/**
 * Ticket list item for display
 */
@ObjectType()
export class TicketListItem {
  @Field(() => ID)
  id!: string;

  @Field()
  ticketNumber!: string;

  @Field()
  tenantId!: string;

  @Field()
  tenantName!: string;

  @Field()
  subject!: string;

  @Field(() => TicketCategory)
  category!: TicketCategory;

  @Field(() => TicketPriority)
  priority!: TicketPriority;

  @Field(() => TicketStatus)
  status!: TicketStatus;

  @Field(() => String, { nullable: true })
  assignedTo!: string | null;

  @Field(() => String, { nullable: true })
  assignedToName!: string | null;

  @Field()
  reportedByName!: string;

  @Field()
  commentCount!: number;

  @Field(() => Date, { nullable: true })
  slaResponseDeadline!: Date | null;

  @Field(() => Date, { nullable: true })
  slaResolutionDeadline!: Date | null;

  @Field(() => Date, { nullable: true })
  firstResponseAt!: Date | null;

  @Field(() => [String], { nullable: true })
  tags!: string[] | null;

  @Field(() => Int, { nullable: true })
  satisfactionRating!: number | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field()
  isResponseSLABreached!: boolean;

  @Field()
  isResolutionSLABreached!: boolean;
}

/**
 * Support team member with active-ticket count (SuperAdmin view).
 * Assignees with at least one open (non-closed/-resolved) ticket.
 */
@ObjectType()
export class TicketTeamMember {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  activeTickets!: number;
}

/**
 * Comment for display
 */
@ObjectType()
export class CommentItem {
  @Field(() => ID)
  id!: string;

  @Field()
  ticketId!: string;

  @Field()
  authorId!: string;

  @Field()
  authorName!: string;

  @Field(() => CommentAuthorType)
  authorType!: CommentAuthorType;

  @Field()
  content!: string;

  @Field()
  isInternal!: boolean;

  @Field(() => [TicketAttachment], { nullable: true })
  attachments!: TicketAttachment[] | null;

  @Field()
  createdAt!: Date;
}

/**
 * Support ticket statistics
 */
@ObjectType()
export class SupportStats {
  @Field()
  total!: number;

  @Field()
  open!: number;

  @Field()
  inProgress!: number;

  @Field()
  waitingCustomer!: number;

  @Field()
  resolved!: number;

  @Field()
  avgResponseMinutes!: number;

  @Field()
  avgResolutionMinutes!: number;

  @Field()
  slaComplianceRate!: number;

  @Field()
  satisfactionAvg!: number;
}
