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
  Req,
  HttpStatus,
  HttpCode,
  BadRequestException,
  UnauthorizedException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, IsEnum, IsOptional, IsArray } from 'class-validator';

import { Roles } from '../../decorators/roles.decorator';
import { Role } from '@platform/identity';
import { getAuthUser } from '../../shared/authenticated-request';
import { SchemaStatus } from '../entities/database-management.entity';
import { SchemaManagementService } from '../services/schema-management.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  schemaTenantSchemaPageContract,
  type SchemaTenantSchemaDto,
  schemaGetSchemaSummaryResponseContract,
  type SchemaGetSchemaSummaryResponseDto,
  schemaTenantSchemaContract,
  schemaSchemaInfoContract,
  type SchemaSchemaInfoDto,
  neverResponseContract,
  type NeverResponseDto,
  schemaSyncSchemasResponseContract,
  type SchemaSyncSchemasResponseDto,
  voidResponseContract,
  type VoidResponseDto,
  schemaValidateSchemaIsolationResponseContract,
  type SchemaValidateSchemaIsolationResponseDto,
  schemaConnectionPoolStatusArrayContract,
  type SchemaConnectionPoolStatusDto,
  schemaGetConnectionsByTenantResponseArrayContract,
  type SchemaGetConnectionsByTenantResponseDto,
  schemaBackfillTrackingRecordsResponseContract,
  type SchemaBackfillTrackingRecordsResponseDto,
} from '../contracts/admin-http-response.contract';

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
export class SchemaController {
  constructor(private readonly schemaService: SchemaManagementService) {}

  // ============================================================================
  // Schema CRUD
  // ============================================================================

  @AdminResponseContract(schemaTenantSchemaPageContract)
  @Get()
  async getAllSchemas(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<SchemaTenantSchemaDto>> {
    return this.schemaService.getAllSchemas({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @AdminResponseContract(schemaGetSchemaSummaryResponseContract)
  @Get('summary')
  async getSchemaSummary(): Promise<SchemaGetSchemaSummaryResponseDto> {
    return this.schemaService.getSchemaSummary();
  }

  @AdminResponseContract(schemaTenantSchemaContract)
  @Get(':tenantId')
  async getSchema(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<SchemaTenantSchemaDto> {
    return this.schemaService.getSchemaByTenantId(tenantId);
  }

  @AdminResponseContract(schemaSchemaInfoContract)
  @Get(':tenantId/info')
  async getSchemaInfo(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<SchemaSchemaInfoDto> {
    return this.schemaService.getSchemaInfo(tenantId);
  }

  @AdminResponseContract(neverResponseContract)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSchema(@Body() dto: CreateSchemaDto): Promise<never> {
    if (!dto.tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.schemaService.createTenantSchema(dto.tenantId);
  }

  @AdminResponseContract(schemaSyncSchemasResponseContract)
  @Post('sync')
  async syncSchemas(@Body() dto: SyncSchemasDto): Promise<SchemaSyncSchemasResponseDto> {
    return this.schemaService.syncExistingTenantSchemas(dto.tenantId, dto.modules);
  }

  @AdminResponseContract(neverResponseContract)
  @Post(':tenantId/suspend')
  async suspendSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<never> {
    return this.schemaService.suspendSchema(tenantId);
  }

  @AdminResponseContract(neverResponseContract)
  @Post(':tenantId/activate')
  async activateSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<never> {
    return this.schemaService.activateSchema(tenantId);
  }

  // SECURITY: destructive action requires confirmation token and audit
  @AdminResponseContract(voidResponseContract)
  @Delete(':tenantId')
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSchema(
    // ParseUUIDPipe: rejects non-UUID tenantId before it reaches the service layer.
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Req() req: Request,
    @Query('hardDelete') hardDelete?: string,
    // SECURITY: Confirmation token required for hard delete to prevent accidental
    // or one-click destructive operations. The token must be the tenantId itself
    // repeated as confirmation (e.g. ?confirmToken=<tenantId>).
    @Query('confirmToken') confirmToken?: string,
  ): Promise<void> {
    if (hardDelete === 'true') {
      if (!confirmToken || confirmToken !== tenantId) {
        throw new BadRequestException(
          'Hard delete requires confirmToken query parameter matching the tenantId. ' +
            'This is a destructive operation that cannot be undone.',
        );
      }
    }

    // SECURITY: fail-closed — reject destructive operations if initiator cannot be identified
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException(
        'Destructive operations require an authenticated user with a verifiable identity.',
      );
    }
    const ipAddress = (req.ip || req.socket?.remoteAddress) ?? undefined;

    await this.schemaService.deleteSchema(tenantId, hardDelete === 'true', {
      performedBy: user.id,
      ipAddress,
      userAgent: req.headers['user-agent'],
    });
  }

  // ============================================================================
  // Schema Validation
  // ============================================================================

  @AdminResponseContract(schemaValidateSchemaIsolationResponseContract)
  @Get(':tenantId/validate')
  async validateSchemaIsolation(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<SchemaValidateSchemaIsolationResponseDto> {
    return this.schemaService.validateSchemaIsolation(tenantId);
  }

  @AdminResponseContract(neverResponseContract)
  @Post(':tenantId/refresh-stats')
  async refreshSchemaStats(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<never> {
    return this.schemaService.updateSchemaStats(tenantId);
  }

  // ============================================================================
  // Connection Pool
  // ============================================================================

  @AdminResponseContract(schemaConnectionPoolStatusArrayContract)
  @Get('connections/pool')
  async getConnectionPoolStatus(): Promise<SchemaConnectionPoolStatusDto[]> {
    return this.schemaService.getConnectionPoolStatus();
  }

  @AdminResponseContract(schemaGetConnectionsByTenantResponseArrayContract)
  @Get('connections/by-tenant')
  async getConnectionsByTenant(): Promise<SchemaGetConnectionsByTenantResponseDto[]> {
    return this.schemaService.getConnectionsByTenant();
  }

  // ============================================================================
  // Backfill
  // ============================================================================

  @AdminResponseContract(schemaBackfillTrackingRecordsResponseContract)
  @Post('backfill-tracking')
  async backfillTrackingRecords(): Promise<SchemaBackfillTrackingRecordsResponseDto> {
    return this.schemaService.backfillTrackingRecords();
  }
}
