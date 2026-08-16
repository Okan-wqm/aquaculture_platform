import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
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
  ResumeTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
  RequestTenantErasureCommand,
} from './commands/tenant.commands';
import { DeactivateTenantDto } from './dto/deactivate-tenant.dto';
import type { TenantActivityDto, TenantNoteDto } from './dto/tenant-activity.dto';
import {
  RequestTenantErasureDto,
  TenantErasureOperationAcceptedResponse,
} from './dto/request-tenant-erasure.dto';
import {
  TenantDetailDto,
  BulkSuspendDto,
  BulkActivateDto,
  CreateTenantNoteDto,
  UpdateTenantNoteDto,
} from './dto/tenant-detail.dto';
import {
  BulkTenantOperationResult,
  TenantListItemDto,
  TenantPublicSummaryDto,
  TenantSubscriptionReconciliation,
  TenantSummaryDto,
} from './dto/tenant-summary.dto';
import {
  CreateTenantAcceptedResponse,
  CreateTenantDto,
  ListTenantsQueryDto,
  SuspendTenantDto,
  TenantStatsDto,
  TenantUsageDto,
  UpdateTenantDto,
} from './dto/tenant.dto';
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
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantDetailService } from './services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from './services/tenant-provisioning-workflow.service';
import { AdminResponseContract } from '../shared/admin-response-contract.decorator';
import {
  tenantPublicCreateTenantAcceptedResponseContract,
  type TenantPublicCreateTenantAcceptedResponseDto,
  tenantAdminTenantListItemDtoPageContract,
  type TenantAdminTenantListItemDtoDto,
  tenantAdminTenantStatsDtoContract,
  type TenantAdminTenantStatsDtoDto,
  tenantAdminTenantSummaryDtoArrayContract,
  type TenantAdminTenantSummaryDtoDto,
  tenantAdminTenantPublicSummaryDtoContract,
  type TenantAdminTenantPublicSummaryDtoDto,
  tenantAdminBulkTenantOperationResultContract,
  type TenantAdminBulkTenantOperationResultDto,
  tenantAdminTenantSummaryDtoContract,
  tenantAdminTenantDetailDtoContract,
  type TenantAdminTenantDetailDtoDto,
  tenantAdminTenantUsageDtoContract,
  type TenantAdminTenantUsageDtoDto,
  tenantAdminTenantActivityDtoPageContract,
  type TenantAdminTenantActivityDtoDto,
  tenantAdminTenantNoteDtoArrayContract,
  type TenantAdminTenantNoteDtoDto,
  tenantAdminTenantNoteDtoContract,
  voidResponseContract,
  type VoidResponseDto,
  tenantAdminTenantErasureOperationAcceptedResponseContract,
  type TenantAdminTenantErasureOperationAcceptedResponseDto,
  tenantAdminReconcileTenantSubscriptionResponseContract,
  type TenantAdminReconcileTenantSubscriptionResponseDto,
} from './contracts/admin-http-response.contract';

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

  @AdminResponseContract(tenantPublicCreateTenantAcceptedResponseContract)
  @Post()
  @ApiOperation({ summary: 'Create a new tenant provisioning operation' })
  @HttpCode(HttpStatus.ACCEPTED)
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AdminUser,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<TenantPublicCreateTenantAcceptedResponseDto> {
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

  @AdminResponseContract(tenantPublicCreateTenantAcceptedResponseContract)
  @Get('provisioning/:operationId')
  @ApiOperation({ summary: 'Get tenant provisioning operation status' })
  async getTenantProvisioningOperation(
    @Param('operationId', ParseUUIDPipe) operationId: string,
  ): Promise<TenantPublicCreateTenantAcceptedResponseDto> {
    return this.provisioningWorkflowService.getOperation(operationId);
  }

  @AdminResponseContract(tenantPublicCreateTenantAcceptedResponseContract)
  @ThrottleSensitive()
  @Post('provisioning/:operationId/retry')
  @ApiOperation({ summary: 'Retry a failed tenant provisioning operation' })
  @HttpCode(HttpStatus.ACCEPTED)
  async retryTenantProvisioningOperation(
    @Param('operationId', ParseUUIDPipe) operationId: string,
  ): Promise<TenantPublicCreateTenantAcceptedResponseDto> {
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

  @AdminResponseContract(tenantAdminTenantListItemDtoPageContract)
  @Get()
  @ApiOperation({ summary: 'List all tenants with filtering and pagination' })
  async listTenants(
    @Query() query: ListTenantsQueryDto,
  ): Promise<IStandardPaginatedResult<TenantAdminTenantListItemDtoDto>> {
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

  @AdminResponseContract(tenantAdminTenantStatsDtoContract)
  @Get('stats')
  @ApiOperation({ summary: 'Get tenant statistics' })
  async getTenantStats(): Promise<TenantAdminTenantStatsDtoDto> {
    return this.queryBus.execute(new GetTenantStatsQuery());
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoArrayContract)
  @Get('search')
  @ApiOperation({ summary: 'Search tenants by name or domain' })
  async searchTenants(
    @Query('q') searchTerm: string,
    @Query('limit') limit?: number,
  ): Promise<TenantAdminTenantSummaryDtoDto[]> {
    return this.queryBus.execute(new SearchTenantsQuery(searchTerm, limit || 20));
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoArrayContract)
  @Get('approaching-limits')
  @ApiOperation({ summary: 'Get tenants approaching usage limits' })
  async getTenantsApproachingLimits(
    @Query('threshold') threshold?: number,
  ): Promise<TenantAdminTenantSummaryDtoDto[]> {
    return this.queryBus.execute(new GetTenantsApproachingLimitsQuery(threshold || 80));
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoArrayContract)
  @Get('expiring-trials')
  @ApiOperation({ summary: 'Get tenants with expiring trial periods' })
  async getExpiringTrials(
    @Query('withinDays') withinDays?: number,
  ): Promise<TenantAdminTenantSummaryDtoDto[]> {
    return this.queryBus.execute(new GetExpiringTrialsQuery(withinDays || 7));
  }

  @AdminResponseContract(tenantAdminTenantPublicSummaryDtoContract)
  @Get('lookup/slug/:slug')
  @ApiOperation({ summary: 'Get tenant by slug (status redacted from response)' })
  async getTenantBySlug(
    @Param('slug') slug: string,
  ): Promise<TenantAdminTenantPublicSummaryDtoDto> {
    const tenant: TenantSummaryDto = await this.queryBus.execute(new GetTenantBySlugQuery(slug));
    // SEC: Remove internal status from slug-based lookups to prevent
    // information leakage about tenant lifecycle state.
    const { status: _status, ...publicTenant } = tenant;
    return publicTenant;
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  @AdminResponseContract(tenantAdminBulkTenantOperationResultContract)
  @ThrottleSensitive()
  @Post('bulk/suspend')
  @ApiOperation({ summary: 'Bulk suspend multiple tenants' })
  @HttpCode(HttpStatus.OK)
  async bulkSuspend(
    @Body() dto: BulkSuspendDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminBulkTenantOperationResultDto> {
    return this.detailService.bulkSuspend(dto.tenantIds, dto.reason, user.id);
  }

  @AdminResponseContract(tenantAdminBulkTenantOperationResultContract)
  @ThrottleSensitive()
  @Post('bulk/activate')
  @ApiOperation({ summary: 'Bulk activate multiple tenants' })
  @HttpCode(HttpStatus.OK)
  async bulkActivate(
    // BUG-024 fix: use a validated DTO instead of a raw @Body('tenantIds') extraction
    @Body() dto: BulkActivateDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminBulkTenantOperationResultDto> {
    return this.detailService.bulkActivate(dto.tenantIds, user.id);
  }

  // ============================================================================
  // Tenant Detail Endpoints
  // ============================================================================

  @AdminResponseContract(tenantAdminTenantSummaryDtoContract)
  @Get(':id')
  @ApiOperation({ summary: 'Get tenant by ID' })
  async getTenantById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantAdminTenantSummaryDtoDto> {
    return this.queryBus.execute(new GetTenantByIdQuery(id));
  }

  @AdminResponseContract(tenantAdminTenantDetailDtoContract)
  @Get(':id/detail')
  @ApiOperation({ summary: 'Get detailed tenant information' })
  async getTenantDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantAdminTenantDetailDtoDto> {
    return this.detailService.getTenantDetail(id);
  }

  @AdminResponseContract(tenantAdminTenantUsageDtoContract)
  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant resource usage' })
  async getTenantUsage(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantAdminTenantUsageDtoDto> {
    return this.queryBus.execute(new GetTenantUsageQuery(id));
  }

  @AdminResponseContract(tenantAdminTenantActivityDtoPageContract)
  @Get(':id/activities')
  @ApiOperation({ summary: 'Get tenant activity timeline' })
  async getTenantActivities(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<TenantAdminTenantActivityDtoDto>> {
    return this.detailService.getActivitiesTimeline(id, page || 1, limit || 20);
  }

  @AdminResponseContract(tenantAdminTenantNoteDtoArrayContract)
  @Get(':id/notes')
  @ApiOperation({ summary: 'Get tenant notes' })
  async getTenantNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('category') category?: string,
  ): Promise<TenantAdminTenantNoteDtoDto[]> {
    return this.activityService.getNotes(id, { category });
  }

  @AdminResponseContract(tenantAdminTenantNoteDtoContract)
  @Post(':id/notes')
  @ApiOperation({ summary: 'Create a note for a tenant' })
  @HttpCode(HttpStatus.CREATED)
  async createTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateTenantNoteDto, // HIGH-003 fix: typed DTO with @MaxLength(5000) and @IsEnum(categories)
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantNoteDtoDto> {
    return this.activityService.createNote({
      tenantId: id,
      content: body.content,
      category: body.category,
      isPinned: body.isPinned,
      createdBy: user.id,
      createdByEmail: user.email,
    });
  }

  @AdminResponseContract(tenantAdminTenantNoteDtoContract)
  @Patch(':id/notes/:noteId')
  @ApiOperation({ summary: 'Update a tenant note' })
  async updateTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() body: UpdateTenantNoteDto, // HIGH-003 fix: typed DTO with @MaxLength(5000) and @IsEnum(categories)
  ): Promise<TenantAdminTenantNoteDtoDto> {
    // HIGH-004 fix: pass tenantId to verify ownership
    return this.activityService.updateNote(noteId, body, id);
  }

  @AdminResponseContract(voidResponseContract)
  @Delete(':id/notes/:noteId')
  @ApiOperation({ summary: 'Delete a tenant note' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    // HIGH-004 fix: pass tenantId to verify ownership
    await this.activityService.deleteNote(noteId, id);
  }

  // ============================================================================
  // Standard CRUD Operations
  // ============================================================================

  @AdminResponseContract(tenantAdminTenantSummaryDtoContract)
  @Put(':id')
  @ApiOperation({ summary: 'Update tenant details' })
  async updateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantSummaryDtoDto> {
    return this.commandBus.execute(new UpdateTenantCommand(id, dto, user.id));
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoContract)
  @ThrottleSensitive()
  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend a tenant' })
  async suspendTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantSummaryDtoDto> {
    return this.commandBus.execute(new SuspendTenantCommand(id, dto, user.id));
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoContract)
  @ThrottleSensitive()
  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate a suspended tenant' })
  async activateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantSummaryDtoDto> {
    return this.commandBus.execute(new ResumeTenantCommand(id, user.id));
  }

  @AdminResponseContract(tenantAdminTenantSummaryDtoContract)
  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a tenant' })
  async deactivateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantSummaryDtoDto> {
    return this.commandBus.execute(new DeactivateTenantCommand(id, dto.reason, user.id));
  }

  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @ApiOperation({ summary: 'Archive a tenant' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async archiveTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<void> {
    await this.commandBus.execute(new ArchiveTenantCommand(id, user.id));
  }

  @AdminResponseContract(tenantAdminTenantErasureOperationAcceptedResponseContract)
  @ThrottleSensitive()
  @Post(':id/erasure')
  @ApiOperation({ summary: 'Request irreversible GDPR tenant erasure' })
  @HttpCode(HttpStatus.ACCEPTED)
  async requestTenantErasure(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestTenantErasureDto,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminTenantErasureOperationAcceptedResponseDto> {
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
  @AdminResponseContract(tenantAdminReconcileTenantSubscriptionResponseContract)
  @ThrottleSensitive()
  @Post(':id/reconcile-subscription')
  @ApiOperation({ summary: 'Idempotently create a missing tenant billing subscription' })
  @HttpCode(HttpStatus.OK)
  async reconcileTenantSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<TenantAdminReconcileTenantSubscriptionResponseDto> {
    return this.provisioningWorkflowService.reconcileTenantSubscription(id, user.id);
  }
}
