import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { CurrentUser } from '../decorators/current-user.decorator';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';

import {
  CreateTenantCommand,
  UpdateTenantCommand,
  SuspendTenantCommand,
  ActivateTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
} from './commands/tenant.commands';
import {
  TenantDetailDto,
  BulkSuspendDto,
  BulkActivateDto,
  CreateTenantNoteDto,
  UpdateTenantNoteDto,
} from './dto/tenant-detail.dto';
import {
  CreateTenantDto,
  UpdateTenantDto,
  SuspendTenantDto,
  ListTenantsQueryDto,
  TenantStatsDto,
  TenantUsageDto,
} from './dto/tenant.dto';
import { DeactivateTenantDto } from './dto/deactivate-tenant.dto';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
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
import { TenantProvisioningService, ProvisioningResult } from './services/tenant-provisioning.service';

interface AdminUser {
  id: string;
  email: string;
  roles: string[];
}

@ApiTags('Tenants')
@Controller('tenants')
@UseGuards(PlatformAdminGuard) // H14 fix: explicit guard
export class TenantController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly detailService: TenantDetailService,
    private readonly activityService: TenantActivityService,
    private readonly provisioningService: TenantProvisioningService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new tenant' })
  @HttpCode(HttpStatus.CREATED)
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new CreateTenantCommand(dto, user.id));
  }

  @Get()
  @ApiOperation({ summary: 'List all tenants with filtering and pagination' })
  async listTenants(
    @Query() query: ListTenantsQueryDto,
  ): Promise<PaginatedResult<Tenant>> {
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
    return this.queryBus.execute(
      new SearchTenantsQuery(searchTerm, limit || 20),
    );
  }

  @Get('approaching-limits')
  @ApiOperation({ summary: 'Get tenants approaching usage limits' })
  async getTenantsApproachingLimits(
    @Query('threshold') threshold?: number,
  ): Promise<Tenant[]> {
    return this.queryBus.execute(
      new GetTenantsApproachingLimitsQuery(threshold || 80),
    );
  }

  @Get('expiring-trials')
  @ApiOperation({ summary: 'Get tenants with expiring trial periods' })
  async getExpiringTrials(
    @Query('withinDays') withinDays?: number,
  ): Promise<Tenant[]> {
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

  @Post('bulk/suspend')
  @ApiOperation({ summary: 'Bulk suspend multiple tenants' })
  @HttpCode(HttpStatus.OK)
  async bulkSuspend(
    @Body() dto: BulkSuspendDto,
    @CurrentUser() user: AdminUser,
  ): Promise<{ success: string[]; failed: string[] }> {
    return this.detailService.bulkSuspend(dto.tenantIds, dto.reason, user.id);
  }

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
  async getTenantById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Tenant> {
    return this.queryBus.execute(new GetTenantByIdQuery(id));
  }

  @Get(':id/detail')
  @ApiOperation({ summary: 'Get detailed tenant information' })
  async getTenantDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantDetailDto> {
    return this.detailService.getTenantDetail(id);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant resource usage' })
  async getTenantUsage(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantUsageDto> {
    return this.queryBus.execute(new GetTenantUsageQuery(id));
  }

  @Get(':id/activities')
  @ApiOperation({ summary: 'Get tenant activity timeline' })
  async getTenantActivities(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<{ data: TenantActivity[]; total: number; totalPages: number }> {
    return this.detailService.getActivitiesTimeline(
      id,
      page || 1,
      limit || 20,
    );
  }

  @Get(':id/notes')
  @ApiOperation({ summary: 'Get tenant notes' })
  async getTenantNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('category') category?: string,
  ): Promise<TenantNote[]> {
    return this.activityService.getNotes(id, { category });
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Create a note for a tenant' })
  @HttpCode(HttpStatus.CREATED)
  async createTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
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

  @Patch(':id/notes/:noteId')
  @ApiOperation({ summary: 'Update a tenant note' })
  async updateTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() body: UpdateTenantNoteDto, // HIGH-003 fix: typed DTO with @MaxLength(5000) and @IsEnum(categories)
  ): Promise<TenantNote> {
    // HIGH-004 fix: pass tenantId to verify ownership
    return this.activityService.updateNote(noteId, body, id);
  }

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

  @Put(':id')
  @ApiOperation({ summary: 'Update tenant details' })
  async updateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new UpdateTenantCommand(id, dto, user.id));
  }

  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend a tenant' })
  async suspendTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new SuspendTenantCommand(id, dto, user.id));
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate a suspended tenant' })
  async activateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new ActivateTenantCommand(id, user.id));
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a tenant' })
  async deactivateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(
      new DeactivateTenantCommand(id, dto.reason, user.id),
    );
  }

  // ============================================================================
  // Provisioning Endpoints
  // ============================================================================

  @Post(':id/provision')
  @ApiOperation({ summary: 'Provision tenant schema and resources' })
  @HttpCode(HttpStatus.OK)
  async provisionTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProvisionTenantDto,
  ): Promise<ProvisioningResult> {
    return this.provisioningService.provisionTenant(id, {
      createFirstAdmin: dto.createAdmin || false,
      adminEmail: dto.adminEmail,
      assignModules: dto.modules || [],
    });
  }

  @Get(':id/provision/status')
  @ApiOperation({ summary: 'Get tenant provisioning status' })
  async getProvisioningStatus(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ status: string }> {
    return this.provisioningService.getProvisioningStatus(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive a tenant' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async archiveTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<void> {
    await this.commandBus.execute(new ArchiveTenantCommand(id, user.id));
  }
}
