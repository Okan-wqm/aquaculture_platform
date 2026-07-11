/**
 * ComplianceResolver
 *
 * GraphQL surface for the farm-service GDPR primitives. The
 * platform export / erasure pipeline lives in admin-api-service;
 * this resolver is what admin-api fans out to when the operator
 * requests a tenant action. Three mutations:
 *
 *   - `exportTenantData(): TenantExportBundleResponse` — read-only,
 *     returns the JSON bundle of every tenant-scoped farm row.
 *     Runs inline because the mutation's caller (admin-api) is a
 *     service-to-service call, not an interactive user request.
 *
 *   - `initiateTenantErasure(): ErasureTicketResponse` — creates a
 *     pending ticket and returns the 32-char token. Admin-api holds
 *     the token and presents it back to the operator via email /
 *     confirm dialog (that flow lives platform-side, not here).
 *
 *   - `confirmTenantErasure(token): ErasureResultResponse` — runs
 *     the actual DELETE cascade once the token round-trip completes.
 *
 * All three mutations are `@Roles(TENANT_ADMIN)` only.
 *
 * Phase 6.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import {
  Args,
  Field,
  ID,
  Int,
  Mutation,
  ObjectType,
  Resolver,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { Logger, UseGuards } from '@nestjs/common';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { TenantExportService } from './services/tenant-export.service';
import { TenantErasureService } from './services/tenant-erasure.service';

@ObjectType()
class TenantExportSummary {
  @Field(() => Int)
  tableCount!: number;

  @Field(() => Int)
  totalRows!: number;

  @Field(() => [String])
  skippedTables!: string[];
}

@ObjectType()
class TenantExportBundleResponse {
  @Field(() => ID)
  tenantId!: string;

  @Field()
  exportedAt!: string;

  @Field(() => GraphQLJSON)
  tables!: Record<string, unknown[]>;

  @Field(() => TenantExportSummary)
  summary!: TenantExportSummary;
}

@ObjectType()
class ErasureTicketResponse {
  @Field(() => ID)
  tenantId!: string;

  @Field()
  token!: string;

  @Field()
  expiresAt!: string;
}

@ObjectType()
class ErasureResultResponse {
  @Field(() => ID)
  tenantId!: string;

  @Field()
  confirmedAt!: string;

  @Field(() => GraphQLJSON)
  deletedRowsByTable!: Record<string, number>;

  @Field(() => Int)
  totalDeleted!: number;

  @Field(() => Int)
  auditRowsAnonymised!: number;
}

@Resolver()
@UseGuards(TenantGuard)
export class ComplianceResolver {
  private readonly logger = new Logger(ComplianceResolver.name);

  constructor(
    private readonly exportService: TenantExportService,
    private readonly erasureService: TenantErasureService,
  ) {}

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => TenantExportBundleResponse)
  async exportTenantData(
    @CurrentTenant() tenantId: string,
  ): Promise<TenantExportBundleResponse> {
    this.logger.log(`Tenant data export requested for ${tenantId}`);
    return this.exportService.exportTenant(tenantId);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => ErasureTicketResponse)
  async initiateTenantErasure(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ErasureTicketResponse> {
    const ticket = this.erasureService.initiate(tenantId, user.sub);
    return {
      tenantId: ticket.tenantId,
      token: ticket.token,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => ErasureResultResponse)
  async confirmTenantErasure(
    @CurrentTenant() tenantId: string,
    @Args('token') token: string,
  ): Promise<ErasureResultResponse> {
    return this.erasureService.confirm(tenantId, token);
  }
}
