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
  Logger,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { IsOptional, IsNumber, IsString, IsIn, IsObject } from 'class-validator';
import { Type, Transform } from 'class-transformer';

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
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';

  @IsOptional()
  @IsString()
  filter?: string;
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

// ============================================================================
// Controller
// ============================================================================

@Controller('database/explorer')
@UseGuards(PlatformAdminGuard)
export class DatabaseExplorerController {
  private readonly logger = new Logger(DatabaseExplorerController.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================================
  // Table Listing
  // ============================================================================

  /**
   * Tüm şemaları listele
   */
  @Get('schemas')
  async getSchemas() {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const schemas = await queryRunner.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Tablo bilgilerini al
      const tables = await queryRunner.query(`
        SELECT
          t.tablename as table_name,
          t.schemaname as schema_name,
          COALESCE(s.n_live_tup, 0) as row_count,
          COALESCE(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)), 0) as size_bytes
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
        WHERE t.schemaname = $1
        ORDER BY t.tablename
      `, [schema]);

      // Her tablo için sütun bilgilerini al
      const result: TableInfo[] = [];

      for (const table of tables) {
        const columns = await this.getColumnInfo(queryRunner, schema, table.table_name);
        result.push({
          tableName: table.table_name,
          schemaName: table.schema_name,
          rowCount: parseInt(table.row_count, 10),
          sizeBytes: parseInt(table.size_bytes, 10),
          columns,
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
  ): Promise<TableData> {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const offset = (page - 1) * limit;
    const orderBy = query.orderBy && this.isValidIdentifier(query.orderBy) ? query.orderBy : null;
    const orderDirection = query.orderDirection === 'DESC' ? 'DESC' : 'ASC';

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Sütun bilgilerini al
      const columns = await this.getColumnInfo(queryRunner, schema, table);

      // Toplam satır sayısı
      const countResult = await queryRunner.query(
        `SELECT COUNT(*) as count FROM "${schema}"."${table}"`,
      );
      const totalRows = parseInt(countResult[0]?.count || '0', 10);
      const totalPages = Math.ceil(totalRows / limit);

      // Verileri al
      let dataQuery = `SELECT * FROM "${schema}"."${table}"`;
      if (orderBy) {
        dataQuery += ` ORDER BY "${orderBy}" ${orderDirection}`;
      }
      dataQuery += ` LIMIT ${limit} OFFSET ${offset}`;

      const rows = await queryRunner.query(dataQuery);

      return {
        tableName: table,
        columns,
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
   * Public şemadaki tablo verilerini getir (kısayol)
   */
  @Get('tables/:table/data')
  async getPublicTableData(
    @Param('table') table: string,
    @Query() query: TableQueryDto,
  ): Promise<TableData> {
    return this.getTableData('public', table, query);
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Tabloya yeni satır ekle
   */
  @Post('schemas/:schema/tables/:table/rows')
  async insertRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() dto: InsertRowDto,
  ) {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    if (!dto.data || Object.keys(dto.data).length === 0) {
      throw new BadRequestException('Data is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const columns = Object.keys(dto.data);
      const values = Object.values(dto.data);

      // Sütun isimlerini doğrula
      for (const col of columns) {
        if (!this.isValidIdentifier(col)) {
          throw new BadRequestException(`Invalid column name: ${col}`);
        }
      }

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
  @Put('schemas/:schema/tables/:table/rows/:id')
  async updateRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() dto: UpdateRowDto,
  ) {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    if (!dto.data || Object.keys(dto.data).length === 0) {
      throw new BadRequestException('Data is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Primary key sütununu bul
      const pkColumn = await this.getPrimaryKeyColumn(queryRunner, schema, table);
      if (!pkColumn) {
        throw new BadRequestException('Table has no primary key');
      }

      const columns = Object.keys(dto.data);
      const values = Object.values(dto.data);

      // Sütun isimlerini doğrula
      for (const col of columns) {
        if (!this.isValidIdentifier(col)) {
          throw new BadRequestException(`Invalid column name: ${col}`);
        }
      }

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
  @Delete('schemas/:schema/tables/:table/rows/:id')
  async deleteRow(
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Param('id') id: string,
  ) {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Primary key sütununu bul
      const pkColumn = await this.getPrimaryKeyColumn(queryRunner, schema, table);
      if (!pkColumn) {
        throw new BadRequestException('Table has no primary key');
      }

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
  async getTableStructure(
    @Param('schema') schema: string,
    @Param('table') table: string,
  ) {
    if (!this.isValidIdentifier(schema) || !this.isValidIdentifier(table)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const columns = await this.getColumnInfo(queryRunner, schema, table);

      // Index bilgileri
      const indexes = await queryRunner.query(`
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
      `, [schema, table]);

      // Constraint bilgileri
      const constraints = await queryRunner.query(`
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
      `, [schema, table]);

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
  @Post('query')
  async executeQuery(@Body() dto: ExecuteQueryDto) {
    const { sql, params = [] } = dto;

    // SECURITY: Block in production environment
    if (process.env['NODE_ENV'] === 'production') {
      throw new BadRequestException(
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
      .replace(/--.*$/gm, '');          // Remove -- comments

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
    ];

    for (const pattern of dangerousFunctions) {
      if (pattern.test(sqlWithoutComments)) {
        throw new BadRequestException('Query contains disallowed functions');
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // SECURITY: Set statement timeout to prevent long-running queries
      await queryRunner.query('SET statement_timeout = 30000'); // 30 seconds

      const result = await queryRunner.query(sql, params);
      this.logger.warn(
        `SECURITY AUDIT: Raw SQL query executed by SUPER_ADMIN: ${sql.substring(0, 100)}...`,
      );
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
    const columns = await queryRunner.query(`
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
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      LEFT JOIN (
        SELECT
          kcu.column_name,
          ccu.table_schema as foreign_table_schema,
          ccu.table_name as foreign_table_name,
          ccu.column_name as foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
      ) fk ON fk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [schema, table]);

    return columns.map((col: Record<string, unknown>) => ({
      columnName: col.column_name as string,
      dataType: col.data_type as string,
      isNullable: col.is_nullable as boolean,
      columnDefault: col.column_default as string | null,
      isPrimaryKey: col.is_primary_key as boolean,
      isForeignKey: col.is_foreign_key as boolean,
      foreignKeyTable: col.foreign_table_name as string | undefined,
      foreignKeyColumn: col.foreign_column_name as string | undefined,
    }));
  }

  /**
   * Primary key sütununu bul
   */
  private async getPrimaryKeyColumn(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    schema: string,
    table: string,
  ): Promise<string | null> {
    const result = await queryRunner.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1
    `, [schema, table]);

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
