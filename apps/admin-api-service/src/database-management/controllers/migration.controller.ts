/**
 * Migration Controller
 *
 * Schema migration yönetimi endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { getAuthUser } from '../../shared/authenticated-request';
import { ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsBoolean, MaxLength, Matches } from 'class-validator';

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
  async getPendingMigrations(@Param('tenantId') tenantId: string) {
    return this.migrationService.getPendingMigrations(tenantId);
  }

  @Get('tenant/:tenantId/history')
  async getTenantMigrationHistory(@Param('tenantId') tenantId: string) {
    return this.migrationService.getMigrationHistory(tenantId);
  }

  @Post('tenant/:tenantId/run')
  @HttpCode(HttpStatus.OK)
  async runMigration(
    @Param('tenantId') tenantId: string,
    @Body() dto: RunMigrationDto,
    @Req() req: Request,
  ) {
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

  @Post('tenant/:tenantId/rollback')
  @HttpCode(HttpStatus.OK)
  async rollbackMigration(
    @Param('tenantId') tenantId: string,
    @Body() dto: RollbackMigrationDto,
    @Req() req: Request,
  ) {
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

  @Post('batch/run')
  @HttpCode(HttpStatus.OK)
  async runBatchMigration(
    @Body() dto: BatchMigrationDto,
    @Req() req: Request,
  ) {
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
