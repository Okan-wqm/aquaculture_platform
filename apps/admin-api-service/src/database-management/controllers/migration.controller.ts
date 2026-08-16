/**
 * Migration Controller
 *
 * Schema migration yönetimi endpoint'leri.
 */

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
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  migrationGetAvailableMigrationsResponseArrayContract,
  type MigrationGetAvailableMigrationsResponseDto,
  migrationGetMigrationSummaryResponseContract,
  type MigrationGetMigrationSummaryResponseDto,
  migrationMigrationPlanArrayContract,
  type MigrationMigrationPlanDto,
  migrationSchemaMigrationArrayContract,
  type MigrationSchemaMigrationDto,
  neverResponseContract,
  type NeverResponseDto,
  migrationGetBatchMigrationStatusResponseContract,
  type MigrationGetBatchMigrationStatusResponseDto,
  migrationSchemaMigrationPageContract,
} from '../contracts/admin-http-response.contract';

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

  @AdminResponseContract(migrationGetAvailableMigrationsResponseArrayContract)
  @Get('available')
  getAvailableMigrations(): MigrationGetAvailableMigrationsResponseDto[] {
    return this.migrationService.getAvailableMigrations();
  }

  @AdminResponseContract(migrationGetMigrationSummaryResponseContract)
  @Get('summary')
  async getMigrationSummary(): Promise<MigrationGetMigrationSummaryResponseDto> {
    return this.migrationService.getMigrationSummary();
  }

  // ============================================================================
  // Single Tenant Migration
  // ============================================================================

  @AdminResponseContract(migrationMigrationPlanArrayContract)
  @Get('tenant/:tenantId/pending')
  async getPendingMigrations(
    @Param('tenantId') tenantId: string,
  ): Promise<MigrationMigrationPlanDto[]> {
    return this.migrationService.getPendingMigrations(tenantId);
  }

  @AdminResponseContract(migrationSchemaMigrationArrayContract)
  @Get('tenant/:tenantId/history')
  async getTenantMigrationHistory(
    @Param('tenantId') tenantId: string,
  ): Promise<MigrationSchemaMigrationDto[]> {
    return this.migrationService.getMigrationHistory(tenantId);
  }

  @AdminResponseContract(neverResponseContract)
  @Post('tenant/:tenantId/run')
  @HttpCode(HttpStatus.OK)
  runMigration(
    @Param('tenantId') tenantId: string,
    @Body() dto: RunMigrationDto,
    @Req() req: Request,
  ): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // Use JWT sub for executedBy — prevents audit trail manipulation via client body
    const executedBy = getAuthUser(req)?.sub ?? 'unknown-admin';
    return this.migrationService.runMigration(tenantId, dto.version, dto.isDryRun, executedBy);
  }

  @AdminResponseContract(neverResponseContract)
  @Post('tenant/:tenantId/rollback')
  @HttpCode(HttpStatus.OK)
  rollbackMigration(
    @Param('tenantId') tenantId: string,
    @Body() dto: RollbackMigrationDto,
    @Req() req: Request,
  ): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // SECURITY: Use JWT sub for executedBy — prevents identity falsification
    const executedBy = getAuthUser(req)?.sub ?? 'unknown-admin';
    return this.migrationService.rollbackMigration(tenantId, dto.version, executedBy);
  }

  // ============================================================================
  // Batch Migration
  // ============================================================================

  @AdminResponseContract(neverResponseContract)
  @Post('batch/run')
  @HttpCode(HttpStatus.OK)
  runBatchMigration(@Body() dto: BatchMigrationDto, @Req() req: Request): never {
    this.assertRuntimeMigrationEndpointAllowed();
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    // SECURITY: Use JWT sub for executedBy — prevents identity falsification
    const executedBy = getAuthUser(req)?.sub ?? 'unknown-admin';
    return this.migrationService.runBatchMigration(dto.version, dto.isDryRun, executedBy);
  }

  @AdminResponseContract(migrationGetBatchMigrationStatusResponseContract)
  @Get('batch/:version/status')
  async getBatchMigrationStatus(
    @Param('version') version: string,
  ): Promise<MigrationGetBatchMigrationStatusResponseDto> {
    return this.migrationService.getBatchMigrationStatus(version);
  }

  // ============================================================================
  // Migration History
  // ============================================================================

  @AdminResponseContract(migrationSchemaMigrationPageContract)
  @Get('history')
  async getAllMigrationHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: MigrationStatus,
    @Query('version') version?: string,
  ): Promise<IStandardPaginatedResult<MigrationSchemaMigrationDto>> {
    return this.migrationService.getAllMigrationHistory({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      version,
    });
  }
}
