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
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  CreateTenantDto,
  UpdateTenantDto,
  SuspendTenantDto,
  ListTenantsQueryDto,
  TenantStatsDto,
  TenantUsageDto,
} from './dto/tenant.dto';
import {
  TenantDetailDto,
  BulkSuspendDto,
} from './dto/tenant-detail.dto';
import {
  CreateTenantCommand,
  UpdateTenantCommand,
  SuspendTenantCommand,
  ActivateTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
} from './commands/tenant.commands';
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
import { Tenant } from './entities/tenant.entity';
import { TenantActivity, TenantNote } from './entities/tenant-activity.entity';
import { PaginatedResult } from './query-handlers/tenant-query.handlers';
import { CurrentUser } from '../decorators/current-user.decorator';
import { TenantDetailService } from './services/tenant-detail.service';
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantProvisioningService, ProvisioningResult } from './services/tenant-provisioning.service';

interface AdminUser {
  id: string;
  email: string;
  roles: string[];
}

@Controller('tenants')
export class TenantController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly detailService: TenantDetailService,
    private readonly activityService: TenantActivityService,
    private readonly provisioningService: TenantProvisioningService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new CreateTenantCommand(dto, user.id));
  }

  @Get()
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
  async getTenantStats(): Promise<TenantStatsDto> {
    return this.queryBus.execute(new GetTenantStatsQuery());
  }

  @Get('search')
  async searchTenants(
    @Query('q') searchTerm: string,
    @Query('limit') limit?: number,
  ): Promise<Tenant[]> {
    return this.queryBus.execute(
      new SearchTenantsQuery(searchTerm, limit || 20),
    );
  }

  @Get('approaching-limits')
  async getTenantsApproachingLimits(
    @Query('threshold') threshold?: number,
  ): Promise<Tenant[]> {
    return this.queryBus.execute(
      new GetTenantsApproachingLimitsQuery(threshold || 80),
    );
  }

  @Get('expiring-trials')
  async getExpiringTrials(
    @Query('withinDays') withinDays?: number,
  ): Promise<Tenant[]> {
    return this.queryBus.execute(new GetExpiringTrialsQuery(withinDays || 7));
  }

  @Get('slug/:slug')
  async getTenantBySlug(@Param('slug') slug: string): Promise<Tenant> {
    return this.queryBus.execute(new GetTenantBySlugQuery(slug));
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  @Post('bulk/suspend')
  @HttpCode(HttpStatus.OK)
  async bulkSuspend(
    @Body() dto: BulkSuspendDto,
    @CurrentUser() user: AdminUser,
  ): Promise<{ success: string[]; failed: string[] }> {
    return this.detailService.bulkSuspend(dto.tenantIds, dto.reason, user.id);
  }

  @Post('bulk/activate')
  @HttpCode(HttpStatus.OK)
  async bulkActivate(
    @Body('tenantIds') tenantIds: string[],
    @CurrentUser() user: AdminUser,
  ): Promise<{ success: string[]; failed: string[] }> {
    return this.detailService.bulkActivate(tenantIds, user.id);
  }

  // ============================================================================
  // Tenant Detail Endpoints
  // ============================================================================

  @Get(':id')
  async getTenantById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Tenant> {
    return this.queryBus.execute(new GetTenantByIdQuery(id));
  }

  @Get(':id/detail')
  async getTenantDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantDetailDto> {
    return this.detailService.getTenantDetail(id);
  }

  @Get(':id/usage')
  async getTenantUsage(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenantUsageDto> {
    return this.queryBus.execute(new GetTenantUsageQuery(id));
  }

  @Get(':id/activities')
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
  async getTenantNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('category') category?: string,
  ): Promise<TenantNote[]> {
    return this.activityService.getNotes(id, { category });
  }

  @Post(':id/notes')
  @HttpCode(HttpStatus.CREATED)
  async createTenantNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { content: string; category?: string; isPinned?: boolean },
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
  async updateTenantNote(
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() body: { content?: string; isPinned?: boolean; category?: string },
  ): Promise<TenantNote> {
    return this.activityService.updateNote(noteId, body);
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantNote(
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    await this.activityService.deleteNote(noteId);
  }

  // ============================================================================
  // Standard CRUD Operations
  // ============================================================================

  @Put(':id')
  async updateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new UpdateTenantCommand(id, dto, user.id));
  }

  @Patch(':id/suspend')
  async suspendTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new SuspendTenantCommand(id, dto, user.id));
  }

  @Patch(':id/activate')
  async activateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(new ActivateTenantCommand(id, user.id));
  }

  @Patch(':id/deactivate')
  async deactivateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: AdminUser,
  ): Promise<Tenant> {
    return this.commandBus.execute(
      new DeactivateTenantCommand(id, reason, user.id),
    );
  }

  // ============================================================================
  // Provisioning Endpoints
  // ============================================================================

  @Post(':id/provision')
  @HttpCode(HttpStatus.OK)
  async provisionTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { createAdmin?: boolean; adminEmail?: string; modules?: string[] },
  ): Promise<ProvisioningResult> {
    return this.provisioningService.provisionTenant(id, {
      createFirstAdmin: body.createAdmin || false,
      adminEmail: body.adminEmail,
      assignModules: body.modules || [],
    });
  }

  @Get(':id/provision/status')
  async getProvisioningStatus(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ status: string }> {
    return this.provisioningService.getProvisioningStatus(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archiveTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AdminUser,
  ): Promise<void> {
    await this.commandBus.execute(new ArchiveTenantCommand(id, user.id));
  }
}
