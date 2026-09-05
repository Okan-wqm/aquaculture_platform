import { Destructive, RequiresCapability, TenantParam } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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
import { ApiTags } from '@nestjs/swagger';

import { ModulesService, PaginatedModules } from './modules.service';

/**
 * WHY no price field: billing owns all subscription pricing (platform rule
 * D14). Per-module prices are managed through the module-pricing catalog
 * (admin.module_pricing via ModulePricingService), never through the
 * auth.modules catalogue surface. The read-side ModuleDto.price is derived
 * from that catalog.
 */
export interface CreateModuleDto {
  code: string;
  name: string;
  description?: string;
  defaultRoute: string;
  icon?: string;
  isCore?: boolean;
}

export interface UpdateModuleDto {
  name?: string;
  description?: string;
  defaultRoute?: string;
  icon?: string;
  isActive?: boolean;
}

export interface ModuleQuantitiesDto {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

export interface AssignModuleDto {
  moduleId: string;
  quantities?: ModuleQuantitiesDto;
  configuration?: Record<string, unknown>;
  expiresAt?: Date;
}

@ApiTags('Modules')
@Controller('modules')
export class ModulesController {
  constructor(private readonly modulesService: ModulesService) {}

  /**
   * Get all system modules
   */
  @Get()
  async listModules(
    @Query('isActive') isActive?: string,
    @Query('isCore') isCore?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PaginatedModules> {
    return this.modulesService.listModules(
      {
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        isCore: isCore === 'true' ? true : isCore === 'false' ? false : undefined,
        search,
      },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Get module statistics
   */
  @Get('stats')
  async getModuleStats() {
    return this.modulesService.getModuleStats();
  }

  /**
   * Get all tenant-module assignments
   */
  @Get('assignments')
  async getAllAssignments(
    @TenantParam('query', { optional: true, allow: 'any' }) tenantId?: string,
    @Query('moduleId') moduleId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.modulesService.getAssignments(
      { tenantId, moduleId },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Get module by ID
   */
  @Get(':id')
  async getModuleById(@Param('id', ParseUUIDPipe) id: string) {
    return this.modulesService.getModuleById(id);
  }

  /**
   * Get module by code
   */
  @Get('code/:code')
  async getModuleByCode(@Param('code') code: string) {
    return this.modulesService.getModuleByCode(code);
  }

  /**
   * Get tenants assigned to a module
   */
  @Get(':id/tenants')
  async getModuleTenants(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.modulesService.getModuleTenants(
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Create new system module
   */
  @AuditedOperation({ resource: 'Module', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createModule(@Body() dto: CreateModuleDto) {
    return this.modulesService.createModule(dto);
  }

  /**
   * Update module
   */
  @AuditedOperation({ resource: 'Module', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':id')
  async updateModule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModuleDto,
  ) {
    return this.modulesService.updateModule(id, dto);
  }

  /**
   * Activate module
   */
  @AuditedOperation({ resource: 'Module', action: 'ACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/activate')
  async activateModule(@Param('id', ParseUUIDPipe) id: string) {
    return this.modulesService.setModuleStatus(id, true);
  }

  /**
   * Deactivate module
   */
  @AuditedOperation({ resource: 'Module', action: 'DEACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/deactivate')
  async deactivateModule(@Param('id', ParseUUIDPipe) id: string) {
    return this.modulesService.setModuleStatus(id, false);
  }

  /**
   * Delete module
   */
  @AuditedOperation({ resource: 'Module', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteModule(@Param('id', ParseUUIDPipe) id: string) {
    await this.modulesService.deleteModule(id);
  }

  /**
   * Assign module to tenant
   */
  @AuditedOperation({ resource: 'ModuleToTenant', action: 'ASSIGN' })
  @RequiresCapability('security-ops')
  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  async assignModuleToTenant(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: AssignModuleDto,
  ) {
    return this.modulesService.assignModuleToTenant({ ...dto, tenantId });
  }

  /**
   * Remove module from tenant
   */
  @AuditedOperation({ resource: 'ModuleFromTenant', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete('assignments/:tenantId/:moduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModuleFromTenant(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
  ) {
    await this.modulesService.removeModuleFromTenant(tenantId, moduleId);
  }
}
