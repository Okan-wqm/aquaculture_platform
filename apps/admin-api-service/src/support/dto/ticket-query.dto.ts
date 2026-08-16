import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { BOOLEAN_QUERY_VALUES_V1, type BooleanQueryValueV1 } from '../../shared/query-value';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '../entities/support.entity';

export class TicketStatusPageQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;
}

/** Complete, validated query contract for GET /support/tickets. */
export class TicketListQueryDto extends TicketStatusPageQueryDto {
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: TicketCategory;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Complete, validated query contract for ticket comment/reply lists. */
export class TicketCommentQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(BOOLEAN_QUERY_VALUES_V1)
  includeInternal?: BooleanQueryValueV1;
}
