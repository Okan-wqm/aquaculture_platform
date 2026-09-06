/**
 * Database Explorer Controller
 *
 * Veritabanı tablolarını görüntüleme ve veri ekleme/güncelleme/silme endpoint'leri.
 * SUPER_ADMIN için geliştirme ve debug amaçlı.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
  ForbiddenException,
  Logger,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type, Transform } from 'class-transformer';
import { IsOptional, IsNumber, IsString, IsIn, IsObject, Matches } from 'class-validator';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import type { AuditLogInput } from '../../audit/audit.service';
import { AuditLogService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/audit.entity';
import { getAuthUserEmail, requireAuthUserId } from '../../shared/authenticated-request';

import { ThrottleSensitive, ThrottleExport } from '@aquaculture/backend-common/security';
import { MODULE_SCHEMAS, DEFAULT_TENANT_MODULES } from '@aquaculture/backend-common/database';
import { expectedTotalPages } from '@platform/pagination-contracts';
// ============================================================================
// Module Table Access Control
// ============================================================================

/**
 * Schemas that the superadmin database explorer is allowed to access.
 * Tenant schemas (tenant_*) and module schemas (sensor, farm, hr, hydroponics)
 * are intentionally excluded.
 */
const ALLOWED_SCHEMAS = new Set(['public', 'auth', 'admin', 'billing']);

/**
 * Table names belonging to tenant modules — derived from MODULE_SCHEMAS (single source of truth).
 * These tables exist in the public schema but contain tenant-specific data
 * and must not be accessible through the superadmin explorer.
 */
const MODULE_TABLE_NAMES: Set<string> = new Set(MODULE_SCHEMAS.flatMap((m) => m.tables));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MODULE_TABLE_REFERENCE_PATTERNS = [...MODULE_TABLE_NAMES].map((tableName) => {
  const escapedTableName = escapeRegExp(tableName);
  return new RegExp(
    String.raw`\b(?:FROM|JOIN|TABLE)\s+(?:(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?)"?${escapedTableName}"?\b`,
    'i',
  );
});

// ============================================================================
// Sensitive Column Masking Configuration
// ============================================================================

const SENSITIVE_COLUMNS = [
  'password',
  'password_hash',
  'hashed_password',
  'secret',
  'api_key',
  'api_secret',
  'access_token',
  'refresh_token',
  'token',
  'mfa_secret',
  'totp_secret',
  'private_key',
  'encryption_key',
  'salt',
  'hash',
  'credential',
  'credentials',
  'oauth_token',
  'bearer_token',
  'jwt_secret',
  'stripe_secret',
  'webhook_secret',
];

const MASKED_VALUE = '********';

/**
 * Check if column name indicates sensitive data
 */
function isSensitiveColumn(columnName: string): boolean {
  const lowerName = columnName.toLowerCase();
  return SENSITIVE_COLUMNS.some(
    (sensitive) =>
      lowerName === sensitive ||
      lowerName.includes(sensitive) ||
      lowerName.endsWith('_' + sensitive) ||
      lowerName.startsWith(sensitive + '_'),
  );
}

/**
 * Mask sensitive data in a row
 */
function maskSensitiveData(
  row: Record<string, unknown>,
  columns: { columnName: string }[],
): Record<string, unknown> {
  const maskedRow = { ...row };
  for (const col of columns) {
    if (isSensitiveColumn(col.columnName) && maskedRow[col.columnName] !== null) {
      maskedRow[col.columnName] = MASKED_VALUE;
    }
  }
  return maskedRow;
}

// ============================================================================
// DTOs
// ============================================================================

class TableQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'orderBy must be a valid SQL identifier' })
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';

  // H-S2-01: Dead `filter` field removed. It was declared in the DTO but never
  // used in the query builder, creating a latent SQL injection vector if a future
  // developer adds WHERE interpolation following the DTO field name convention.

  // Fix: C12 -- includeSensitive kaldırıldı, sensitive data her zaman maskelenir
}

class ExportQueryDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'orderBy must be a valid SQL identifier' })
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';
}

class InsertRowDto {
  @IsObject()
  data!: Record<string, unknown>;
}

class UpdateRowDto {
  @IsObject()
  data!: Record<string, unknown>;
}

/**
 * SECURITY: DTO for raw SQL query execution
 * Only for SUPER_ADMIN in development/staging environments
 */
class ExecuteQueryDto {
  @IsString()
  @Transform(({ value }) => value?.trim())
  sql!: string;

  @IsOptional()
  params?: unknown[];
}

// ============================================================================
// Types
// ============================================================================

interface TableInfo {
  tableName: string;
  schemaName: string;
  rowCount: number;
  sizeBytes: number;
  columns: ColumnInfo[];
}

interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyColumn?: string;
  isSensitive?: boolean;
}

interface TableData {
  tableName: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  limit: number;
  totalPages: number;
}

type ExplorerWriteOperation = 'insert' | 'update' | 'delete';

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Database Management')
@Controller('database/explorer')
export class DatabaseExplorerController {
  private readonly logger = new Logger(DatabaseExplorerController.name);

  constructor(
    /**
     * SECURITY (ADMIN-CRITICAL-004): Use a dedicated read-only DataSource.
     * This connection has `default_transaction_read_only=on` at the PG level,
     * so any DML/DDL statement is rejected by the database itself.
     * Defense-in-depth: each query runner also executes SET TRANSACTION READ ONLY.
     */
    @InjectDataSource('explorer-readonly')
    private readonly readOnlyDataSource: DataSource,
    /**
     * Write operations are a separate, explicit dependency. Reads and raw SQL
     * never use this DataSource; CRUD endpoints reach it only after the feature
     * flag, production guard, schema/table allowlist, and audit intent pass.
     */
    @InjectDataSource()
    private readonly writeDataSource: DataSource,
    /**
     * SECURITY (ADMIN-MEDIUM-002): All explorer queries are persisted to the
     * compliance_audit_log table for SOC 2 compliance. Previously only written
     * to Logger (volatile, not queryable by auditors).
     */
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * SECURITY (ADMIN-CRITICAL-005): Create a read-only query runner.
   * Sets TRANSACTION READ ONLY as an additional safety layer on top of
   * the connection-level read-only default.
   *
   * @returns A connected QueryRunner in read-only transaction mode
   */
  private async createReadOnlyQueryRunner(): Promise<ReturnType<DataSource['createQueryRunner']>> {
    const queryRunner = this.readOnlyDataSource.createQueryRunner();
    await queryRunner.connect();
    // SECURITY: Defense-in-depth — SET TRANSACTION READ ONLY on every query
    await queryRunner.query('SET TRANSACTION READ ONLY');
    return queryRunner;
  }

  /**
   * Create a write-capable query runner for write operations when the
   * ENABLE_DB_EXPLORER_WRITES flag is enabled. Write operations previously
   * used createReadOnlyQueryRunner() which set SET TRANSACTION READ ONLY,
   * making writes silently fail even when the feature flag was enabled.
   */
  private async createWriteQueryRunner(): Promise<ReturnType<DataSource['createQueryRunner']>> {
    const queryRunner = this.writeDataSource.createQueryRunner();
    await queryRunner.connect();
    return queryRunner;
  }

  /**
   * Validate that the requested schema and table are accessible via the explorer.
   * Blocks access to module schemas, tenant schemas, and module tables.
   */
  private validateExplorerAccess(schema: string, table?: string): void {
    if (!ALLOWED_SCHEMAS.has(schema)) {
      throw new BadRequestException(`Schema '${schema}' is not accessible`);
    }
    if (table && MODULE_TABLE_NAMES.has(table)) {
      throw new BadRequestException(`Table '${table}' is not accessible`);
    }
  }

  private assertExplorerWritesEnabled(): void {
    if (process.env['ENABLE_DB_EXPLORER_WRITES'] !== 'true') {
      throw new ForbiddenException(
        'Database write operations are disabled. Set ENABLE_DB_EXPLORER_WRITES=true to enable.',
      );
    }
    if (process.env['NODE_ENV'] === 'production') {
      throw new ForbiddenException('Database explorer writes are disabled in production');
    }
  }

  private async requireAuditLog(input: AuditLogInput): Promise<void> {
    const auditLog = await this.auditLogService.log(input);
    if (!auditLog) {
      throw new ForbiddenException('Database explorer operation could not be audited');
    }
  }

  private async auditExplorerWriteIntent(
    req: Request,
    operation: ExplorerWriteOperation,
    schema: string,
    table: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.requireAuditLog({
      action: `DATABASE_EXPLORER_${operation.toUpperCase()}_INTENT`,
      entityType: 'DatabaseTable',
      performedBy: requireAuthUserId(req),
      performedByEmail: getAuthUserEmail(req),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      severity: AuditSeverity.CRITICAL,
      details: {
        schema,
        table,
        operation,
        ...details,
      },
    });
  }

  // ============================================================================
  // Table Listing
  // ============================================================================

  /**
   * Tüm şemaları listele
   */
  @Get('schemas')
  async getSchemas() {
    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      const schemas = await queryRunner.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name IN ('public', 'auth', 'admin', 'billing')
        ORDER BY schema_name
      `);

      return schemas.map((s: { schema_name: string }) => s.schema_name);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Belirli şemadaki tüm tabloları listele
   */
  @Get('schemas/:schema/tables')
  async getTables(@Param('schema') schema: string): Promise<TableInfo[]> {
    if (!this.isValidIdentifier(schema)) {
      throw new BadRequestException('Invalid schema name');
    }
    this.validateExplorerAccess(schema);

    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      // Tablo bilgilerini al (DISTINCT ile duplicate önleme)
      const tables = await queryRunner.query(
        `
        SELECT DISTINCT ON (t.tablename)
          t.tablename as table_name,
          t.schemaname as schema_name,
          COALESCE(s.n_live_tup, 0) as row_count,
          COALESCE(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)), 0) as size_bytes
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
        WHERE t.schemaname = $1
        ORDER BY t.tablename
      `,
        [schema],
      );

      // Filter out module tables from the listing
      const filteredTables = tables.filter(
        (t: { table_name: string }) => !MODULE_TABLE_NAMES.has(t.table_name),
      );

      // Bulk fetch column info for all tables in a single query instead of N+1
      const tableNames = filteredTables.map((t: { table_name: string }) => t.table_name);
      const allColumnsMap = await this.getBulkColumnInfo(queryRunner, schema, tableNames);

      const result: TableInfo[] = [];

      for (const table of filteredTables) {
        result.push({
          tableName: table.table_name,
          schemaName: table.schema_name,
          rowCount: parseInt(table.row_count, 10),
          sizeBytes: parseInt(table.size_bytes, 10),
          columns: allColumnsMap.get(table.table_name) || [],
        });
      }

      return result;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Public şemadaki tabloları listele (kısayol)
   */
  @Get('tables')
  async getPublicTables(): Promise<TableInfo[]> {
    return this.getTables('public');
  }

  // ============================================================================
  // Table Data
  // ============================================================================

  /**
   * Tablonun verilerini getir
   */
  @Get('schemas/:schema/tables/:table/data')
  async getTableData(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Query() query: TableQueryDto,
    @Req() req: Request,
  ): Promise<TableData> {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const offset = (page - 1) * limit;
    const orderBy = query.orderBy && this.isValidIdentifier(query.orderBy) ? query.orderBy : null;
    const orderDirection = query.orderDirection === 'DESC' ? 'DESC' : 'ASC';
    // Fix: C12 -- sensitive data her zaman maskelenir, client kontrolü kaldırıldı

    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      // Sütun bilgilerini al
      const columns = await this.getColumnInfo(queryRunner, schema, table);

      // Add sensitive flag to columns
      const columnsWithSensitive = columns.map((col) => ({
        ...col,
        isSensitive: isSensitiveColumn(col.columnName),
      }));

      // Toplam satır sayısı
      const countResult = await queryRunner.query(
        `SELECT COUNT(*) as count FROM "${schema}"."${table}"`,
      );
      const totalRows = parseInt(countResult[0]?.count || '0', 10);
      // The row browser carries column metadata alongside its page, so it
      // cannot BE a `PaginationResultV1`; it takes its page arithmetic from
      // the same authority instead of deriving a second answer.
      const totalPages = expectedTotalPages(totalRows, limit);

      // Verileri al - SECURITY: Use parameterized queries for LIMIT and OFFSET
      let dataQuery = `SELECT * FROM "${schema}"."${table}"`;
      const queryParams: (string | number)[] = [];
      let paramIndex = 1;

      if (orderBy) {
        dataQuery += ` ORDER BY "${orderBy}" ${orderDirection}`;
      }

      // SECURITY: Use parameterized values for LIMIT and OFFSET to prevent SQL injection
      dataQuery += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      queryParams.push(limit, offset);

      const rawRows = await queryRunner.query(dataQuery, queryParams);

      // Fix: C12 -- sensitive data her zaman maskelenir
      const rows = rawRows.map((row: Record<string, unknown>) =>
        maskSensitiveData(row, columnsWithSensitive),
      );

      // ADMIN-MEDIUM-002: Persist to compliance_audit_log (SOC 2 requirement).
      // Logger-only audit was volatile and not queryable by compliance auditors.
      this.logger.log(
        `[AUDIT] Data access: ${schema}.${table} (page=${page}, rows=${rows.length})`,
      );
      // AUDITTRAIL-HIGH-009 cure: SUPER_ADMIN cross-tenant data access
      // is the highest-criticality audit class. Awaiting the log propagates
      // a failure as 500 to the caller — operator sees a clear error
      // instead of a half-recorded SUPER_ADMIN data access. The
      // pre-fix `.catch(() => warn log)` pattern dropped audit rows
      // under transient DB blips, leaving the access invisible in the
      // SOC 2 CC4 evidence chain.
      await this.requireAuditLog({
        action: 'DATABASE_EXPLORER_READ',
        entityType: 'DatabaseTable',
        performedBy: requireAuthUserId(req),
        performedByEmail: getAuthUserEmail(req),
        details: { schema, table, page, limit, rowsReturned: rows.length },
      });

      return {
        tableName: table,
        columns: columnsWithSensitive,
        rows,
        totalRows,
        page,
        limit,
        totalPages,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Export table data to CSV or JSON
   */
  // Fix: H8 -- per-route throttle: data export is rate-limited (5 req / hour)
  @ThrottleExport()
  @Get('schemas/:schema/tables/:table/export')
  async exportTableData(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Query() query: ExportQueryDto,
    @Req() req: Request,
  ): Promise<StreamableFile> {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    const format = query.format || 'csv';
    const limit = Math.min(10000, Math.max(1, query.limit || 1000)); // Max 10K rows for export
    const orderBy = query.orderBy && this.isValidIdentifier(query.orderBy) ? query.orderBy : null;
    const orderDirection = query.orderDirection === 'DESC' ? 'DESC' : 'ASC';

    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      // Get column info
      const columns = await this.getColumnInfo(queryRunner, schema, table);
      const columnsWithSensitive = columns.map((col) => ({
        ...col,
        isSensitive: isSensitiveColumn(col.columnName),
      }));

      // Build query
      let dataQuery = `SELECT * FROM "${schema}"."${table}"`;
      const queryParams: number[] = [];
      let paramIndex = 1;

      if (orderBy) {
        dataQuery += ` ORDER BY "${orderBy}" ${orderDirection}`;
      }

      dataQuery += ` LIMIT $${paramIndex++}`;
      queryParams.push(limit);

      const rawRows = await queryRunner.query(dataQuery, queryParams);

      // Always mask sensitive data for exports
      const rows = rawRows.map((row: Record<string, unknown>) =>
        maskSensitiveData(row, columnsWithSensitive),
      );

      // ADMIN-MEDIUM-002: Persist data export to compliance_audit_log.
      this.logger.warn(
        `[AUDIT] Data export: ${schema}.${table} (format=${format}, rows=${rows.length})`,
      );
      // AUDITTRAIL-HIGH-009 cure: data EXPORT is the highest-leak-risk
      // SUPER_ADMIN action. Awaiting the audit row propagates failure
      // as 500 — the export is BLOCKED until the audit row commits.
      await this.requireAuditLog({
        action: 'DATABASE_EXPLORER_EXPORT',
        entityType: 'DatabaseTable',
        performedBy: requireAuthUserId(req),
        performedByEmail: getAuthUserEmail(req),
        severity: AuditSeverity.WARNING,
        details: { schema, table, format, rowsExported: rows.length },
      });

      if (format === 'json') {
        // A StreamableFile, not a bare array: the global ResponseInterceptor
        // maps every ordinary handler return into `{success,data,meta}`, so the
        // JSON export downloaded the envelope under the attachment filename
        // instead of the rows. The interceptor's binary passthrough streams
        // this untouched.
        const jsonBuffer = Buffer.from(JSON.stringify(rows), 'utf-8');
        return new StreamableFile(jsonBuffer, {
          type: 'application/json',
          disposition: `attachment; filename="${table}_export.json"`,
        });
      }

      // CSV format
      const columnNames = columns.map((c) => c.columnName);
      const csvHeader = columnNames.join(',');
      const csvRows = rows.map((row: Record<string, unknown>) =>
        columnNames
          .map((col) => {
            const value = row[col];
            if (value === null || value === undefined) return '';
            if (typeof value === 'string') {
              // Escape quotes and wrap in quotes
              return `"${value.replace(/"/g, '""')}"`;
            }
            if (typeof value === 'object') {
              return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
            }
            return String(value);
          })
          .join(','),
      );

      const csvContent = [csvHeader, ...csvRows].join('\n');
      const buffer = Buffer.from(csvContent, 'utf-8');

      // Headers travel with the StreamableFile so the response never needs the
      // `@Res` escape hatch — which is what made the two formats diverge in the
      // first place.
      return new StreamableFile(buffer, {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="${table}_export.csv"`,
      });
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Public şemadaki tablo verilerini getir (kısayol)
   */
  @Get('tables/:table/data')
  async getPublicTableData(
    @Param('table') table: string,
    @Query() query: TableQueryDto,
    @Req() req: Request,
  ): Promise<TableData> {
    this.validateExplorerAccess('public', table);
    // Delegates to the audited read, so the operator has to travel with it.
    return this.getTableData('public', table, query, req);
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Tabloya yeni satır ekle
   */
  // Fix: H8 -- per-route throttle: DB write is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('schemas/:schema/tables/:table/rows')
  async insertRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() dto: InsertRowDto,
    @Req() req: Request,
  ) {
    this.assertExplorerWritesEnabled();

    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    if (!dto.data || Object.keys(dto.data).length === 0) {
      throw new BadRequestException('Data is required');
    }

    const columns = Object.keys(dto.data);
    const values = Object.values(dto.data);

    // Sütun isimlerini doğrula
    for (const col of columns) {
      if (!this.isValidIdentifier(col)) {
        throw new BadRequestException(`Invalid column name: ${col}`);
      }
    }

    await this.auditExplorerWriteIntent(req, 'insert', schema, table, { columns });

    // WHY: Write operations must use a write-capable runner, not the read-only runner.
    // Previously createReadOnlyQueryRunner() set SET TRANSACTION READ ONLY,
    // making INSERT silently fail even when ENABLE_DB_EXPLORER_WRITES was true.
    const queryRunner = await this.createWriteQueryRunner();

    try {
      const columnsList = columns.map((c) => `"${c}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      const result = await queryRunner.query(
        `INSERT INTO "${schema}"."${table}" (${columnsList}) VALUES (${placeholders}) RETURNING *`,
        values,
      );

      this.logger.log(`Inserted row into ${schema}.${table}`);
      return result[0];
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Tablodaki satırı güncelle
   */
  // Fix: H8 -- per-route throttle: DB write is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Put('schemas/:schema/tables/:table/rows/:id')
  async updateRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() dto: UpdateRowDto,
    @Req() req: Request,
  ) {
    this.assertExplorerWritesEnabled();

    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    if (!dto.data || Object.keys(dto.data).length === 0) {
      throw new BadRequestException('Data is required');
    }

    const columns = Object.keys(dto.data);
    const values = Object.values(dto.data);

    // Sütun isimlerini doğrula
    for (const col of columns) {
      if (!this.isValidIdentifier(col)) {
        throw new BadRequestException(`Invalid column name: ${col}`);
      }
    }

    // WHY: Write operations must use write-capable runner.
    const queryRunner = await this.createWriteQueryRunner();

    try {
      // Primary key sütununu bul
      const pkColumn = await this.getPrimaryKeyColumn(queryRunner, schema, table);
      if (!pkColumn) {
        throw new BadRequestException('Table has no primary key');
      }

      await this.auditExplorerWriteIntent(req, 'update', schema, table, {
        rowId: id,
        primaryKeyColumn: pkColumn,
        columns,
      });

      const setClause = columns.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      values.push(id);

      const result = await queryRunner.query(
        `UPDATE "${schema}"."${table}" SET ${setClause} WHERE "${pkColumn}" = $${values.length} RETURNING *`,
        values,
      );

      if (result.length === 0) {
        throw new BadRequestException('Row not found');
      }

      this.logger.log(`Updated row ${id} in ${schema}.${table}`);
      return result[0];
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Tablodaki satırı sil
   */
  // Fix: H8 -- per-route throttle: DB delete is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Delete('schemas/:schema/tables/:table/rows/:id')
  async deleteRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    this.assertExplorerWritesEnabled();

    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    // WHY: Delete operations must use write-capable runner.
    const queryRunner = await this.createWriteQueryRunner();

    try {
      // Primary key sütununu bul
      const pkColumn = await this.getPrimaryKeyColumn(queryRunner, schema, table);
      if (!pkColumn) {
        throw new BadRequestException('Table has no primary key');
      }

      await this.auditExplorerWriteIntent(req, 'delete', schema, table, {
        rowId: id,
        primaryKeyColumn: pkColumn,
      });

      const result = await queryRunner.query(
        `DELETE FROM "${schema}"."${table}" WHERE "${pkColumn}" = $1 RETURNING *`,
        [id],
      );

      if (result.length === 0) {
        throw new BadRequestException('Row not found');
      }

      this.logger.log(`Deleted row ${id} from ${schema}.${table}`);
      return { deleted: true, row: result[0] };
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Table Structure
  // ============================================================================

  /**
   * Tablo yapısını getir
   */
  @Get('schemas/:schema/tables/:table/structure')
  async getTableStructure(@Param('schema') schema: string, @Param('table') table: string) {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }
    this.validateExplorerAccess(schema, table);

    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      const columns = await this.getColumnInfo(queryRunner, schema, table);

      // Index bilgileri
      const indexes = await queryRunner.query(
        `
        SELECT
          i.relname as index_name,
          a.attname as column_name,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY i.relname
      `,
        [schema, table],
      );

      // Constraint bilgileri
      const constraints = await queryRunner.query(
        `
        SELECT
          tc.constraint_name,
          tc.constraint_type,
          kcu.column_name,
          ccu.table_schema AS foreign_schema,
          ccu.table_name AS foreign_table,
          ccu.column_name AS foreign_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2
      `,
        [schema, table],
      );

      return {
        tableName: table,
        schemaName: schema,
        columns,
        indexes,
        constraints,
      };
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Raw Query (SECURITY CRITICAL - Use with extreme caution!)
  // ============================================================================

  /**
   * Execute raw SQL query (SELECT only)
   * SECURITY: This endpoint is extremely sensitive and should be disabled in production
   */
  // Fix: H8 -- per-route throttle: raw SQL execution is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('query')
  async executeQuery(@Body() dto: ExecuteQueryDto, @Req() req: Request) {
    const { sql, params = [] } = dto;

    // Fix: C4 -- fail-closed raw SQL koruması
    // Feature flag açıkça true olmalı, NODE_ENV kontrolü yedek savunma hattı
    if (process.env['ENABLE_RAW_SQL_EXPLORER'] !== 'true') {
      throw new ForbiddenException(
        'Raw SQL queries are disabled. Set ENABLE_RAW_SQL_EXPLORER=true to enable.',
      );
    }
    if (process.env['NODE_ENV'] === 'production') {
      throw new ForbiddenException(
        'Raw SQL queries are disabled in production for security reasons',
      );
    }

    // SECURITY: Query length limit to prevent DoS
    const MAX_QUERY_LENGTH = 10000;
    if (sql.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
      );
    }

    // Remove SQL comments to prevent bypass attempts
    const sqlWithoutComments = sql
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* ... */ comments
      .replace(/--.*$/gm, ''); // Remove -- comments

    // Fix: C1 -- multi-statement SQL bypass engeli
    if (sqlWithoutComments.includes(';')) {
      throw new BadRequestException('Multi-statement queries are not allowed');
    }

    // Only allow SELECT/WITH queries
    const normalizedSql = sqlWithoutComments.trim().toUpperCase();
    if (!normalizedSql.startsWith('SELECT') && !normalizedSql.startsWith('WITH')) {
      throw new BadRequestException('Only SELECT queries are allowed');
    }

    // SECURITY: Block dangerous SQL statements
    const dangerousStatements = [
      /\bDROP\b/i,
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bEXEC(UTE)?\b/i,
      /\bCALL\b/i,
      // Fix: C2,C3 -- SET/DO/PERFORM/COPY bypass engeli
      /\bSET\b/i,
      /\bDO\b\s*\$/i,
      /\bPERFORM\b/i,
      /\bCOPY\b/i,
      // Fix: Review feedback -- defense-in-depth
      /\bRESET\b/i,
      /\bSHOW\b/i,
    ];

    for (const pattern of dangerousStatements) {
      if (pattern.test(sqlWithoutComments)) {
        throw new BadRequestException('Query contains disallowed statements');
      }
    }

    // SECURITY: Block dangerous PostgreSQL functions
    const dangerousFunctions = [
      /\bpg_read_file\b/i,
      /\bpg_read_binary_file\b/i,
      /\bpg_write_file\b/i,
      /\bpg_ls_dir\b/i,
      /\bpg_stat_file\b/i,
      /\bpg_terminate_backend\b/i,
      /\bpg_cancel_backend\b/i,
      /\bpg_reload_conf\b/i,
      /\blo_import\b/i,
      /\blo_export\b/i,
      /\bcopy\s+to\b/i,
      /\bcopy\s+from\b/i,
      /\bdblink\b/i,
      // Fix: C2,H25 -- set_config/pg_sleep/current_setting bypass engeli
      /\bset_config\b/i,
      /\bpg_sleep\b/i,
      /\bcurrent_setting\b/i,
    ];

    for (const pattern of dangerousFunctions) {
      if (pattern.test(sqlWithoutComments)) {
        throw new BadRequestException('Query contains disallowed functions');
      }
    }

    // SECURITY: Block access to module schemas and tenant schemas
    // Fix: C11 -- system catalog erişim engeli
    const blockedSchemas = [...DEFAULT_TENANT_MODULES, 'pg_catalog', 'information_schema'];
    for (const blocked of blockedSchemas) {
      if (new RegExp(`\\b${blocked}\\.`, 'i').test(sqlWithoutComments)) {
        throw new BadRequestException('Query references restricted schemas');
      }
    }
    if (/\btenant_[a-f0-9]/i.test(sqlWithoutComments)) {
      throw new BadRequestException('Query references restricted tenant schemas');
    }
    if (MODULE_TABLE_REFERENCE_PATTERNS.some((pattern) => pattern.test(sqlWithoutComments))) {
      throw new BadRequestException('Query references restricted module tables');
    }

    const queryRunner = await this.createReadOnlyQueryRunner();

    try {
      // SECURITY: Set statement timeout to prevent long-running queries
      await queryRunner.query('SET statement_timeout = 30000'); // 30 seconds

      const result = await queryRunner.query(sql, params);

      // ADMIN-MEDIUM-002: Persist raw SQL execution to compliance_audit_log.
      // Raw SQL queries are the highest-risk explorer operation and MUST be
      // recorded for SOC 2 evidence. The full SQL text (truncated to 2000 chars)
      // is stored for forensic analysis.
      this.logger.warn(
        `SECURITY AUDIT: Raw SQL query executed by SUPER_ADMIN: ${sql.substring(0, 100)}...`,
      );
      // AUDITTRAIL-HIGH-009 cure: raw SQL is the absolute highest-risk
      // SUPER_ADMIN action — direct DB read on any tenant's data.
      // Awaiting the audit row is mandatory; a failure to record blocks
      // the response, ensuring no raw SQL execution can complete
      // without an audit row landing.
      await this.requireAuditLog({
        action: 'DATABASE_EXPLORER_RAW_SQL',
        entityType: 'DatabaseQuery',
        performedBy: requireAuthUserId(req),
        performedByEmail: getAuthUserEmail(req),
        severity: AuditSeverity.WARNING,
        details: {
          sql: sql.substring(0, 2000),
          paramCount: (params as unknown[]).length,
          rowCount: result.length,
        },
      });

      return {
        rows: result,
        rowCount: result.length,
      };
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Sütun bilgilerini getir
   */
  private async getColumnInfo(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> {
    const columns = await queryRunner.query(
      `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
        CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
        fk.foreign_table_schema,
        fk.foreign_table_name,
        fk.foreign_column_name
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT DISTINCT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      LEFT JOIN (
        SELECT DISTINCT ON (kcu.column_name)
          kcu.column_name,
          ccu.table_schema as foreign_table_schema,
          ccu.table_name as foreign_table_name,
          ccu.column_name as foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY kcu.column_name, kcu.ordinal_position
      ) fk ON fk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `,
      [schema, table],
    );

    return columns.map((col: Record<string, unknown>) => ({
      columnName: col['column_name'] as string,
      dataType: col['data_type'] as string,
      isNullable: col['is_nullable'] as boolean,
      columnDefault: col['column_default'] as string | null,
      isPrimaryKey: col['is_primary_key'] as boolean,
      isForeignKey: col['is_foreign_key'] as boolean,
      foreignKeyTable: col['foreign_table_name'] as string | undefined,
      foreignKeyColumn: col['foreign_column_name'] as string | undefined,
    }));
  }

  /**
   * Bulk fetch column info for multiple tables in a single query
   * Eliminates N+1 queries when listing tables
   */
  private async getBulkColumnInfo(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    schema: string,
    tableNames: string[],
  ): Promise<Map<string, ColumnInfo[]>> {
    if (tableNames.length === 0) {
      return new Map();
    }

    const columns = await queryRunner.query(
      `
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
        CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
        fk.foreign_table_schema,
        fk.foreign_table_name,
        fk.foreign_column_name
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT DISTINCT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = ANY($2) AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
      LEFT JOIN (
        SELECT DISTINCT ON (kcu.table_name, kcu.column_name)
          kcu.table_name,
          kcu.column_name,
          ccu.table_schema as foreign_table_schema,
          ccu.table_name as foreign_table_name,
          ccu.column_name as foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = ANY($2) AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY kcu.table_name, kcu.column_name, kcu.ordinal_position
      ) fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = ANY($2)
      ORDER BY c.table_name, c.ordinal_position
    `,
      [schema, tableNames],
    );

    const result = new Map<string, ColumnInfo[]>();

    for (const col of columns) {
      const tableName = col.table_name as string;
      if (!result.has(tableName)) {
        result.set(tableName, []);
      }
      result.get(tableName)!.push({
        columnName: col.column_name as string,
        dataType: col.data_type as string,
        isNullable: col.is_nullable as boolean,
        columnDefault: col.column_default as string | null,
        isPrimaryKey: col.is_primary_key as boolean,
        isForeignKey: col.is_foreign_key as boolean,
        foreignKeyTable: col.foreign_table_name as string | undefined,
        foreignKeyColumn: col.foreign_column_name as string | undefined,
      });
    }

    return result;
  }

  /**
   * Primary key sütununu bul
   */
  private async getPrimaryKeyColumn(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    schema: string,
    table: string,
  ): Promise<string | null> {
    const result = await queryRunner.query(
      `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1
    `,
      [schema, table],
    );

    return result[0]?.column_name || null;
  }

  /**
   * Identifier'ı doğrula (SQL injection koruması)
   */
  private isValidIdentifier(name: string): boolean {
    const validPattern = /^[a-z_][a-z0-9_]*$/i;
    return validPattern.test(name) && name.length <= 63;
  }
}
