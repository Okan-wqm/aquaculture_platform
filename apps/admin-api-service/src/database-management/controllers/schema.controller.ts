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
} from '@nestjs/common';
import { SchemaManagementService } from '../services/schema-management.service';
import { SchemaStatus } from '../entities/database-management.entity';

// ============================================================================
// DTOs
// ============================================================================

class CreateSchemaDto {
  tenantId: string;
}

class UpdateSchemaStatusDto {
  status: SchemaStatus;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('database/schemas')
export class SchemaController {
  constructor(private readonly schemaService: SchemaManagementService) {}

  // ============================================================================
  // Schema CRUD
  // ============================================================================

  @Get()
  async getAllSchemas() {
    return this.schemaService.getAllSchemas();
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
}
