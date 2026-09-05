import {
  Destructive,
  RequiresCapability,
  TenantParam,
} from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../decorators/current-user.decorator';

import {
  UpdateTenantCommand,
  SuspendTenantCommand,
  ActivateTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
  RequestTenantErasureCommand,
} from './commands/tenant.commands';
import { DeactivateTenantDto } from './dto/deactivate-tenant.dto';
import {
  RequestTenantErasureDto,
  TenantErasureOperationAcceptedResponse,
} from './dto/request-tenant-erasure.dto';
import {
  TenantDetailDto,
  TenantListItemDto,
  BulkSuspendDto,
  BulkActivateDto,
  CreateTenantNoteDto,
  UpdateTenantNoteDto,
} from './dto/tenant-detail.dto';
import {
  CreateTenantAcceptedResponse,
  CreateTenantDto,
  ListTenantsQueryDto,
  SuspendTenantDto,
  TenantStatsDto,
  TenantUsageDto,
  UpdateTenantDto,
} from './dto/tenant.dto';
import { TenantActivity, TenantNote } from './entities/tenant-activity.entity';
import { Tenant } from './entities/tenant.entity';
import {
  GetTenantByIdQuery,
  GetTenantBySlugQuery,
  ListTenantsQuery,
  GetTenantStatsQuery,
  GetTenantUsageQuery,
  GetTenantsApproachingLimitsQuery,
  GetExpiringTrialsQuery,
  SearchTenantsQuery,
} from './queries/tenant.queries';
import { PaginatedResult } from './query-handlers/tenant-query.handlers';
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantDetailService } from './services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from './services/tenant-provisioning-workflow.service';

interface AdminUser {
  id: string;
  email: string;
  roles: string[];
}

@ApiTags('Tenants')
@Controller('tenants')
export class TenantPublicController {
  private readonly logger = new Logger(TenantPublicController.name);

  constructor(private readonly provisioningWorkflowService: TenantProvisioningWorkflowService) {}

  @AuditedOperation({ resource: 'Tenant', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post()
  @ApiOperation({ summary: 'Create a new tenant provisioning operation' })
  @HttpCode(HttpStatus.ACCEPTED)
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AdminUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateTenantAcceptedResponse> {
    const response = await this.provisioningWorkflowService.createTenantOperation(
      dto,
      user.id,
      idempotencyKey,
    );
    const operationId = this.operationIdFromStatusUrl(response.statusUrl);

    this.provisioningWorkflowService.processOperation(operationId).catch((err: Error) => {
      this.logger.error(
        `Async tenant provisioning failed for operation ${operationId}: ${err.message}`,
        err.stack,
      );
    });

    return response;
  }

  @Get('provisioning/:operationId')
  @ApiOperation({ summary: 'Get tenant provisioning operation status' })
  async getTenantProvisioningOperation(
    @Param('operationId', ParseUUIDPipe) operationId: string,
  ): Promise<CreateTenantAcceptedResponse> {
    return this.provisioningWorkflowService.getOperation(operationId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'TenantProvisioningOperation', action: 'RETRY' })
  @RequiresCapability('security-ops')
  @Post('provisioning/:operationId/retry')
  @ApiOperation({ summary: 'Retry a failed tenant provisioning operation' })
  @HttpCode(HttpStatus.ACCEPTED)
  async retryTenantProvisioningOperation(
    @Param('operationId', ParseUUIDPipe) operationId: string,
  ): Promise<CreateTenantAcceptedResponse> {
    return this.provisioningWorkflowService.retryOperation(operationId);
  }

  private operationIdFromStatusUrl(statusUrl: string): string {
    const match = /^\/tenants\/provisioning\/([0-9a-f-]{36})$/i.exec(statusUrl);
    if (!match?.[1]) {
      throw new Error(`Invalid tenant provisioning statusUrl '${statusUrl}'`);
    }
    return match[1];
  }
}

@ApiTags('Admin Tenants')
@Controller('admin/tenants')
export class TenantAdminController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly detailService: TenantDetailService,
    private readonly activityService: TenantActivityService,
    private readonly provisioningWorkflowService: TenantProvisioningWorkflowService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all tenants with filtering and pagination' })
  async listTenants(
    @Query() query: ListTenantsQueryDto,
  ): Promise<PaginatedResult<TenantListItemDto>> {
    return this.queryBus.execute(
      new ListTenantsQuery(
        {
          status: query.status,
          plan: query.plan || query.tier,
          search: query.search,
        },
        {
          page: query.page || 1,
          limit: query.limit || 20,
        },
        {
          field: query.sortBy || 'createdAt',
          order: query.sortOrder || 'DESC',
        },
      ),
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get tenant statistics' })
  async getTenantStats(): Promise<TenantStatsDto> {
    return this.queryBus.execute(new GetTenantStatsQuery());
  }

  @Get('search')
  @ApiOperation({ summary: 'Search tenants by name or domain' })
  async searchTenants(
    @Query('q') searchTerm: string,
    @Query('limit') limit?: number,
  ): Promise<Tenant[]> {
    return this.queryBus.execute(new SearchTenantsQuery(searchTerm, limit || 20));
  }

  @Get('approaching-limits')
  @ApiOperation({ summary: 'Get tenants approaching usage limits' })
  async getTenantsApproachingLimits(@Query('threshold') threshold?: number): Promise<Tenant[]> {
    return this.queryBus.execute(new GetTenantsApproachingLimitsQuery(threshold || 80));
  }

  @Get('expiring-trials')
  @ApiOperation({ summary: 'Get tenants with expiring trial periods' })
  async getExpiringTrials(@Query('withinDays') withinDays?: number): Promise<Tenant[]> {
    return this.queryBus.execute(new GetExpiringTrialsQuery(withinDays || 7));
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get tenant by slug (status redacted from response)' })
  async getTenantBySlug(@Param('slug') slug: string): Promise<Partial<Tenant>> {
    const tenant: Tenant = await this.queryBus.execute(new GetTenantBySlugQuery(slug));
    // SEC: Remove internal status from slug-based lookups to prevent
    // information leakage about tenant lifecycle state.
    const { status: _status, ...publicTenant } = tenant;
    return publicTenant;
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Suspend', action: 'BULK' })
  @RequiresCapability('security-ops')
  @Post('bulk/suspend')
  @ApiOperation({ summary: 'Bulk suspend multiple tenants' })
  @HttpCode(HttpStatus.OK)
  async bulkSuspend(
    @Body() dto: BulkSuspendDto,
    @CurrentUser() user: AdminUser,
  ): Promise<{ success: string[]; failed: string[] }> {
    return this.detailService.bulkSuspend(dto.tenantIds, dto.reason, user.id);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Activate', action: 'BULK' })
  @RequiresCapability('security-ops')
  @Post('bulk/activate')
  @ApiOperation({ summary: 'Bulk activate multiple tenants' })
  @HttpCode(HttpStatus.OK)
  async bulkActivate(
    // BUG-024 fix: use a validated DTO instead of a raw @Body('tenantIds') extraction
    @Body() dto: BulkActivateDto,
    @CurrentUser() user: AdminUser,
  ): Promise<{ success: string[]; failed: string[] }> {
    return this.detailService.bulkActivate(dto.tenantIds, user.id);
  }

  // ============================================================================
  // Tenant Detail Endpoints
  // ============================================================================

  @Get(':id')
  @ApiOperation({ summary: 'Get tenant by ID' })
  async getTenantById(@TenantParam('param', { key: 'id' }) id: string): Promise<Tenant> {
    return this.queryBus.execute(new GetTenantByIdQuery(id));
  }

  @Get(':id/detail')
  @ApiOperation({ summary: 'Get detailed tenant information' })
  async getTenantDetail(@TenantParam('param', { key: 'id' }) id: string): Promise<TenantDetailDto> {
    return this.detailService.getTenantDetail(id);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant resource usage' })
  async getTenantUsage(@TenantParam('param', { key: 'id' }) id: string): Promise<TenantUsageDto> {
    return this.queryBus.execute(new GetTenantUsageQuery(id));
  }

  @Get(':id/activities')
  @ApiOperation({ summary: 'Get tenant activity timeline' })
  async getTenantActivities(
    @TenantParam('param', { key: 'id' }) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<{ data: TenantActivity[]; total: number; totalPages: number }> {
    return this.detailService.getActivitiesTimeline(id, page || 1, limit || 20);
  }

  @Get(':id/notes')
  @ApiOperation({ summary: 'Get tenant notes' })
  async getTenantNotes(
    @TenantParam('param', { key: 'id' }) id: string,
    @Query('category') category?: string,
  ): Promise<TenantNote[]> {
    return this.activityService.getNotes(id, { category });
  }

  @AuditedOperation({ resource: 'TenantNote', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post(':id/notes')
  @ApiOperation({ summary: 'Create a note for a tenant' })
  @HttpCode(HttpStatus.CREATED)
  async createTenantNote(
    @TenantParam('param', { key: 'id' }) id: string,
    @Body() body: CreateTenantNoteDto, // HIGH-003 fix: typed DTO with @MaxLength(5000) and @IsEnum(categories)
    @CurrentUser() user: AdminUser,
  ): Promise<TenantNote> {
    return this.activityService.createNote({
      tenantId: id,
      content: body.content,
      category: body.category,
      isPinned: body.isPinned,
      createdBy: user.id,
      createdByEmail: user.email,
    });
  }

  @AuditedOperation({ resource: 'TenantNote', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/notes/:noteId')
  @ApiOperation({ summary: 'Update a tenant note' })
  async updateTenantNote(
    @TenantParam('param', { key: 'id' }) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() body: UpdateTenantNoteDto, // HIGH-003 fix: typed DTO with @MaxLength(5000) and @IsEnum(categories)
  ): Promise<TenantNote> {
    // HIGH-004 fix: pass tenantId to verify ownership
    return this.activityService.updateNote(noteId, body, id);
  }

  @AuditedOperation({ resource: 'TenantNote', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':id/notes/:noteId')
  @ApiOperation({ summary: 'Delete a tenant note' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantNote(
    @TenantParam('param', { key: 'id' }) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    // HIGH-004 fix: pass tenantId to verify ownership
    await this.activityService.deleteNote(noteId, id);
  }

  // ============================================================================
  // Standard CRUD Operations
  // ============================================================================

  @AuditedOperation({ resource: 'Tenant', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':id')
  @ApiOperation({ summary: 'Update tenant details' })
  async updateTenant(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new UpdateTenantCommand(id, dto, user.id));
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Tenant', action: 'SUSPEND' })
  @RequiresCapability('security-ops')
  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend a tenant' })
  async suspendTenant(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new SuspendTenantCommand(id, dto, user.id));
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Tenant', action: 'ACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate a suspended tenant' })
  async activateTenant(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new ActivateTenantCommand(id, user.id));
  }

  @AuditedOperation({ resource: 'Tenant', action: 'DEACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a tenant' })
  async deactivateTenant(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @Body() dto: DeactivateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new DeactivateTenantCommand(id, dto.reason, user.id));
  }

  @AuditedOperation({ resource: 'Tenant', action: 'ARCHIVE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':id')
  @ApiOperation({ summary: 'Archive a tenant' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async archiveTenant(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<void> {
    await this.commandBus.execute(new ArchiveTenantCommand(id, user.id));
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'TenantErasure', action: 'REQUEST' })
  @RequiresCapability('security-ops')
  @Post(':id/erasure')
  @ApiOperation({ summary: 'Request irreversible GDPR tenant erasure' })
  @HttpCode(HttpStatus.ACCEPTED)
  async requestTenantErasure(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @Body() dto: RequestTenantErasureDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantErasureOperationAcceptedResponse> {
    return this.commandBus.execute(
      new RequestTenantErasureCommand(id, dto.reason, user.id, dto.dryRun ?? false),
    );
  }

  /**
   * Idempotent backfill for a tenant that has no billing subscription
   * (ORPHAN-CRITICAL-393): tenants created while the provisioning transaction
   * silently rolled back have an auth.tenants row but no billing.subscriptions
   * row. This resolves the tenant's assigned modules into priced items and runs
   * the same PROVISION_TENANT_SUBSCRIPTION command tenant creation uses — safe
   * to re-invoke (billing dedups on the active subscription + command receipt).
   */
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'TenantAdmin', action: 'RECONCILE_TENANT_SUBSCRIPTION' })
  @RequiresCapability('security-ops')
  @Post(':id/reconcile-subscription')
  @ApiOperation({ summary: 'Idempotently create a missing tenant billing subscription' })
  @HttpCode(HttpStatus.OK)
  async reconcileTenantSubscription(
    @TenantParam('param', { key: 'id', allow: 'any' }) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<{
    tenantId: string;
    subscriptionId?: string;
    status?: string;
    moduleItemCount?: number;
    replayed?: boolean;
  }> {
    return this.provisioningWorkflowService.reconcileTenantSubscription(id, user.id);
  }
}
