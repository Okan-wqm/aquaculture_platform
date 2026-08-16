/**
 * @module ComplianceResolver
 * @description GraphQL resolver for compliance queries and mutations.
 * All operations restricted to TENANT_ADMIN or SUPER_ADMIN roles.
 * @see ADR-012 Phase 3 (Compliance)
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ObjectType,
  Field,
  InputType,
  registerEnumType,
} from '@nestjs/graphql';
import { Logger, UseInterceptors } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  Tenant,
  CurrentUser,
  CurrentUserPayload,
  Roles,
  Role,
} from '@aquaculture/backend-common/decorators';
import { IsDate, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

import { RetentionPolicy } from '../entities/retention-policy.entity';
import { LegalHold } from '../entities/legal-hold.entity';
import { ComplianceAuditLog, ComplianceAction } from '../entities/compliance-audit-log.entity';

import { SetRetentionPolicyCommand } from '../commands/set-retention-policy.command';
import { ActivateLegalHoldCommand } from '../commands/activate-legal-hold.command';
import { GetAuditLogQuery } from '../queries/get-audit-log.query';
import { GetRetentionPoliciesQuery } from '../queries/get-retention-policies.query';

import { DataExportService, ExportFormat } from '../services/data-export.service';
import { LegalHoldService } from '../services/legal-hold.service';

// ============================================================================
// GRAPHQL TYPES
// ============================================================================

/** Paginated audit log response. */
@ObjectType()
export class AuditLogPageType {
  @Field(() => [ComplianceAuditLog])
  items!: ComplianceAuditLog[];

  @Field()
  hasMore!: boolean;

  @Field(() => String, { nullable: true })
  cursor!: string | null;

  @Field(() => Int)
  totalCount!: number;
}

/** Compliance statistics. */
@ObjectType()
export class ComplianceStats {
  @Field(() => Int)
  messagesUnderHold!: number;

  @Field(() => Int)
  activeHoldsCount!: number;

  @Field(() => Int)
  retentionPoliciesCount!: number;

  @Field(() => Int)
  auditLogEntriesCount!: number;
}

/** Export job result. */
@ObjectType()
export class ExportJobType {
  @Field()
  jobId!: string;

  @Field()
  status!: string;

  @Field()
  format!: string;

  @Field(() => Int)
  recordCount!: number;

  @Field()
  data!: string;

  @Field()
  isUnderLegalHold!: boolean;

  @Field()
  exportedAt!: string;
}

/** Supported export format enum for GraphQL. */
enum GqlExportFormat {
  CSV = 'csv',
  JSON = 'json',
}

registerEnumType(GqlExportFormat, { name: 'ExportFormat' });

// ============================================================================
// INPUT TYPES
// ============================================================================

@InputType()
export class SetRetentionPolicyInput {
  @Field(() => String, {
    nullable: true,
    description: 'Channel ID for channel-level override. Null = tenant default.',
  })
  @IsOptional()
  @IsUUID('4')
  channelId!: string | null;

  @Field(() => Int, { description: 'Retention period in days: 90, 365, 1095, or -1 (indefinite).' })
  @IsInt()
  @Min(-1)
  retentionDays!: number;
}

@InputType()
export class ActivateLegalHoldInput {
  @Field(() => String, { nullable: true, description: 'Null = tenant-wide.' })
  @IsOptional()
  @IsUUID('4')
  channelId!: string | null;

  @Field(() => String, { description: 'Reason for the hold.' })
  @IsString()
  @MaxLength(1000)
  reason!: string;

  @Field(() => String, { description: 'UUID of the legal matter (GDPR proportionality).' })
  @IsUUID('4')
  legalMatterId!: string;

  @Field(() => String, { nullable: true, description: 'Optional description of the legal matter.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  legalMatterDescription!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Optional UUID of the user/entity that requested the hold.',
  })
  @IsOptional()
  @IsUUID('4')
  requestedBy!: string | null;

  @Field(() => Date, {
    nullable: true,
    description: 'Optional expiration date for the hold (GDPR proportionality).',
  })
  @IsOptional()
  @IsDate()
  expiresAt!: Date | null;
}

@InputType()
export class AuditLogFilterInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID('4')
  userId!: string | null;

  @Field(() => ComplianceAction, { nullable: true })
  @IsOptional()
  action!: ComplianceAction | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType!: string | null;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  @IsDate()
  startDate!: Date | null;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  @IsDate()
  endDate!: Date | null;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver()
export class ComplianceResolver {
  private readonly logger = new Logger(ComplianceResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly exportService: DataExportService,
    private readonly legalHoldService: LegalHoldService,
  ) {}

  // ── QUERIES ─────────────────────────────────────────────────────────

  @Query(() => AuditLogPageType, { description: 'Paginated compliance audit log.' })
  @Roles(Role.TENANT_ADMIN)
  async auditLog(
    @Tenant() tenantId: string,
    @Args('filters', { type: () => AuditLogFilterInput, nullable: true })
    filters: AuditLogFilterInput | null,
    @Args('limit', { type: () => Int, defaultValue: 25 }) limit: number,
    @Args('cursor', { type: () => String, nullable: true }) cursor: string | null,
  ): Promise<AuditLogPageType> {
    return this.queryBus.execute(
      new GetAuditLogQuery(
        tenantId,
        Math.min(limit, 100),
        cursor ?? null,
        filters?.userId ?? null,
        filters?.action ?? null,
        filters?.resourceType ?? null,
        filters?.startDate ?? null,
        filters?.endDate ?? null,
      ),
    );
  }

  @Query(() => [RetentionPolicy], { description: 'All retention policies for current tenant.' })
  @Roles(Role.TENANT_ADMIN)
  async retentionPolicies(@Tenant() tenantId: string): Promise<RetentionPolicy[]> {
    return this.queryBus.execute(new GetRetentionPoliciesQuery(tenantId));
  }

  @Query(() => [LegalHold], { description: 'All legal holds for current tenant.' })
  @Roles(Role.TENANT_ADMIN)
  async legalHolds(@Tenant() tenantId: string): Promise<LegalHold[]> {
    return this.legalHoldService.getHolds(tenantId);
  }

  @Query(() => ComplianceStats, { description: 'Compliance statistics.' })
  @Roles(Role.TENANT_ADMIN)
  async complianceStats(@Tenant() tenantId: string): Promise<ComplianceStats> {
    const activeHolds = await this.legalHoldService.getActiveHolds(tenantId);
    const policies = await this.queryBus.execute<GetRetentionPoliciesQuery, RetentionPolicy[]>(
      new GetRetentionPoliciesQuery(tenantId),
    );

    return {
      messagesUnderHold: 0, // Computed at query time — placeholder
      activeHoldsCount: activeHolds.length,
      retentionPoliciesCount: policies.length,
      auditLogEntriesCount: 0, // Would need separate count query
    };
  }

  // ── MUTATIONS ───────────────────────────────────────────────────────

  @Mutation(() => RetentionPolicy, { description: 'Set or update a retention policy.' })
  @Roles(Role.TENANT_ADMIN)
  async setRetentionPolicy(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('input') input: SetRetentionPolicyInput,
  ): Promise<RetentionPolicy> {
    return this.commandBus.execute(
      new SetRetentionPolicyCommand(tenantId, user.sub, input.channelId, input.retentionDays),
    );
  }

  @Mutation(() => LegalHold, {
    description: 'Activate a legal hold. Release requires the platform-admin two-person workflow.',
  })
  @Roles(Role.TENANT_ADMIN)
  async activateLegalHold(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('input') input: ActivateLegalHoldInput,
  ): Promise<LegalHold> {
    return this.commandBus.execute(
      new ActivateLegalHoldCommand(
        tenantId,
        user.sub,
        input.channelId,
        input.reason,
        input.legalMatterId,
        input.legalMatterDescription,
        input.requestedBy,
        input.expiresAt,
      ),
    );
  }

  @Mutation(() => ExportJobType, { description: 'Export channel message history.' })
  @Roles(Role.TENANT_ADMIN)
  async exportChannelData(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('format', { type: () => GqlExportFormat, defaultValue: GqlExportFormat.JSON })
    format: GqlExportFormat,
  ): Promise<ExportJobType> {
    const result = await this.exportService.exportChannel(
      tenantId,
      channelId,
      format as ExportFormat,
      user.sub,
    );
    return result;
  }

  /**
   * Renamed from exportTenantData to exportTenantMessages so the
   * federation graph itself rejects future cross-domain name
   * collisions. Pre-rename, both farm-service and messaging-service
   * declared Mutation.exportTenantData with different return types
   * (TenantExportBundleResponse vs ExportJobType), which Apollo
   * Federation v2 disallows under the non-shareable default.
   */
  @Mutation(() => ExportJobType, {
    description: 'Export all tenant message history (async, returns job handle).',
  })
  @Roles(Role.TENANT_ADMIN)
  async exportTenantMessages(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('format', { type: () => GqlExportFormat, defaultValue: GqlExportFormat.JSON })
    format: GqlExportFormat,
  ): Promise<ExportJobType> {
    const result = await this.exportService.exportTenant(
      tenantId,
      format as ExportFormat,
      user.sub,
    );
    return result;
  }
}
