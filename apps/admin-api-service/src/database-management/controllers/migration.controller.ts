/**
 * Migration Controller
 *
 * Schema migration yönetimi endpoint'leri.
 */

import { Destructive, RequiresCapability, TenantParam } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Request } from 'express';

import { getAuthUser } from '../../shared/authenticated-request';
import { MigrationStatus } from '../entities/database-management.entity';
import { MigrationManagementService } from '../services/migration-management.service';

// ============================================================================
// DTOs
// ============================================================================

class RunMigrationDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be in semver format (e.g. 1.0.0)' })
  version!: string;

  @IsOptional()
  @IsBoolean()
  isDryRun?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  executedBy?: string;
}

class BatchMigrationDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be in semver format (e.g. 1.0.0)' })
  version!: string;

  @IsOptional()
  @IsBoolean()
  isDryRun?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  executedBy?: string;
}

class RollbackMigrationDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be in semver format (e.g. 1.0.0)' })
  version!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  executedBy?: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/migrations')
export class MigrationController {
  constructor(private readonly migrationService: MigrationManagementService) {}

  private assertRuntimeMigrationEndpointAllowed(): void {
    throw new ForbiddenException(
      'Runtime migration execution is disabled; use db-migrate workflows',
    );
  }

  // ============================================================================
  // Migration Registry
  // ============================================================================

  @Get('available')
  getAvailableMigrations() {
    return this.migrationService.getAvailableMigrations();
  }

  @Get('summary')
  async getMigrationSummary() {
    return this.migrationService.getMigrationSummary();
  }

  // ============================================================================
  // Single Tenant Migration
  // ============================================================================

  @Get('tenant/:tenantId/pending')
  async getPendingMigrations(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.migrationService.getPendingMigrations(tenantId);
  }

  @Get('tenant/:tenantId/history')
  async getTenantMigrationHistory(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.migrationService.getMigrationHistory(tenantId);
  }

  @AuditedOperation({ resource: 'Migration', action: 'RUN' })
  @RequiresCapability('security-ops')
  @Post('tenant/:tenantId/run')
  @HttpCode(HttpStatus.OK)
  runMigration(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: RunMigrationDto,
    @Req() req: Request,
  ): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // Use JWT sub for executedBy — prevents audit trail manipulation via client body
    const executedBy = getAuthUser(req)?.sub
      ?? 'unknown-admin';
    return this.migrationService.runMigration(
      tenantId,
      dto.version,
      dto.isDryRun,
      executedBy,
    );
  }

  @AuditedOperation({ resource: 'Migration', action: 'ROLLBACK' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Post('tenant/:tenantId/rollback')
  @HttpCode(HttpStatus.OK)
  rollbackMigration(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: RollbackMigrationDto,
    @Req() req: Request,
  ): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // SECURITY: Use JWT sub for executedBy — prevents identity falsification
    const executedBy = getAuthUser(req)?.sub
      ?? 'unknown-admin';
    return this.migrationService.rollbackMigration(
      tenantId,
      dto.version,
      executedBy,
    );
  }

  // ============================================================================
  // Batch Migration
  // ============================================================================

  @AuditedOperation({ resource: 'BatchMigration', action: 'RUN' })
  @RequiresCapability('security-ops')
  @Post('batch/run')
  @HttpCode(HttpStatus.OK)
  runBatchMigration(
    @Body() dto: BatchMigrationDto,
    @Req() req: Request,
  ): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // SECURITY: Use JWT sub for executedBy — prevents identity falsification
    const executedBy = getAuthUser(req)?.sub
      ?? 'unknown-admin';
    return this.migrationService.runBatchMigration(
      dto.version,
      dto.isDryRun,
      executedBy,
    );
  }

  @Get('batch/:version/status')
  async getBatchMigrationStatus(@Param('version') version: string) {
    return this.migrationService.getBatchMigrationStatus(version);
  }

  // ============================================================================
  // Migration History
  // ============================================================================

  @Get('history')
  async getAllMigrationHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: MigrationStatus,
    @Query('version') version?: string,
  ) {
    return this.migrationService.getAllMigrationHistory({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      version,
    });
  }
}
