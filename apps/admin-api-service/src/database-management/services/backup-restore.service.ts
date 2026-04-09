/**
 * Backup & Restore Service
 *
 * Tenant database yedekleme ve geri yükleme servisi.
 */

import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import { isValidSchemaName } from '@aquaculture/backend-common';

const execFileAsync = promisify(execFile);

import {
  TenantSchema,
  SchemaStatus,
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
    private readonly configService: ConfigService,
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

  // --------------------------------------------------------------------------
  // pg_dump / pg_restore connection helpers
  // --------------------------------------------------------------------------

  private getPgConnectionArgs(): { host: string; port: string; user: string; db: string; password: string } {
    return {
      host: this.configService.get<string>('DATABASE_HOST', 'localhost'),
      port: this.configService.get<string>('DATABASE_PORT', '5432'),
      user: this.configService.get<string>('DATABASE_USER', 'aquaculture'),
      db: this.configService.get<string>('DATABASE_NAME', 'aquaculture'),
      password: this.configService.get<string>('DATABASE_PASSWORD', ''),
    };
  }

  private getPgEnv(password: string): NodeJS.ProcessEnv {
    return { ...process.env, PGPASSWORD: password };
  }

  /**
   * Execute backup process via pg_dump
   */
  private async executeBackup(
    backup: SchemaBackup,
    excludeTables: string[] = [],
  ): Promise<SchemaBackup> {
    backup.status = 'in_progress' as BackupStatus;
    backup.startedAt = new Date();
    await this.backupRepository.save(backup);

    const pg = this.getPgConnectionArgs();

    // Ensure backup directory exists
    const backupDir = path.join(this.BACKUP_BASE_PATH, backup.schemaName);
    await fs.promises.mkdir(backupDir, { recursive: true });

    const filePath = path.join(backupDir, backup.fileName.replace(/\.sql(\.gz)?$/, '.dump'));

    try {
      // SECURITY: validate schema name before passing to pg_dump
      if (!isValidSchemaName(backup.schemaName)) {
        throw new BadRequestException(`Invalid schema name: ${backup.schemaName}`);
      }

      // Build pg_dump arguments
      const args: string[] = [
        '-h', pg.host,
        '-p', pg.port,
        '-U', pg.user,
        '-d', pg.db,
        `--schema=${backup.schemaName}`,
        '--format=custom',
        `--file=${filePath}`,
      ];

      // Exclude tables if specified
      for (const table of excludeTables) {
        args.push(`--exclude-table=${backup.schemaName}.${table}`);
      }

      if (backup.isCompressed) {
        args.push('--compress=6');
      }

      await execFileAsync('pg_dump', args, {
        env: this.getPgEnv(pg.password),
        timeout: 300_000, // 5 min timeout
      });

      // Read file stats for size + checksum
      const stats = await fs.promises.stat(filePath);

      // Generate checksum from actual dump file
      const fileBuffer = await fs.promises.readFile(filePath);
      const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // Gather table count for metadata
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      let tableCount = 0;
      let totalRows = 0;
      try {
        const tables = await queryRunner.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
          [backup.schemaName],
        );
        tableCount = tables.length;
        for (const table of tables) {
          const countResult = await queryRunner.query(
            `SELECT count(*) as count FROM "${backup.schemaName}"."${table.tablename}"`,
          );
          totalRows += parseInt(countResult[0]?.count || '0', 10);
        }
      } finally {
        await queryRunner.release();
      }

      // Update backup record
      backup.filePath = filePath;
      backup.status = 'completed' as BackupStatus;
      backup.completedAt = new Date();
      backup.sizeBytes = stats.size;
      backup.checksum = checksum;
      backup.metadata = {
        tableCount,
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

      this.logger.log(`Backup completed: ${backup.id} (${backup.sizeBytes} bytes) -> ${filePath}`);
      return backup;
    } catch (err) {
      const error = err as Error;
      backup.status = 'failed' as BackupStatus;
      backup.errorMessage = error.message;
      backup.completedAt = new Date();
      await this.backupRepository.save(backup);

      // Cleanup partial dump file
      await fs.promises.unlink(filePath).catch(() => {});

      this.logger.error(`Backup failed for schema ${backup.schemaName}: ${error.message}`);
      throw error;
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
   * Delete backup (record + dump file)
   */
  async deleteBackup(backupId: string): Promise<void> {
    const backup = await this.getBackup(backupId);

    // Delete the actual dump file from disk
    if (backup.filePath) {
      await fs.promises.unlink(backup.filePath).catch((err) => {
        this.logger.warn(`Could not delete backup file ${backup.filePath}: ${err.message}`);
      });
    }

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
   * Execute restore process via pg_restore
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

    try {
      // SECURITY: Validate schema name before using in pg_restore
      if (!isValidSchemaName(restore.targetSchemaName)) {
        throw new BadRequestException('Invalid schema name');
      }

      // Resolve backup file path
      const filePath = backup.filePath || path.join(
        this.BACKUP_BASE_PATH,
        backup.schemaName,
        backup.fileName.replace(/\.sql(\.gz)?$/, '.dump'),
      );

      // Verify backup file exists
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch {
        throw new NotFoundException(`Backup file not found: ${filePath}`);
      }

      const pg = this.getPgConnectionArgs();

      // Build pg_restore arguments
      const args: string[] = [
        '-h', pg.host,
        '-p', pg.port,
        '-U', pg.user,
        '-d', pg.db,
        `--schema=${backup.schemaName}`,
        '--clean',
        '--if-exists',
      ];

      // Restore specific tables if requested
      if (tablesToRestore && tablesToRestore.length > 0) {
        for (const table of tablesToRestore) {
          args.push(`--table=${table}`);
        }
      }

      args.push(filePath);

      await execFileAsync('pg_restore', args, {
        env: this.getPgEnv(pg.password),
        timeout: 600_000, // 10 min timeout for restores
      });

      // Get list of restored tables for metadata
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      let restoredTables: string[] = [];
      try {
        const tables = await queryRunner.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
          [restore.targetSchemaName],
        );
        restoredTables = tables.map((t: { tablename: string }) => t.tablename);
      } finally {
        await queryRunner.release();
      }

      // Update restore record
      restore.status = 'completed' as RestoreStatus;
      restore.completedAt = new Date();
      restore.executionTimeMs = Date.now() - startTime;
      restore.restoredTables = restoredTables;
      await this.restoreRepository.save(restore);

      this.logger.log(`Restore completed: ${restore.id} (${restore.executionTimeMs}ms)`);
      return restore;
    } catch (err) {
      const error = err as Error;

      restore.status = 'failed' as RestoreStatus;
      restore.errorMessage = error.message;
      restore.executionTimeMs = Date.now() - startTime;
      await this.restoreRepository.save(restore);

      this.logger.error(`Restore failed: ${error.message}`);
      throw error;
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
   * Validate backup integrity by verifying SHA-256 checksum against actual file
   */
  private async validateBackupIntegrity(backup: SchemaBackup): Promise<boolean> {
    if (!backup.checksum) {
      throw new BadRequestException('Backup has no checksum for validation');
    }

    const filePath = backup.filePath || path.join(
      this.BACKUP_BASE_PATH,
      backup.schemaName,
      backup.fileName.replace(/\.sql(\.gz)?$/, '.dump'),
    );

    try {
      const fileBuffer = await fs.promises.readFile(filePath);
      const actualChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (actualChecksum !== backup.checksum) {
        throw new BadRequestException(
          `Backup integrity check failed: expected ${backup.checksum}, got ${actualChecksum}`,
        );
      }

      return true;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new NotFoundException(`Backup file not found or unreadable: ${filePath}`);
    }
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
      where: { status: 'active' as SchemaStatus },
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
      where: { status: 'active' as SchemaStatus },
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
        // Delete dump file from disk before marking as expired
        if (backup.filePath) {
          await fs.promises.unlink(backup.filePath).catch((err) => {
            this.logger.warn(`Could not delete expired backup file ${backup.filePath}: ${err.message}`);
          });
        }
        backup.status = 'expired' as BackupStatus;
        await this.backupRepository.save(backup);
        this.logger.log(`Expired and cleaned backup: ${backup.id}`);
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
      where: { status: 'active' as SchemaStatus },
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
