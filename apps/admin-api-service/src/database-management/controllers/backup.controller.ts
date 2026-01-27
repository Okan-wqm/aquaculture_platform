/**
 * Backup & Restore Controller
 *
 * Database yedekleme ve geri yükleme endpoint'leri.
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
import { BackupRestoreService } from '../services/backup-restore.service';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { BackupType, BackupStatus } from '../entities/database-management.entity';

// ============================================================================
// DTOs
// ============================================================================

class CreateBackupDto {
  tenantId?: string;
  backupType!: BackupType;
  compress?: boolean;
  encrypt?: boolean;
  retentionDays?: number;
  excludeTables?: string[];
}

class RestoreBackupDto {
  backupId!: string;
  targetSchemaName?: string;
  tablesToRestore?: string[];
  skipValidation?: boolean;
}

class PointInTimeRecoveryDto {
  tenantId!: string;
  targetTime!: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('database/backups')
@UseGuards(PlatformAdminGuard)
export class BackupController {
  constructor(private readonly backupService: BackupRestoreService) {}

  // ============================================================================
  // Backup Operations
  // ============================================================================

  @Get()
  async getAllBackups(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: BackupStatus,
    @Query('backupType') backupType?: BackupType,
  ) {
    return this.backupService.getAllBackups({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      backupType,
    });
  }

  @Get('summary')
  async getBackupSummary() {
    return this.backupService.getBackupSummary();
  }

  @Get('schedule')
  async getBackupScheduleStatus() {
    return this.backupService.getBackupScheduleStatus();
  }

  @Get(':backupId')
  async getBackup(@Param('backupId') backupId: string) {
    return this.backupService.getBackup(backupId);
  }

  @Get('tenant/:tenantId')
  async getBackupsForTenant(@Param('tenantId') tenantId: string) {
    return this.backupService.getBackupsForTenant(tenantId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBackup(@Body() dto: CreateBackupDto) {
    if (!dto.backupType) {
      throw new BadRequestException('backupType is required');
    }
    return this.backupService.createBackup({
      tenantId: dto.tenantId,
      backupType: dto.backupType,
      compress: dto.compress,
      encrypt: dto.encrypt,
      retentionDays: dto.retentionDays,
      excludeTables: dto.excludeTables,
    });
  }

  @Delete(':backupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBackup(@Param('backupId') backupId: string) {
    await this.backupService.deleteBackup(backupId);
  }

  // ============================================================================
  // Restore Operations
  // ============================================================================

  @Get('restores/tenant/:tenantId')
  async getRestoreHistory(@Param('tenantId') tenantId: string) {
    return this.backupService.getRestoreHistory(tenantId);
  }

  @Get('restores/:restoreId')
  async getRestore(@Param('restoreId') restoreId: string) {
    return this.backupService.getRestore(restoreId);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  async restoreFromBackup(@Body() dto: RestoreBackupDto) {
    if (!dto.backupId) {
      throw new BadRequestException('backupId is required');
    }
    return this.backupService.restoreFromBackup({
      backupId: dto.backupId,
      targetSchemaName: dto.targetSchemaName,
      tablesToRestore: dto.tablesToRestore,
      skipValidation: dto.skipValidation,
    });
  }

  @Post('restore/point-in-time')
  @HttpCode(HttpStatus.OK)
  async pointInTimeRecovery(@Body() dto: PointInTimeRecoveryDto) {
    if (!dto.tenantId || !dto.targetTime) {
      throw new BadRequestException('tenantId and targetTime are required');
    }

    const targetTime = new Date(dto.targetTime);
    if (isNaN(targetTime.getTime())) {
      throw new BadRequestException('Invalid targetTime format');
    }

    return this.backupService.pointInTimeRecovery(dto.tenantId, targetTime);
  }
}
