/**
 * Backup & Restore Service
 *
 * Tenant database yedekleme ve geri yükleme servisi.
 */

import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

import { isValidSchemaName } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';

import {
  TenantSchema,
  SchemaStatus,
  SchemaBackup,
  RetiredSchemaBackup,
  SchemaRestore,
  BackupStatus,
  RestoreStatus,
  BackupType,
  BackupOptions,
  RestoreOptions,
} from '../entities/database-management.entity';
import { AuditLogInput, AuditLogService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/audit.entity';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

const execFileAsync = promisify(execFile);
const ENCRYPTED_BACKUP_MAGIC = Buffer.from('AQBKP2');
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const RUNTIME_RESTORE_AUTHORITY_ERROR =
  'Runtime database restore is disabled. Use the audited db-migrate restore workflow instead.';

function ignoreCleanupError(_error: unknown): void {
  void _error;
}

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
    @InjectRepository(RetiredSchemaBackup)
    private readonly retiredBackupRepository: Repository<RetiredSchemaBackup>,
    @InjectRepository(SchemaRestore)
    private readonly restoreRepository: Repository<SchemaRestore>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
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
      retentionDays = this.DEFAULT_RETENTION_DAYS,
      excludeTables = [],
    } = options;
    const encrypt = this.resolveBackupEncryption(options.encrypt);

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

    await this.requireAuditLog({
      action: 'SCHEMA_BACKUP_CREATE_REQUESTED',
      entityType: 'schema_backup',
      entityId: tenantId,
      tenantId,
      performedBy: options.auditActorId ?? 'system',
      severity: AuditSeverity.CRITICAL,
      details: {
        schemaName,
        backupType,
        retentionDays,
        excludeTables,
        encrypted: encrypt,
      },
    });

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
  // pg_dump connection helpers
  // --------------------------------------------------------------------------

  private getPgConnectionArgs(): {
    host: string;
    port: string;
    user: string;
    db: string;
    password: string;
  } {
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

  private resolveBackupEncryption(requestedEncrypt?: boolean): true {
    if (requestedEncrypt === false) {
      throw new BadRequestException('Plaintext database backups are not allowed');
    }
    return true;
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

    const encryptedFilePath = path.join(
      backupDir,
      `${backup.fileName.replace(/\.sql(\.gz)?$/, '.dump')}.enc`,
    );

    try {
      // SECURITY: validate schema name before passing to pg_dump
      if (!isValidSchemaName(backup.schemaName)) {
        throw new BadRequestException(`Invalid schema name: ${backup.schemaName}`);
      }

      // Build pg_dump arguments
      const args: string[] = [
        '-h',
        pg.host,
        '-p',
        pg.port,
        '-U',
        pg.user,
        '-d',
        pg.db,
        `--schema=${backup.schemaName}`,
        '--format=custom',
      ];

      // Exclude tables if specified
      for (const table of excludeTables) {
        args.push(`--exclude-table=${backup.schemaName}.${table}`);
      }

      if (backup.isCompressed) {
        args.push('--compress=6');
      }

      const finalFilePath = encryptedFilePath;
      await this.executeEncryptedPgDump(args, finalFilePath, this.getPgEnv(pg.password));

      // Read file stats for size + checksum
      const stats = await fs.promises.stat(finalFilePath);

      // Generate checksum from actual persisted backup file
      const fileBuffer = await fs.promises.readFile(finalFilePath);
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
      backup.filePath = finalFilePath;
      backup.fileName = path.basename(finalFilePath);
      backup.status = 'completed' as BackupStatus;
      backup.completedAt = new Date();
      backup.sizeBytes = stats.size;
      backup.checksum = checksum;
      backup.metadata = {
        tableCount,
        rowCount: totalRows,
        version: '1.0',
        compressionRatio: backup.isCompressed ? 0.3 : 1,
        ...(backup.isEncrypted
          ? {
              encryptionAlgorithm: ENCRYPTION_ALGORITHM,
              encryptionKeyId: this.getBackupEncryptionKeyId(),
            }
          : {}),
      };

      await this.backupRepository.save(backup);

      // Tenant schema evidence is db-migrate/provisioner owned. The backup
      // ledger above is the durable record for this backup operation.

      this.logger.log(
        `Backup completed: ${backup.id} (${backup.sizeBytes} bytes) -> ${finalFilePath}`,
      );
      return backup;
    } catch (err) {
      const error = err as Error;
      backup.status = 'failed' as BackupStatus;
      backup.errorMessage = error.message;
      backup.completedAt = new Date();
      await this.backupRepository.save(backup);

      // Cleanup partial dump file
      await fs.promises.unlink(encryptedFilePath).catch(ignoreCleanupError);

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
  }): Promise<IStandardPaginatedResult<SchemaBackup>> {
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

    return createStandardPaginatedResult(data, total, page, limit);
  }

  /**
   * Delete backup (record + dump file)
   */
  async deleteBackup(backupId: string, auditActorId = 'system'): Promise<void> {
    const backup = await this.getBackup(backupId);

    await this.requireAuditLog({
      action: 'SCHEMA_BACKUP_DELETE_REQUESTED',
      entityType: 'schema_backup',
      entityId: backupId,
      tenantId: backup.tenantId ?? undefined,
      performedBy: auditActorId,
      severity: AuditSeverity.CRITICAL,
      details: {
        schemaName: backup.schemaName,
        fileName: backup.fileName,
      },
    });

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
    const { backupId, targetSchemaName, pointInTime, tablesToRestore } = options;

    this.logger.log(`Restoring from backup: ${backupId}`);

    const backup = await this.getBackup(backupId);

    if (backup.status !== 'completed') {
      throw new BadRequestException('Cannot restore from incomplete backup');
    }

    const finalSchemaName = targetSchemaName || backup.schemaName;
    if (!isValidSchemaName(finalSchemaName)) {
      throw new BadRequestException('Invalid schema name');
    }

    await this.requireAuditLog({
      action: 'SCHEMA_RESTORE_REQUESTED',
      entityType: 'schema_restore',
      entityId: backupId,
      tenantId: backup.tenantId ?? undefined,
      performedBy: options.auditActorId ?? 'system',
      severity: AuditSeverity.CRITICAL,
      details: {
        sourceSchemaName: backup.schemaName,
        targetSchemaName: finalSchemaName,
        pointInTime: pointInTime?.toISOString(),
        tablesToRestore,
      },
    });

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
   * Reject runtime restore attempts at the application authority boundary.
   */
  private async executeRestore(
    restore: SchemaRestore,
    _backup: SchemaBackup,
    _tablesToRestore?: string[],
  ): Promise<SchemaRestore> {
    const startTime = Date.now();
    restore.status = 'failed' as RestoreStatus;
    restore.errorMessage = RUNTIME_RESTORE_AUTHORITY_ERROR;
    restore.executionTimeMs = Date.now() - startTime;
    restore.completedAt = new Date();
    await this.restoreRepository.save(restore);

    this.logger.error(
      `Restore rejected by authority boundary: ${restore.id} -> ${restore.targetSchemaName}`,
    );
    throw new BadRequestException(RUNTIME_RESTORE_AUTHORITY_ERROR);
  }

  /**
   * Point-in-time recovery
   */
  async pointInTimeRecovery(
    tenantId: string,
    targetTime: Date,
    auditActorId = 'system',
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
      auditActorId,
    });
  }

  private async requireAuditLog(input: AuditLogInput): Promise<void> {
    const auditLog = await this.auditLogService.log(input);
    if (!auditLog?.id) {
      throw new InternalServerErrorException(
        `Database management audit log could not be persisted for ${input.action}`,
      );
    }
  }

  private async executeEncryptedPgDump(
    args: string[],
    encryptedPath: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const key = this.getBackupEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const output = fs.createWriteStream(encryptedPath, {
      flags: 'w',
      mode: 0o600,
    });
    const pgDump = spawn('pg_dump', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];

    pgDump.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    output.write(Buffer.concat([ENCRYPTED_BACKUP_MAGIC, iv]));

    const exitPromise = new Promise<void>((resolve, reject) => {
      pgDump.once('error', reject);
      pgDump.once('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`pg_dump failed with exit code ${code}${stderr ? `: ${stderr}` : ''}`));
      });
    });

    await Promise.all([
      pipeline(pgDump.stdout, cipher, output),
      exitPromise,
    ]);
    await fs.promises.appendFile(encryptedPath, cipher.getAuthTag(), { mode: 0o600 });
  }

  private getBackupEncryptionKey(): Buffer {
    const configured = this.configService.get<string>('BACKUP_ENCRYPTION_KEY', '').trim();
    if (!configured) {
      throw new BadRequestException('BACKUP_ENCRYPTION_KEY is required for encrypted backups');
    }

    const decoded = this.decodeBackupEncryptionKey(configured);
    if (decoded.length !== 32) {
      throw new BadRequestException('BACKUP_ENCRYPTION_KEY must decode to 32 bytes');
    }
    return decoded;
  }

  private decodeBackupEncryptionKey(value: string): Buffer {
    if (/^[a-f0-9]{64}$/i.test(value)) {
      return Buffer.from(value, 'hex');
    }

    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
    return Buffer.from(value, 'utf8');
  }

  private getBackupEncryptionKeyId(): string {
    const key = this.getBackupEncryptionKey();
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
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
          encrypt: true,
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
          encrypt: true,
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
    const now = new Date();

    const expiredBackups = await this.backupRepository.find({
      where: {
        expiresAt: LessThan(now),
        status: 'completed' as BackupStatus,
      },
    });

    for (const backup of expiredBackups) {
      try {
        // Delete dump file from disk before marking as expired
        if (backup.filePath) {
          await fs.promises.unlink(backup.filePath).catch((err) => {
            this.logger.warn(
              `Could not delete expired backup file ${backup.filePath}: ${err.message}`,
            );
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

    await this.cleanupExpiredRetiredBackups(now);
  }

  private async cleanupExpiredRetiredBackups(now: Date): Promise<void> {
    const expiredRetiredBackups = (await this.retiredBackupRepository.find({
      where: {
        expiresAt: LessThan(now),
      },
    })).filter((backup) => backup.status !== 'expired');

    for (const backup of expiredRetiredBackups) {
      try {
        const artifactDisposition = await this.disposeRetiredBackupArtifact(backup);
        const disposedAt = new Date().toISOString();
        backup.status = 'expired' as BackupStatus;
        backup.metadata = {
          ...(backup.metadata ?? {}),
          plaintextArtifactDisposition: artifactDisposition,
          plaintextArtifactDisposedAt: disposedAt,
        };
        await this.retiredBackupRepository.save(backup);
        this.logger.log(`Expired retired plaintext backup ledger row: ${backup.backupId}`);
      } catch (err) {
        const error = err as Error;
        this.logger.error(
          `Failed to expire retired plaintext backup ${backup.backupId}: ${error.message}`,
        );
      }
    }
  }

  private async disposeRetiredBackupArtifact(
    backup: RetiredSchemaBackup,
  ): Promise<'deleted' | 'missing' | 'no_file_path'> {
    if (!backup.filePath) {
      return 'no_file_path';
    }

    try {
      await fs.promises.unlink(backup.filePath);
      return 'deleted';
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return 'missing';
      }
      throw error;
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

    const completedBackups = allBackups.filter((b) => b.status === 'completed');
    const totalSizeBytes = completedBackups.reduce((sum, b) => sum + Number(b.sizeBytes), 0);

    const tenantsWithBackup = new Set(
      completedBackups.filter((b) => b.tenantId).map((b) => b.tenantId),
    ).size;

    const sortedBackups = [...completedBackups].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return {
      totalBackups: allBackups.length,
      completedBackups: completedBackups.length,
      failedBackups: allBackups.filter((b) => b.status === 'failed').length,
      totalSizeBytes,
      avgSizeBytes:
        completedBackups.length > 0 ? Math.round(totalSizeBytes / completedBackups.length) : 0,
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
