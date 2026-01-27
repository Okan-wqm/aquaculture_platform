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
import { ModulesService, PaginatedModules } from './modules.service';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';

export interface CreateModuleDto {
  code: string;
  name: string;
  description?: string;
  defaultRoute: string;
  icon?: string;
  isCore?: boolean;
  price?: number;
}

export interface UpdateModuleDto {
  name?: string;
  description?: string;
  defaultRoute?: string;
  icon?: string;
  isActive?: boolean;
  price?: number;
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
  tenantId: string;
  moduleId: string;
  quantities?: ModuleQuantitiesDto;
  configuration?: Record<string, unknown>;
  expiresAt?: Date;
}

@Controller('modules')
@UseGuards(PlatformAdminGuard)
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
    @Query('tenantId') tenantId?: string,
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
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createModule(@Body() dto: CreateModuleDto) {
    return this.modulesService.createModule(dto);
  }

  /**
   * Update module
   */
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
  @Patch(':id/activate')
  async activateModule(@Param('id', ParseUUIDPipe) id: string) {
    return this.modulesService.setModuleStatus(id, true);
  }

  /**
   * Deactivate module
   */
  @Patch(':id/deactivate')
  async deactivateModule(@Param('id', ParseUUIDPipe) id: string) {
    return this.modulesService.setModuleStatus(id, false);
  }

  /**
   * Delete module
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteModule(@Param('id', ParseUUIDPipe) id: string) {
    await this.modulesService.deleteModule(id);
  }

  /**
   * Assign module to tenant
   */
  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  async assignModuleToTenant(@Body() dto: AssignModuleDto) {
    return this.modulesService.assignModuleToTenant(dto);
  }

  /**
   * Remove module from tenant
   */
  @Delete('assignments/:tenantId/:moduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeModuleFromTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
  ) {
    await this.modulesService.removeModuleFromTenant(tenantId, moduleId);
  }
}
