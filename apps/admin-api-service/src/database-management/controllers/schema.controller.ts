/**
 * Schema Management Controller
 *
 * Tenant schema oluşturma, yönetim ve izolasyon endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, IsEnum, IsOptional, IsArray } from 'class-validator';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { SchemaStatus } from '../entities/database-management.entity';
import { SchemaManagementService } from '../services/schema-management.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateSchemaDto {
  @IsNotEmpty()
  @IsString()
  @IsUUID()
  tenantId!: string;
}

class SyncSchemasDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modules?: string[];
}

class UpdateSchemaStatusDto {
  @IsNotEmpty()
  @IsEnum(['creating', 'active', 'suspended', 'deleted', 'migrating'])
  status!: SchemaStatus;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/schemas')
@UseGuards(PlatformAdminGuard)
export class SchemaController {
  constructor(private readonly schemaService: SchemaManagementService) {}

  // ============================================================================
  // Schema CRUD
  // ============================================================================

  @Get()
  async getAllSchemas(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.schemaService.getAllSchemas({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('summary')
  async getSchemaSummary() {
    return this.schemaService.getSchemaSummary();
  }

  @Get(':tenantId')
  async getSchema(@Param('tenantId') tenantId: string) {
    return this.schemaService.getSchemaByTenantId(tenantId);
  }

  @Get(':tenantId/info')
  async getSchemaInfo(@Param('tenantId') tenantId: string) {
    return this.schemaService.getSchemaInfo(tenantId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSchema(@Body() dto: CreateSchemaDto) {
    if (!dto.tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.schemaService.createTenantSchema(dto.tenantId);
  }

  @Post('sync')
  async syncSchemas(@Body() dto: SyncSchemasDto) {
    return this.schemaService.syncExistingTenantSchemas(dto.tenantId, dto.modules);
  }

  @Post(':tenantId/suspend')
  async suspendSchema(@Param('tenantId') tenantId: string) {
    return this.schemaService.suspendSchema(tenantId);
  }

  @Post(':tenantId/activate')
  async activateSchema(@Param('tenantId') tenantId: string) {
    return this.schemaService.activateSchema(tenantId);
  }

  @Delete(':tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSchema(
    @Param('tenantId') tenantId: string,
    @Query('hardDelete') hardDelete?: string,
  ) {
    await this.schemaService.deleteSchema(tenantId, hardDelete === 'true');
  }

  // ============================================================================
  // Schema Validation
  // ============================================================================

  @Get(':tenantId/validate')
  async validateSchemaIsolation(@Param('tenantId') tenantId: string) {
    return this.schemaService.validateSchemaIsolation(tenantId);
  }

  @Post(':tenantId/refresh-stats')
  async refreshSchemaStats(@Param('tenantId') tenantId: string) {
    return this.schemaService.updateSchemaStats(tenantId);
  }

  // ============================================================================
  // Connection Pool
  // ============================================================================

  @Get('connections/pool')
  async getConnectionPoolStatus() {
    return this.schemaService.getConnectionPoolStatus();
  }

  @Get('connections/by-tenant')
  async getConnectionsByTenant() {
    return this.schemaService.getConnectionsByTenant();
  }

  // ============================================================================
  // Backfill
  // ============================================================================

  @Post('backfill-tracking')
  async backfillTrackingRecords() {
    return this.schemaService.backfillTrackingRecords();
  }
}
