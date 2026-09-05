/**
 * Migration Controller
 *
 * Read-only view of tenant schema migrations. Execution (run, rollback,
 * batch) is aqua-db-migrate's; admin-api declares no route for it
 * (ADMIN-HIGH-011 — the former routes only ever answered 403).
 */

import { TenantParam } from '@aquaculture/backend-common/decorators';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { MigrationStatus } from '../entities/database-management.entity';
import { MigrationManagementService } from '../services/migration-management.service';

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/migrations')
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
  async getPendingMigrations(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.migrationService.getPendingMigrations(tenantId);
  }

  @Get('tenant/:tenantId/history')
  async getTenantMigrationHistory(@TenantParam('param', { allow: 'any' }) tenantId: string) {
    return this.migrationService.getMigrationHistory(tenantId);
  }

  // ============================================================================
  // Batch Migration
  // ============================================================================

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
