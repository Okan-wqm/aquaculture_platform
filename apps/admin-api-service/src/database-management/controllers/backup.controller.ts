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
  Req,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsUUID,
  IsIn,
  IsBoolean,
  IsInt,
  Min,
  Max,
  IsArray,
  IsString,
  MaxLength,
  Matches,
  IsNotEmpty,
  ArrayMaxSize,
} from 'class-validator';

import { BackupType, BackupStatus } from '../entities/database-management.entity';
import { BackupRestoreService } from '../services/backup-restore.service';
import { getAuthUser } from '../../shared/authenticated-request';

// ============================================================================
// DTOs
// ============================================================================

class CreateBackupDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsIn(['full', 'incremental', 'differential'])
  backupType!: BackupType;

  @IsOptional()
  @IsBoolean()
  compress?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  retentionDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(63, { each: true })
  @Matches(/^[a-z_][a-z0-9_]*$/i, { each: true, message: 'Invalid table name' })
  excludeTables?: string[];
}

class RestoreBackupDto {
  @IsUUID()
  backupId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z_][a-z0-9_]*$/i, { message: 'Invalid schema name' })
  targetSchemaName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(63, { each: true })
  @Matches(/^[a-z_][a-z0-9_]*$/i, { each: true, message: 'Invalid table name' })
  tablesToRestore?: string[];

}

class PointInTimeRecoveryDto {
  @IsUUID()
  tenantId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  targetTime!: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/backups')
export class BackupController {
  constructor(private readonly backupService: BackupRestoreService) {}

  private requireAuditActor(req: Request): string {
    const user = getAuthUser(req);
    const actorId = user?.sub ?? user?.id;
    if (!actorId) {
      throw new BadRequestException('Authenticated user is required for database backup audit');
    }
    return actorId;
  }

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
  async createBackup(@Body() dto: CreateBackupDto, @Req() req: Request) {
    if (!dto.backupType) {
      throw new BadRequestException('backupType is required');
    }
    return this.backupService.createBackup({
      tenantId: dto.tenantId,
      backupType: dto.backupType,
      compress: dto.compress,
      retentionDays: dto.retentionDays,
      excludeTables: dto.excludeTables,
      auditActorId: this.requireAuditActor(req),
    });
  }

  @Delete(':backupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBackup(@Param('backupId') backupId: string, @Req() req: Request) {
    await this.backupService.deleteBackup(backupId, this.requireAuditActor(req));
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
  async restoreFromBackup(@Body() dto: RestoreBackupDto, @Req() req: Request) {
    if (!dto.backupId) {
      throw new BadRequestException('backupId is required');
    }
    return this.backupService.restoreFromBackup({
      backupId: dto.backupId,
      targetSchemaName: dto.targetSchemaName,
      tablesToRestore: dto.tablesToRestore,
      auditActorId: this.requireAuditActor(req),
    });
  }

  @Post('restore/point-in-time')
  @HttpCode(HttpStatus.OK)
  async pointInTimeRecovery(@Body() dto: PointInTimeRecoveryDto, @Req() req: Request) {
    if (!dto.tenantId || !dto.targetTime) {
      throw new BadRequestException('tenantId and targetTime are required');
    }

    const targetTime = new Date(dto.targetTime);
    if (isNaN(targetTime.getTime())) {
      throw new BadRequestException('Invalid targetTime format');
    }

    return this.backupService.pointInTimeRecovery(
      dto.tenantId,
      targetTime,
      this.requireAuditActor(req),
    );
  }
}
