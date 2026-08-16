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
import type { PricingModuleQuantities } from '@platform/pricing-metric-vocabulary';

import { ModulesService, PaginatedModules } from './modules.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../shared/admin-response-contract.decorator';
import {
  modulesSystemModulePageContract,
  type ModulesSystemModuleDto,
  modulesModuleStatsContract,
  type ModulesModuleStatsDto,
  modulesGetAllAssignmentsResponsePageContract,
  type ModulesGetAllAssignmentsResponseDto,
  modulesSystemModuleContract,
  modulesGetModuleTenantsResponsePageContract,
  type ModulesGetModuleTenantsResponseDto,
  voidResponseContract,
  type VoidResponseDto,
  modulesTenantModuleAssignmentContract,
  type ModulesTenantModuleAssignmentDto,
} from './contracts/admin-http-response.contract';

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

export type ModuleQuantitiesDto = PricingModuleQuantities;

export interface AssignModuleDto {
  tenantId: string;
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
  @AdminResponseContract(modulesSystemModulePageContract)
  @Get()
  async listModules(
    @Query('isActive') isActive?: string,
    @Query('isCore') isCore?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<ModulesSystemModuleDto>> {
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
  @AdminResponseContract(modulesModuleStatsContract)
  @Get('stats')
  async getModuleStats(): Promise<ModulesModuleStatsDto> {
    return this.modulesService.getModuleStats();
  }

  /**
   * Get all tenant-module assignments
   */
  @AdminResponseContract(modulesGetAllAssignmentsResponsePageContract)
  @Get('assignments')
  async getAllAssignments(
    @Query('tenantId') tenantId?: string,
    @Query('moduleId') moduleId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<ModulesGetAllAssignmentsResponseDto>> {
    return this.modulesService.getAssignments(
      { tenantId, moduleId },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Get module by ID
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Get(':id')
  async getModuleById(@Param('id', ParseUUIDPipe) id: string): Promise<ModulesSystemModuleDto> {
    return this.modulesService.getModuleById(id);
  }

  /**
   * Get module by code
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Get('lookup/code/:code')
  async getModuleByCode(@Param('code') code: string): Promise<ModulesSystemModuleDto> {
    return this.modulesService.getModuleByCode(code);
  }

  /**
   * Get tenants assigned to a module
   */
  @AdminResponseContract(modulesGetModuleTenantsResponsePageContract)
  @Get(':id/tenants')
  async getModuleTenants(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<ModulesGetModuleTenantsResponseDto>> {
    return this.modulesService.getModuleTenants(
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Create new system module
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createModule(@Body() dto: CreateModuleDto): Promise<ModulesSystemModuleDto> {
    return this.modulesService.createModule(dto);
  }

  /**
   * Update module
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Put(':id')
  async updateModule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModuleDto,
  ): Promise<ModulesSystemModuleDto> {
    return this.modulesService.updateModule(id, dto);
  }

  /**
   * Activate module
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Patch(':id/activate')
  async activateModule(@Param('id', ParseUUIDPipe) id: string): Promise<ModulesSystemModuleDto> {
    return this.modulesService.setModuleStatus(id, true);
  }

  /**
   * Deactivate module
   */
  @AdminResponseContract(modulesSystemModuleContract)
  @Patch(':id/deactivate')
  async deactivateModule(@Param('id', ParseUUIDPipe) id: string): Promise<ModulesSystemModuleDto> {
    return this.modulesService.setModuleStatus(id, false);
  }

  /**
   * Delete module
   */
  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteModule(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.modulesService.deleteModule(id);
  }

  /**
   * Assign module to tenant
   */
  @AdminResponseContract(modulesTenantModuleAssignmentContract)
  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  async assignModuleToTenant(
    @Body() dto: AssignModuleDto,
  ): Promise<ModulesTenantModuleAssignmentDto> {
    return this.modulesService.assignModuleToTenant(dto);
  }

  /**
   * Remove module from tenant
   */
  @AdminResponseContract(voidResponseContract)
  @Delete('assignments/:tenantId/:moduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModuleFromTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
  ): Promise<void> {
    await this.modulesService.removeModuleFromTenant(tenantId, moduleId);
  }
}
