/**
 * Backup & Restore Service
 *
 * Tenant database yedekleme ve geri yükleme servisi.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import {
  TenantSchema,
  SchemaBackup,
  SchemaRestore,
  BackupStatus,
  RestoreStatus,
  BackupType,
  BackupOptions,
  RestoreOptions,
} from '../entities/database-management.entity';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class BackupRestoreService {
  private readonly logger = new Logger(BackupRestoreService.name);

  // Configuration
  private readonly BACKUP_BASE_PATH = '/backups/schemas';
  private readonly DEFAULT_RETENTION_DAYS = 30;
  private readonly MAX_BACKUP_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB

  constructor(
    @InjectRepository(TenantSchema)
    private readonly schemaRepository: Repository<TenantSchema>,
    @InjectRepository(SchemaBackup)
    private readonly backupRepository: Repository<SchemaBackup>,
    @InjectRepository(SchemaRestore)
    private readonly restoreRepository: Repository<SchemaRestore>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================================
  // Backup Operations
  // ============================================================================

  /**
   * Create backup for tenant schema
   */
  async createBackup(options: BackupOptions): Promise<SchemaBackup> {
    const {
      tenantId,
      backupType,
      compress = true,
      encrypt = false,
      retentionDays = this.DEFAULT_RETENTION_DAYS,
      excludeTables = [],
    } = options;

    this.logger.log(`Creating ${backupType} backup for tenant: ${tenantId || 'all'}`);

    let schema: TenantSchema | null = null;
    let schemaName = 'public';

    if (tenantId) {
      schema = await this.schemaRepository.findOne({
        where: { tenantId },
      });

      if (!schema) {
        throw new NotFoundException(`Schema not found for tenant: ${tenantId}`);
      }
      schemaName = schema.schemaName;
    }

    // Generate backup filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup_${schemaName}_${backupType}_${timestamp}.sql${compress ? '.gz' : ''}`;
    const filePath = `${this.BACKUP_BASE_PATH}/${schemaName}/${fileName}`;

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);

    // Create backup record
    const backup = this.backupRepository.create({
      tenantId: tenantId || null,
      schemaName,
      backupType,
      status: 'pending' as BackupStatus,
      fileName,
      filePath,
      isCompressed: compress,
      isEncrypted: encrypt,
      retentionDays,
      expiresAt,
    });
    await this.backupRepository.save(backup);

    // Start backup process
    return this.executeBackup(backup, excludeTables);
  }

  /**
   * Execute backup process
   */
  private async executeBackup(
    backup: SchemaBackup,
    excludeTables: string[] = [],
  ): Promise<SchemaBackup> {
    backup.status = 'in_progress' as BackupStatus;
    backup.startedAt = new Date();
    await this.backupRepository.save(backup);

    const startTime = Date.now();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Get tables in schema
      const tables = await queryRunner.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = $1
          AND tablename NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(',') || "''"})
      `, [backup.schemaName, ...excludeTables]);

      // Get table data (simulated - in production would use pg_dump)
      const backupData: Record<string, unknown> = {
        schemaName: backup.schemaName,
        backupType: backup.backupType,
        createdAt: new Date().toISOString(),
        tables: [],
      };

      let totalRows = 0;
      for (const table of tables) {
        const tableName = table.tablename;

        // Get row count
        const countResult = await queryRunner.query(
          `SELECT count(*) as count FROM "${backup.schemaName}"."${tableName}"`
        );
        const rowCount = parseInt(countResult[0]?.count || '0', 10);
        totalRows += rowCount;

        // Get table structure
        const columns = await queryRunner.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [backup.schemaName, tableName]);

        (backupData.tables as Array<unknown>).push({
          name: tableName,
          rowCount,
          columns,
        });
      }

      // Calculate simulated size
      const sizeBytes = JSON.stringify(backupData).length * (backup.isCompressed ? 0.3 : 1);

      // Generate checksum
      const checksum = crypto
        .createHash('sha256')
        .update(JSON.stringify(backupData))
        .digest('hex');

      // Update backup record
      backup.status = 'completed' as BackupStatus;
      backup.completedAt = new Date();
      backup.sizeBytes = Math.round(sizeBytes);
      backup.checksum = checksum;
      backup.metadata = {
        tableCount: tables.length,
        rowCount: totalRows,
        version: '1.0',
        compressionRatio: backup.isCompressed ? 0.3 : 1,
      };

      await this.backupRepository.save(backup);

      // Update schema last backup time
      if (backup.tenantId) {
        await this.schemaRepository.update(
          { tenantId: backup.tenantId },
          { lastBackupAt: new Date() },
        );
      }

      this.logger.log(`Backup completed: ${backup.id} (${backup.sizeBytes} bytes)`);
      return backup;
    } catch (err) {
      const error = err as Error;
      backup.status = 'failed' as BackupStatus;
      backup.errorMessage = error.message;
      backup.completedAt = new Date();
      await this.backupRepository.save(backup);

      this.logger.error(`Backup failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get backup by ID
   */
  async getBackup(backupId: string): Promise<SchemaBackup> {
    const backup = await this.backupRepository.findOne({
      where: { id: backupId },
    });

    if (!backup) {
      throw new NotFoundException(`Backup not found: ${backupId}`);
    }

    return backup;
  }

  /**
   * Get backups for tenant
   */
  async getBackupsForTenant(tenantId: string): Promise<SchemaBackup[]> {
    return this.backupRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get all backups with pagination
   */
  async getAllBackups(options: {
    page?: number;
    limit?: number;
    status?: BackupStatus;
    backupType?: BackupType;
  }): Promise<{
    data: SchemaBackup[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status, backupType } = options;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (backupType) where.backupType = backupType;

    const [data, total] = await this.backupRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Delete backup
   */
  async deleteBackup(backupId: string): Promise<void> {
    const backup = await this.getBackup(backupId);

    // In production, also delete the actual file
    // await this.deleteBackupFile(backup.filePath);

    await this.backupRepository.delete({ id: backupId });
    this.logger.log(`Backup deleted: ${backupId}`);
  }

  // ============================================================================
  // Restore Operations
  // ============================================================================

  /**
   * Restore from backup
   */
  async restoreFromBackup(options: RestoreOptions): Promise<SchemaRestore> {
    const { backupId, targetSchemaName, pointInTime, tablesToRestore, skipValidation = false } = options;

    this.logger.log(`Restoring from backup: ${backupId}`);

    const backup = await this.getBackup(backupId);

    if (backup.status !== 'completed') {
      throw new BadRequestException('Cannot restore from incomplete backup');
    }

    // Validate checksum if not skipped
    if (!skipValidation) {
      await this.validateBackupIntegrity(backup);
    }

    const finalSchemaName = targetSchemaName || backup.schemaName;

    // Create restore record
    const restore = this.restoreRepository.create({
      backupId,
      tenantId: backup.tenantId,
      targetSchemaName: finalSchemaName,
      status: 'pending' as RestoreStatus,
      isPointInTime: !!pointInTime,
      pointInTimeTarget: pointInTime,
    });
    await this.restoreRepository.save(restore);

    // Execute restore
    return this.executeRestore(restore, backup, tablesToRestore);
  }

  /**
   * Execute restore process
   */
  private async executeRestore(
    restore: SchemaRestore,
    backup: SchemaBackup,
    tablesToRestore?: string[],
  ): Promise<SchemaRestore> {
    restore.status = 'in_progress' as RestoreStatus;
    restore.startedAt = new Date();
    await this.restoreRepository.save(restore);

    const startTime = Date.now();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.startTransaction();

      // Set search path
      await queryRunner.query(`SET search_path TO "${restore.targetSchemaName}"`);

      // Simulate restore by creating tables (in production would use pg_restore)
      const restoredTables: string[] = [];

      // Get tables to restore
      const allTables = backup.metadata?.tableCount || 0;
      const tablesToProcess = tablesToRestore || Array.from({ length: allTables }, (_, i) => `table_${i}`);

      for (const tableName of tablesToProcess) {
        restoredTables.push(tableName);
      }

      await queryRunner.commitTransaction();

      // Update restore record
      restore.status = 'completed' as RestoreStatus;
      restore.completedAt = new Date();
      restore.executionTimeMs = Date.now() - startTime;
      restore.restoredTables = restoredTables;
      await this.restoreRepository.save(restore);

      this.logger.log(`Restore completed: ${restore.id}`);
      return restore;
    } catch (err) {
      const error = err as Error;
      await queryRunner.rollbackTransaction();

      restore.status = 'failed' as RestoreStatus;
      restore.errorMessage = error.message;
      restore.executionTimeMs = Date.now() - startTime;
      await this.restoreRepository.save(restore);

      this.logger.error(`Restore failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Point-in-time recovery
   */
  async pointInTimeRecovery(
    tenantId: string,
    targetTime: Date,
  ): Promise<SchemaRestore> {
    this.logger.log(`Point-in-time recovery for tenant ${tenantId} to ${targetTime.toISOString()}`);

    // Find the most recent backup before target time
    const backup = await this.backupRepository.findOne({
      where: {
        tenantId,
        status: 'completed' as BackupStatus,
        createdAt: LessThan(targetTime),
      },
      order: { createdAt: 'DESC' },
    });

    if (!backup) {
      throw new NotFoundException('No suitable backup found for point-in-time recovery');
    }

    return this.restoreFromBackup({
      backupId: backup.id,
      pointInTime: targetTime,
    });
  }

  /**
   * Validate backup integrity
   */
  private async validateBackupIntegrity(backup: SchemaBackup): Promise<boolean> {
    // In production, would verify checksum against actual file
    if (!backup.checksum) {
      throw new BadRequestException('Backup has no checksum for validation');
    }
    return true;
  }

  /**
   * Get restore history for tenant
   */
  async getRestoreHistory(tenantId: string): Promise<SchemaRestore[]> {
    return this.restoreRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get restore by ID
   */
  async getRestore(restoreId: string): Promise<SchemaRestore> {
    const restore = await this.restoreRepository.findOne({
      where: { id: restoreId },
    });

    if (!restore) {
      throw new NotFoundException(`Restore not found: ${restoreId}`);
    }

    return restore;
  }

  // ============================================================================
  // Scheduled Backups
  // ============================================================================

  /**
   * Daily automatic backup (runs at 2 AM)
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runDailyBackups(): Promise<void> {
    this.logger.log('Running scheduled daily backups');

    const activeSchemas = await this.schemaRepository.find({
      where: { status: 'active' as any },
    });

    for (const schema of activeSchemas) {
      try {
        await this.createBackup({
          tenantId: schema.tenantId,
          backupType: 'incremental',
          compress: true,
          retentionDays: 7,
        });
      } catch (err) {
        const error = err as Error;
        this.logger.error(`Daily backup failed for tenant ${schema.tenantId}: ${error.message}`);
      }
    }
  }

  /**
   * Weekly full backup (runs Sunday at 3 AM)
   */
  @Cron('0 3 * * 0')
  async runWeeklyBackups(): Promise<void> {
    this.logger.log('Running scheduled weekly full backups');

    const activeSchemas = await this.schemaRepository.find({
      where: { status: 'active' as any },
    });

    for (const schema of activeSchemas) {
      try {
        await this.createBackup({
          tenantId: schema.tenantId,
          backupType: 'full',
          compress: true,
          retentionDays: 30,
        });
      } catch (err) {
        const error = err as Error;
        this.logger.error(`Weekly backup failed for tenant ${schema.tenantId}: ${error.message}`);
      }
    }
  }

  /**
   * Cleanup expired backups (runs at 4 AM)
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupExpiredBackups(): Promise<void> {
    this.logger.log('Cleaning up expired backups');

    const expiredBackups = await this.backupRepository.find({
      where: {
        expiresAt: LessThan(new Date()),
        status: 'completed' as BackupStatus,
      },
    });

    for (const backup of expiredBackups) {
      try {
        backup.status = 'expired' as BackupStatus;
        await this.backupRepository.save(backup);
        // In production, also delete actual backup file
        this.logger.log(`Marked backup as expired: ${backup.id}`);
      } catch (err) {
        const error = err as Error;
        this.logger.error(`Failed to expire backup ${backup.id}: ${error.message}`);
      }
    }
  }

  // ============================================================================
  // Summary & Statistics
  // ============================================================================

  /**
   * Get backup summary
   */
  async getBackupSummary(): Promise<{
    totalBackups: number;
    completedBackups: number;
    failedBackups: number;
    totalSizeBytes: number;
    avgSizeBytes: number;
    oldestBackup: Date | null;
    newestBackup: Date | null;
    tenantsWithBackup: number;
    tenantsWithoutBackup: number;
  }> {
    const allBackups = await this.backupRepository.find();
    const allSchemas = await this.schemaRepository.find({
      where: { status: 'active' as any },
    });

    const completedBackups = allBackups.filter(b => b.status === 'completed');
    const totalSizeBytes = completedBackups.reduce((sum, b) => sum + Number(b.sizeBytes), 0);

    const tenantsWithBackup = new Set(
      completedBackups.filter(b => b.tenantId).map(b => b.tenantId)
    ).size;

    const sortedBackups = [...completedBackups].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return {
      totalBackups: allBackups.length,
      completedBackups: completedBackups.length,
      failedBackups: allBackups.filter(b => b.status === 'failed').length,
      totalSizeBytes,
      avgSizeBytes: completedBackups.length > 0 ? Math.round(totalSizeBytes / completedBackups.length) : 0,
      oldestBackup: sortedBackups[0]?.createdAt || null,
      newestBackup: sortedBackups[sortedBackups.length - 1]?.createdAt || null,
      tenantsWithBackup,
      tenantsWithoutBackup: allSchemas.length - tenantsWithBackup,
    };
  }

  /**
   * Get backup schedule status
   */
  async getBackupScheduleStatus(): Promise<{
    dailyBackupEnabled: boolean;
    weeklyBackupEnabled: boolean;
    nextDailyBackup: Date;
    nextWeeklyBackup: Date;
    lastDailyBackup: Date | null;
    lastWeeklyBackup: Date | null;
  }> {
    const lastDaily = await this.backupRepository.findOne({
      where: { backupType: 'incremental' as BackupType },
      order: { createdAt: 'DESC' },
    });

    const lastWeekly = await this.backupRepository.findOne({
      where: { backupType: 'full' as BackupType },
      order: { createdAt: 'DESC' },
    });

    // Calculate next backup times
    const now = new Date();
    const nextDaily = new Date(now);
    nextDaily.setDate(nextDaily.getDate() + 1);
    nextDaily.setHours(2, 0, 0, 0);

    const nextWeekly = new Date(now);
    const daysUntilSunday = (7 - nextWeekly.getDay()) % 7 || 7;
    nextWeekly.setDate(nextWeekly.getDate() + daysUntilSunday);
    nextWeekly.setHours(3, 0, 0, 0);

    return {
      dailyBackupEnabled: true,
      weeklyBackupEnabled: true,
      nextDailyBackup: nextDaily,
      nextWeeklyBackup: nextWeekly,
      lastDailyBackup: lastDaily?.createdAt || null,
      lastWeeklyBackup: lastWeekly?.createdAt || null,
    };
  }
}
