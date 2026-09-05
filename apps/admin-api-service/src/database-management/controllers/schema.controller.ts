/**
 * Schema Management Controller
 *
 * Tenant schema oluşturma, yönetim ve izolasyon endpoint'leri.
 */

import { Destructive, RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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
import { IsString, IsOptional, IsArray } from 'class-validator';

import { Roles } from '../../decorators/roles.decorator';
import { getAuthUser } from '../../shared/authenticated-request';
import { SchemaManagementService } from '../services/schema-management.service';

// ============================================================================
// DTOs
// ============================================================================

class SyncSchemasDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;


  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modules?: string[];
}

@ApiTags('Database Management')
@Controller('database/schemas')
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
  async getSchema(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.schemaService.getSchemaByTenantId(tenantId);
  }

  @Get(':tenantId/info')
  async getSchemaInfo(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.schemaService.getSchemaInfo(tenantId);
  }

  @AuditedOperation({ resource: 'Schemas', action: 'SYNC' })
  @RequiresCapability('security-ops')
  @Post('sync')
  async syncSchemas(
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: SyncSchemasDto,
  ) {
    return this.schemaService.syncExistingTenantSchemas(tenantId, dto.modules);
  }

  // SECURITY: destructive action requires confirmation token and audit
  @AuditedOperation({ resource: 'Schema', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':tenantId')
  @Roles('SUPER_ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSchema(
    // ParseUUIDPipe: rejects non-UUID tenantId before it reaches the service layer.
    @TenantParam('param', { allow: 'any' }) tenantId: string,
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

  @Get(':tenantId/validate')
  async validateSchemaIsolation(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.schemaService.validateSchemaIsolation(tenantId);
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

  @AuditedOperation({ resource: 'Schema', action: 'BACKFILL_TRACKING_RECORDS' })
  @RequiresCapability('security-ops')
  @Post('backfill-tracking')
  async backfillTrackingRecords() {
    return this.schemaService.backfillTrackingRecords();
  }
}
