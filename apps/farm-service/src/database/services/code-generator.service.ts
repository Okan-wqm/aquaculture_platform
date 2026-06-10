/**
 * CodeGeneratorService - Unique kod üretici
 *
 * Format: PREFIX-YYYY-NNNNN
 * Örnek: B-2024-00001 (Batch), TNK-2024-00001 (Tank), PND-2024-00001 (Pond)
 *
 * Özellikler:
 * - Tenant bazlı unique kod üretimi
 * - Yıl bazlı sıfırlama
 * - Race condition koruması (DB sequence veya lock)
 * - Configurable prefix ve padding
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { CodeSequence } from '../entities/code-sequence.entity';

export interface CodeGeneratorOptions {
  prefix: string;
  tenantId: string;
  entityType: string;
  year?: number;
  padding?: number; // Default: 5 (00001)
  separator?: string; // Default: '-'
}

export interface GeneratedCode {
  code: string;
  sequence: number;
  year: number;
}

interface QueryExecutor {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

@Injectable()
export class CodeGeneratorService {
  private readonly logger = new Logger(CodeGeneratorService.name);
  private readonly DEFAULT_PADDING = 5;
  private readonly DEFAULT_SEPARATOR = '-';

  constructor(
    @InjectRepository(CodeSequence)
    private readonly sequenceRepository: Repository<CodeSequence>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Yeni unique kod üret
   *
   * @example
   * generateCode({ prefix: 'B', tenantId: 'xxx', entityType: 'Batch' })
   * // Returns: { code: 'B-2024-00001', sequence: 1, year: 2024 }
   */
  async generateCode(options: CodeGeneratorOptions): Promise<GeneratedCode> {
    const year = options.year || new Date().getFullYear();
    const padding = options.padding || this.DEFAULT_PADDING;
    const separator = options.separator || this.DEFAULT_SEPARATOR;

    // Transaction ile race condition koruması
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate tenantId to prevent SQL injection before schema derivation
      if (!isValidUUID(options.tenantId)) {
        throw new Error(`Invalid tenantId format: ${options.tenantId}`);
      }
      // Set search_path to tenant schema so code_sequences resolves to the correct tenant schema
      const tenantSchema = getTenantSchemaName(options.tenantId);
      await queryRunner.query(`SET LOCAL search_path TO "${tenantSchema}", farm, public`);

      const sequence = await this.incrementSequenceAtomically(queryRunner, {
        tenantId: options.tenantId,
        entityType: options.entityType,
        prefix: options.prefix,
        year,
      });
      await queryRunner.commitTransaction();

      // Kodu formatla
      const paddedSequence = String(sequence.lastSequence).padStart(padding, '0');
      const code = `${options.prefix}${separator}${year}${separator}${paddedSequence}`;

      this.logger.debug(`Generated code: ${code} for ${options.entityType}`);

      return {
        code,
        sequence: sequence.lastSequence,
        year,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Failed to generate code: ${err.message}`, err.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Generate a code using the caller's active tenant transaction.
   *
   * Setup write paths use this variant so the code sequence increment rolls
   * back with the aggregate/audit/outbox write. The caller is responsible for
   * using a manager whose query runner already has the tenant search_path set.
   */
  async generateCodeWithManager(
    manager: EntityManager,
    options: CodeGeneratorOptions,
  ): Promise<GeneratedCode> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('generateCodeWithManager requires an active transaction manager');
    }
    if (!isValidUUID(options.tenantId)) {
      throw new Error(`Invalid tenantId format: ${options.tenantId}`);
    }

    const year = options.year || new Date().getFullYear();
    const padding = options.padding || this.DEFAULT_PADDING;
    const separator = options.separator || this.DEFAULT_SEPARATOR;

    const sequence = await this.incrementSequenceAtomically(manager, {
      tenantId: options.tenantId,
      entityType: options.entityType,
      prefix: options.prefix,
      year,
    });

    const paddedSequence = String(sequence.lastSequence).padStart(padding, '0');
    const code = `${options.prefix}${separator}${year}${separator}${paddedSequence}`;

    this.logger.debug(`Generated code: ${code} for ${options.entityType}`);

    return {
      code,
      sequence: sequence.lastSequence,
      year,
    };
  }

  private async incrementSequenceAtomically(
    queryRunner: QueryExecutor,
    input: {
      tenantId: string;
      entityType: string;
      prefix: string;
      year: number;
    },
  ): Promise<CodeSequence> {
    const table = this.quoteIdentifier(
      this.sequenceRepository.metadata?.tableName ?? 'code_sequences',
    );
    const columns = this.sequenceColumnNames();
    const setUpdatedAt = columns.updatedAt ? `, ${columns.updatedAt} = NOW()` : '';

    // WHY: `findOne(... lock)` only locks an existing row. For the first code
    // in a tenant/entity/year, concurrent requests would both see no row and
    // race on insert. PostgreSQL upsert makes create-or-increment one atomic
    // statement guarded by the unique tenant/entity/year constraint.
    const rows: Array<{ sequence: number | string }> = await queryRunner.query(
      `
        INSERT INTO ${table}
          (${columns.tenantId}, ${columns.entityType}, ${columns.prefix}, ${columns.year}, ${columns.lastSequence}, ${columns.lastGeneratedAt})
        VALUES ($1, $2, $3, $4, 1, NOW())
        ON CONFLICT (${columns.tenantId}, ${columns.entityType}, ${columns.year})
        DO UPDATE SET
          ${columns.lastSequence} = ${table}.${columns.lastSequence} + 1,
          ${columns.prefix} = EXCLUDED.${columns.prefix},
          ${columns.lastGeneratedAt} = NOW()
          ${setUpdatedAt}
        RETURNING ${columns.lastSequence} AS "sequence"
      `,
      [input.tenantId, input.entityType, input.prefix, input.year],
    );

    const lastSequence = Number(rows[0]?.sequence);
    if (!Number.isInteger(lastSequence) || lastSequence < 1) {
      throw new Error('Code sequence increment did not return a valid sequence');
    }

    return {
      tenantId: input.tenantId,
      entityType: input.entityType,
      prefix: input.prefix,
      year: input.year,
      lastSequence,
      lastGeneratedAt: new Date(),
    } as CodeSequence;
  }

  private sequenceColumnNames(): {
    tenantId: string;
    entityType: string;
    prefix: string;
    year: string;
    lastSequence: string;
    lastGeneratedAt: string;
    updatedAt?: string;
  } {
    return {
      tenantId: this.sequenceColumn('tenantId'),
      entityType: this.sequenceColumn('entityType'),
      prefix: this.sequenceColumn('prefix'),
      year: this.sequenceColumn('year'),
      lastSequence: this.sequenceColumn('lastSequence'),
      lastGeneratedAt: this.sequenceColumn('lastGeneratedAt'),
      updatedAt: this.optionalSequenceColumn('updatedAt'),
    };
  }

  private sequenceColumn(propertyName: keyof CodeSequence): string {
    const column = this.optionalSequenceColumn(propertyName);
    if (!column) {
      throw new Error(`CodeSequence metadata is missing column "${String(propertyName)}"`);
    }
    return column;
  }

  private optionalSequenceColumn(propertyName: keyof CodeSequence): string | undefined {
    const databaseName = this.sequenceRepository.metadata?.findColumnWithPropertyName(
      String(propertyName),
    )?.databaseName;
    return databaseName ? this.quoteIdentifier(databaseName) : undefined;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  /**
   * Batch kodu üret: B-2024-00001
   */
  async generateBatchCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'B',
      tenantId,
      entityType: 'Batch',
    });
    return result.code;
  }

  /**
   * Tank kodu üret: TNK-2024-00001
   */
  async generateTankCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'TNK',
      tenantId,
      entityType: 'Tank',
    });
    return result.code;
  }

  async generateTankCodeWithManager(manager: EntityManager, tenantId: string): Promise<string> {
    const result = await this.generateCodeWithManager(manager, {
      prefix: 'TNK',
      tenantId,
      entityType: 'Tank',
    });
    return result.code;
  }

  /**
   * Pond kodu üret: PND-2024-00001
   */
  async generatePondCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'PND',
      tenantId,
      entityType: 'Pond',
    });
    return result.code;
  }

  /**
   * Site kodu üret: SITE-2024-00001
   */
  async generateSiteCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'SITE',
      tenantId,
      entityType: 'Site',
    });
    return result.code;
  }

  /**
   * Department kodu üret: DEPT-2024-00001
   */
  async generateDepartmentCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'DEPT',
      tenantId,
      entityType: 'Department',
    });
    return result.code;
  }

  /**
   * System kodu üret: SYS-2024-00001
   */
  async generateSystemCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'SYS',
      tenantId,
      entityType: 'System',
    });
    return result.code;
  }

  /**
   * Equipment kodu üret: EQP-2024-00001
   */
  async generateEquipmentCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'EQP',
      tenantId,
      entityType: 'Equipment',
    });
    return result.code;
  }

  /**
   * Work Order kodu üret: WO-2024-00001
   */
  async generateWorkOrderCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'WO',
      tenantId,
      entityType: 'WorkOrder',
    });
    return result.code;
  }

  /**
   * Maintenance Record kodu üret: MNT-2024-00001
   */
  async generateMaintenanceRecordCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'MNT',
      tenantId,
      entityType: 'MaintenanceRecord',
    });
    return result.code;
  }

  /**
   * Harvest Record kodu üret: HRV-2024-00001
   */
  async generateHarvestRecordCode(tenantId: string): Promise<string> {
    const result = await this.generateCode({
      prefix: 'HRV',
      tenantId,
      entityType: 'HarvestRecord',
    });
    return result.code;
  }

  /**
   * Mevcut sequence bilgisini al
   */
  async getCurrentSequence(tenantId: string, entityType: string, year?: number): Promise<number> {
    const currentYear = year || new Date().getFullYear();

    const sequence = await this.sequenceRepository.findOne({
      where: {
        tenantId,
        entityType,
        year: currentYear,
      },
    });

    return sequence?.lastSequence || 0;
  }

  /**
   * Sequence'i manuel olarak ayarla (migration veya düzeltme için)
   */
  async setSequence(
    tenantId: string,
    entityType: string,
    prefix: string,
    sequenceNumber: number,
    year?: number,
  ): Promise<void> {
    const currentYear = year || new Date().getFullYear();

    let sequence = await this.sequenceRepository.findOne({
      where: {
        tenantId,
        entityType,
        year: currentYear,
      },
    });

    if (!sequence) {
      sequence = this.sequenceRepository.create({
        tenantId,
        entityType,
        prefix,
        year: currentYear,
        lastSequence: sequenceNumber,
      });
    } else {
      sequence.lastSequence = sequenceNumber;
    }

    sequence.lastGeneratedAt = new Date();
    await this.sequenceRepository.save(sequence);

    this.logger.log(`Sequence set for ${entityType} in tenant ${tenantId}: ${sequenceNumber}`);
  }

  /**
   * Kodu parse et
   */
  parseCode(code: string): { prefix: string; year: number; sequence: number } | null {
    const parts = code.split('-');
    if (parts.length !== 3) return null;

    const [prefix, yearStr, sequenceStr] = parts;
    if (!prefix || !yearStr || !sequenceStr) return null;

    return {
      prefix,
      year: parseInt(yearStr, 10),
      sequence: parseInt(sequenceStr, 10),
    };
  }

  /**
   * Kod geçerli mi kontrol et
   */
  isValidCode(code: string, expectedPrefix?: string): boolean {
    const parsed = this.parseCode(code);
    if (!parsed) return false;

    if (expectedPrefix && parsed.prefix !== expectedPrefix) return false;

    const currentYear = new Date().getFullYear();
    if (parsed.year < 2020 || parsed.year > currentYear + 1) return false;

    if (parsed.sequence < 1) return false;

    return true;
  }
}
