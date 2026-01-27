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
  HttpStatus,
  HttpCode,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { MigrationManagementService } from '../services/migration-management.service';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { MigrationStatus } from '../entities/database-management.entity';

// ============================================================================
// DTOs
// ============================================================================

class RunMigrationDto {
  version!: string;
  isDryRun?: boolean;
  executedBy?: string;
}

class BatchMigrationDto {
  version!: string;
  isDryRun?: boolean;
  executedBy?: string;
}

class RollbackMigrationDto {
  version!: string;
  executedBy?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('database/migrations')
@UseGuards(PlatformAdminGuard)
export class MigrationController {
  constructor(private readonly migrationService: MigrationManagementService) {}

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
  ) {
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    return this.migrationService.runMigration(
      tenantId,
      dto.version,
      dto.isDryRun,
      dto.executedBy,
    );
  }

  @Post('tenant/:tenantId/rollback')
  @HttpCode(HttpStatus.OK)
  async rollbackMigration(
    @Param('tenantId') tenantId: string,
    @Body() dto: RollbackMigrationDto,
  ) {
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    return this.migrationService.rollbackMigration(
      tenantId,
      dto.version,
      dto.executedBy,
    );
  }

  // ============================================================================
  // Batch Migration
  // ============================================================================

  @Post('batch/run')
  @HttpCode(HttpStatus.OK)
  async runBatchMigration(@Body() dto: BatchMigrationDto) {
    if (!dto.version) {
      throw new BadRequestException('version is required');
    }
    return this.migrationService.runBatchMigration(
      dto.version,
      dto.isDryRun,
      dto.executedBy,
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
