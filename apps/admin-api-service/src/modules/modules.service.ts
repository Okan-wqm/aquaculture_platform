import * as crypto from 'crypto';

import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateModuleCommand,
  type AdminCreateModuleResult,
  type AdminDeleteModuleCommand,
  type AdminDeleteModuleResult,
  type AdminUpdateModuleCommand,
  type AdminUpdateModuleResult,
} from '@platform/event-contracts';
import {
  createStandardPaginatedResult,
  type PaginationResultV1,
} from '@platform/pagination-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { AuthTenantProvisioningClientService } from '../tenant/services/auth-tenant-provisioning-client.service';

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

export interface ModuleFilter {
  isActive?: boolean;
  isCore?: boolean;
  search?: string;
}

export interface ModuleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  price: number;
  tenantsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The page shape is the platform authority's, not a local copy — see
 * docs/reviews/admin-expert/2026-08-16-pagination-result-authority.md.
 */
export type PaginatedModules = PaginationResultV1<ModuleDto>;

export interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: { moduleId: string; moduleName: string; tenantsCount: number }[];
}

/** One row of the "which tenants have this module" list. */
export interface ModuleTenantAssignment {
  id: string;
  name: string;
  slug: string;
  status: string;
  assignedAt: Date;
  expiresAt: Date | null;
}

export interface TenantModuleAssignment {
  id: string;
  tenantId: string;
  tenantName: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  assignedAt: Date;
  expiresAt: Date | null;
  quantities?: ModuleQuantities;
  configuration?: Record<string, unknown>;
}

/**
 * Module quantities for assignment
 */
export interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

/**
 * Assign module to tenant DTO
 */
export interface AssignModuleDto {
  tenantId: string;
  moduleId: string;
  quantities?: ModuleQuantities;
  configuration?: Record<string, unknown>;
  expiresAt?: Date;
  assignedBy?: string;
}

@Injectable()
export class ModulesService {
  /**
   * Catalog-derived per-module base price.
   *
   * WHY: billing owns all subscription pricing (platform rule D14).
   * ModuleDto.price is derived from the module-pricing catalog
   * (admin.module_pricing — BASE_PRICE metric of the currently-effective
   * active row), NOT from auth.modules: auth carries catalogue metadata
   * only. This keeps the admin module list showing the SAME base price the
   * tenant-create quote flow (PricingCalculatorService) actually charges.
   * `::float8` makes the driver return a JS number, matching ModuleDto.price.
   */
  private static readonly CATALOG_BASE_PRICE_SQL = `COALESCE((
          SELECT (metric.value->>'price')::numeric
          FROM admin.module_pricing mp
          CROSS JOIN LATERAL jsonb_array_elements(mp."pricingMetrics") AS metric(value)
          WHERE mp."moduleId" = m.id
            AND mp."isActive" = true
            AND mp."effectiveFrom" <= NOW()
            AND (mp."effectiveTo" IS NULL OR mp."effectiveTo" >= NOW())
            AND metric.value->>'type' = 'base_price'
          ORDER BY mp."effectiveFrom" DESC
          LIMIT 1
        ), 0)::float8`;

  private readonly logger = new Logger(ModulesService.name);
  private readonly timeoutMs: number;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AUTH_NATS_TIMEOUT_MS;
  }

  /**
   * List all modules with filtering and pagination
   */
  async listModules(
    filter: ModuleFilter,
    page = 1,
    limit = 50,
  ): Promise<PaginatedModules> {
    const offset = (page - 1) * limit;

    const whereConditions: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIndex = 1;

    if (filter.isActive !== undefined) {
      whereConditions.push(`m."isActive" = $${paramIndex++}`);
      params.push(filter.isActive);
    }

    if (filter.isCore !== undefined) {
      whereConditions.push(`COALESCE(m.is_core, false) = $${paramIndex++}`);
      params.push(filter.isCore);
    }

    if (filter.search) {
      whereConditions.push(
        `(m.code ILIKE $${paramIndex} OR m.name ILIKE $${paramIndex} OR m.description ILIKE $${paramIndex})`,
      );
      params.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT
        m.id,
        m.code,
        m.name,
        m.description,
        m."defaultRoute" as "defaultRoute",
        m.icon,
        COALESCE(m.is_core, false) as "isCore",
        m."isActive" as "isActive",
        ${ModulesService.CATALOG_BASE_PRICE_SQL} as price,
        COUNT(tm.id)::int as "tenantsCount",
        m."createdAt" as "createdAt",
        m."updatedAt" as "updatedAt"
      FROM auth.modules m
      LEFT JOIN auth.tenant_modules tm ON m.id = tm."moduleId"
      ${whereClause}
      GROUP BY m.id
      ORDER BY m.name ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM auth.modules m
      ${whereClause}
    `;

    try {
      const [modules, countResult] = await Promise.all([
        this.dataSource.query(query, [...params, limit, offset]),
        this.dataSource.query(countQuery, params),
      ]);

      const total = parseInt(countResult[0]?.total || '0', 10);

      return createStandardPaginatedResult<ModuleDto>(modules, total, page, limit);
    } catch (error) {
      this.logger.error(`Failed to list modules: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get module statistics
   */
  async getModuleStats(): Promise<ModuleStats> {
    try {
      const [
        totalResult,
        activeResult,
        coreResult,
        assignmentsResult,
        usageResult,
      ] = await Promise.all([
        this.dataSource.query(`SELECT COUNT(*) as count FROM auth.modules`),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM auth.modules WHERE "isActive" = true`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM auth.modules WHERE COALESCE(is_core, false) = true`,
        ),
        this.dataSource.query(`SELECT COUNT(*) as count FROM auth.tenant_modules`),
        this.dataSource.query(`
          SELECT
            m.id as "moduleId",
            m.name as "moduleName",
            COUNT(tm.id)::int as "tenantsCount"
          FROM auth.modules m
          LEFT JOIN auth.tenant_modules tm ON m.id = tm."moduleId"
          GROUP BY m.id, m.name
          ORDER BY "tenantsCount" DESC
        `),
      ]);

      return {
        totalModules: parseInt(totalResult[0]?.count || '0', 10),
        activeModules: parseInt(activeResult[0]?.count || '0', 10),
        coreModules: parseInt(coreResult[0]?.count || '0', 10),
        totalAssignments: parseInt(assignmentsResult[0]?.count || '0', 10),
        moduleUsage: usageResult,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get module stats: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Get module by ID
   */
  async getModuleById(id: string): Promise<ModuleDto> {
    try {
      const result = await this.dataSource.query(
        `
        SELECT
          m.id,
          m.code,
          m.name,
          m.description,
          m."defaultRoute" as "defaultRoute",
          m.icon,
          COALESCE(m.is_core, false) as "isCore",
          m."isActive" as "isActive",
          ${ModulesService.CATALOG_BASE_PRICE_SQL} as price,
          COUNT(tm.id)::int as "tenantsCount",
          m."createdAt" as "createdAt",
          m."updatedAt" as "updatedAt"
        FROM auth.modules m
        LEFT JOIN auth.tenant_modules tm ON m.id = tm."moduleId"
        WHERE m.id = $1
        GROUP BY m.id
      `,
        [id],
      );

      if (!result[0]) {
        throw new NotFoundException(`Module with ID ${id} not found`);
      }

      return result[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get module: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get module by code
   */
  async getModuleByCode(code: string): Promise<ModuleDto> {
    try {
      const result = await this.dataSource.query(
        `
        SELECT
          m.id,
          m.code,
          m.name,
          m.description,
          m."defaultRoute" as "defaultRoute",
          m.icon,
          COALESCE(m.is_core, false) as "isCore",
          m."isActive" as "isActive",
          ${ModulesService.CATALOG_BASE_PRICE_SQL} as price,
          COUNT(tm.id)::int as "tenantsCount",
          m."createdAt" as "createdAt",
          m."updatedAt" as "updatedAt"
        FROM auth.modules m
        LEFT JOIN auth.tenant_modules tm ON m.id = tm."moduleId"
        WHERE m.code = $1
        GROUP BY m.id
      `,
        [code],
      );

      if (!result[0]) {
        throw new NotFoundException(`Module with code ${code} not found`);
      }

      return result[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get module: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Create new module
   */
  async createModule(dto: {
    code: string;
    name: string;
    description?: string;
    defaultRoute: string;
    icon?: string;
    isCore?: boolean;
  }): Promise<ModuleDto> {
    const command: AdminCreateModuleCommand = {
      code: dto.code,
      name: dto.name,
      description: dto.description ?? null,
      defaultRoute: dto.defaultRoute,
      icon: dto.icon ?? null,
      isCore: dto.isCore ?? false,
    };
    const result = await this.sendAuthAdminCommand<
      AdminCreateModuleCommand,
      AdminCreateModuleResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE, command);

    if (!result.success || !result.module) {
      if (result.errorCode === 'DUPLICATE_MODULE') {
        throw new ConflictException(`Module with code ${dto.code} already exists`);
      }
      throw new BadGatewayException(result.error ?? 'Auth-service module creation failed');
    }

    this.logger.log(`Created module via auth-service: ${dto.code}`);
    // Re-read through the catalog-priced SELECT so ModuleDto.price reflects
    // the module-pricing catalog (0 until a pricing row is configured).
    return this.getModuleById(result.module.id);
  }

  /**
   * Update module
   */
  async updateModule(
    id: string,
    dto: {
      name?: string;
      description?: string;
      defaultRoute?: string;
      icon?: string;
      isActive?: boolean;
    },
  ): Promise<ModuleDto> {
    const patchKeys = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );
    if (patchKeys.length === 0) {
      return this.getModuleById(id);
    }

    const command: AdminUpdateModuleCommand = {
      moduleId: id,
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.defaultRoute !== undefined && { defaultRoute: dto.defaultRoute }),
      ...(dto.icon !== undefined && { icon: dto.icon }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };
    const result = await this.sendAuthAdminCommand<
      AdminUpdateModuleCommand,
      AdminUpdateModuleResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE, command);

    if (!result.success) {
      if (result.errorCode === 'MODULE_NOT_FOUND') {
        throw new NotFoundException(`Module with ID ${id} not found`);
      }
      throw new BadGatewayException(result.error ?? 'Auth-service module update failed');
    }

    this.logger.log(`Updated module via auth-service: ${id}`);
    return this.getModuleById(id);
  }

  /**
   * Set module active status
   */
  async setModuleStatus(id: string, isActive: boolean): Promise<ModuleDto> {
    return this.updateModule(id, { isActive });
  }

  /**
   * Delete module
   */
  async deleteModule(id: string): Promise<void> {
    const result = await this.sendAuthAdminCommand<
      AdminDeleteModuleCommand,
      AdminDeleteModuleResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE, { moduleId: id });

    if (!result.success) {
      if (result.errorCode === 'MODULE_NOT_FOUND') {
        throw new NotFoundException(`Module with ID ${id} not found`);
      }
      if (result.errorCode === 'MODULE_ASSIGNED') {
        throw new ConflictException(
          `Cannot delete module that is assigned to tenants. Remove assignments first.`,
        );
      }
      throw new BadGatewayException(result.error ?? 'Auth-service module deletion failed');
    }

    this.logger.log(`Deleted module via auth-service: ${id}`);
  }

  /**
   * Get tenants assigned to a module
   */
  async getModuleTenants(
    moduleId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginationResultV1<ModuleTenantAssignment>> {
    const offset = (page - 1) * limit;

    try {
      const [tenants, countResult] = await Promise.all([
        this.dataSource.query(
          `
          SELECT
            t.id,
            t.name,
            t.slug,
            t.status,
            tm."activatedAt" as "assignedAt",
            tm."expiresAt" as "expiresAt"
          FROM auth.tenants t
          JOIN auth.tenant_modules tm ON t.id = tm."tenantId"
          WHERE tm."moduleId" = $1
          ORDER BY tm."activatedAt" DESC
          LIMIT $2 OFFSET $3
        `,
          [moduleId, limit, offset],
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as total FROM auth.tenant_modules WHERE "moduleId" = $1`,
          [moduleId],
        ),
      ]);

      const total = parseInt(countResult[0]?.total || '0', 10);

      return createStandardPaginatedResult<ModuleTenantAssignment>(tenants, total, page, limit);
    } catch (error) {
      this.logger.error(
        `Failed to get module tenants: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Get all tenant-module assignments
   */
  async getAssignments(
    filter: { tenantId?: string; moduleId?: string },
    page = 1,
    limit = 50,
  ): Promise<PaginationResultV1<TenantModuleAssignment>> {
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const params: string[] = [];
    let paramIndex = 1;

    if (filter.tenantId) {
      conditions.push(`tm."tenantId" = $${paramIndex++}`);
      params.push(filter.tenantId);
    }
    if (filter.moduleId) {
      conditions.push(`tm."moduleId" = $${paramIndex++}`);
      params.push(filter.moduleId);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const [assignments, countResult] = await Promise.all([
        this.dataSource.query(
          `
          SELECT
            tm.id,
            tm."tenantId" as "tenantId",
            t.name as "tenantName",
            tm."moduleId" as "moduleId",
            m.code as "moduleCode",
            m.name as "moduleName",
            tm."activatedAt" as "assignedAt",
            tm."expiresAt" as "expiresAt"
          FROM auth.tenant_modules tm
          JOIN auth.tenants t ON tm."tenantId" = t.id
          JOIN auth.modules m ON tm."moduleId" = m.id
          ${whereClause}
          ORDER BY tm."activatedAt" DESC
          LIMIT $${paramIndex++} OFFSET $${paramIndex}
        `,
          [...params, limit, offset],
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as total FROM auth.tenant_modules tm ${whereClause}`,
          params,
        ),
      ]);

      const total = parseInt(countResult[0]?.total || '0', 10);

      return createStandardPaginatedResult<TenantModuleAssignment>(assignments, total, page, limit);
    } catch (error) {
      this.logger.error(
        `Failed to get assignments: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Assign module to tenant with optional quantities and configuration
   */
  async assignModuleToTenant(dto: AssignModuleDto): Promise<TenantModuleAssignment> {
    try {
      const hasExtendedColumns = await this.checkExtendedColumns();
      const assignedBy = dto.assignedBy || dto.tenantId;
      await this.authProvisioningClient.assignTenantModules({
        ...buildModuleLifecycleCommandMetadata(
          'AssignModules',
          dto.tenantId,
          assignedBy,
          {
            moduleId: dto.moduleId,
            quantities: dto.quantities,
            configuration: dto.configuration,
            expiresAt: dto.expiresAt?.toISOString(),
          },
        ),
        moduleIds: [dto.moduleId],
        modules: [{
          moduleId: dto.moduleId,
          ...(dto.quantities ? { quantities: { ...dto.quantities } } : {}),
          ...(dto.configuration ? { configuration: dto.configuration } : {}),
          ...(dto.expiresAt ? { expiresAt: dto.expiresAt.toISOString() } : {}),
        }],
        assignedBy,
      });

      // Get full assignment details
      const selectQuery = hasExtendedColumns
        ? `
          SELECT
            tm.id,
            tm."tenantId" as "tenantId",
            t.name as "tenantName",
            tm."moduleId" as "moduleId",
            m.code as "moduleCode",
            m.name as "moduleName",
            tm."activatedAt" as "assignedAt",
            tm."expiresAt" as "expiresAt",
            tm."quantities" as "quantities",
            tm."configuration" as "configuration"
          FROM auth.tenant_modules tm
          JOIN auth.tenants t ON tm."tenantId" = t.id
          JOIN auth.modules m ON tm."moduleId" = m.id
          WHERE tm."tenantId" = $1 AND tm."moduleId" = $2
        `
        : `
          SELECT
            tm.id,
            tm."tenantId" as "tenantId",
            t.name as "tenantName",
            tm."moduleId" as "moduleId",
            m.code as "moduleCode",
            m.name as "moduleName",
            tm."activatedAt" as "assignedAt",
            tm."expiresAt" as "expiresAt"
          FROM auth.tenant_modules tm
          JOIN auth.tenants t ON tm."tenantId" = t.id
          JOIN auth.modules m ON tm."moduleId" = m.id
          WHERE tm."tenantId" = $1 AND tm."moduleId" = $2
        `;

      const assignment = await this.dataSource.query(selectQuery, [dto.tenantId, dto.moduleId]);
      if (!assignment[0]) {
        throw new NotFoundException(
          `Assignment not found after auth-service handoff for tenant ${dto.tenantId} and module ${dto.moduleId}`,
        );
      }

      this.logger.log(
        `Assigned module ${dto.moduleId} to tenant ${dto.tenantId}${dto.quantities ? ' with quantities' : ''}`,
      );
      return assignment[0];
    } catch (error) {
      this.logger.error(
        `Failed to assign module: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Check if tenant_modules table has extended columns (quantities, configuration)
   */
  private async checkExtendedColumns(): Promise<boolean> {
    try {
      const result = await this.dataSource.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'tenant_modules'
        AND table_schema = 'auth'
        AND column_name IN ('quantities', 'configuration')
      `);
      return result.length >= 2;
    } catch {
      return false;
    }
  }

  /**
   * Remove module from tenant
   */
  async removeModuleFromTenant(
    tenantId: string,
    moduleId: string,
  ): Promise<void> {
    try {
      const result = await this.dataSource.query(
        `SELECT 1 FROM auth.tenant_modules WHERE "tenantId" = $1 AND "moduleId" = $2`,
        [tenantId, moduleId],
      );

      if (!result[0]) {
        throw new NotFoundException(
          `Assignment not found for tenant ${tenantId} and module ${moduleId}`,
        );
      }

      const removal = await this.authProvisioningClient.removeTenantModule({
        ...buildModuleLifecycleCommandMetadata(
          'RemoveModule',
          tenantId,
          tenantId,
          { moduleId },
        ),
        moduleId,
        removedBy: tenantId,
      });
      if ((removal.modulesRemoved ?? 0) === 0) {
        throw new NotFoundException(
          `Assignment not found for tenant ${tenantId} and module ${moduleId}`,
        );
      }

      this.logger.log(`Removed module ${moduleId} from tenant ${tenantId}`);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to remove module: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async sendAuthAdminCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
          timeout(this.timeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadGatewayException(`Auth service error: ${message}`);
    }
  }

}

function buildModuleLifecycleCommandMetadata(
  commandType: string,
  tenantId: string,
  actorId: string,
  payload: unknown,
): {
  operationId: string;
  tenantId: string;
  requestReference: string;
  actor: { id: string; type: 'user' };
  auditMetadata: Record<string, unknown>;
} {
  const payloadHash = hashModulePayload(payload);
  return {
    operationId: crypto.randomUUID(),
    tenantId,
    requestReference: `${commandType}:${tenantId}:${actorId}:${payloadHash}`,
    actor: { id: actorId, type: 'user' },
    auditMetadata: {
      source: 'admin-api-service',
      commandType,
    },
  };
}

function hashModulePayload(payload: unknown): string {
  return crypto.createHash('sha256').update(stableModuleStringify(payload)).digest('hex');
}

function stableModuleStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableModuleStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableModuleStringify(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}
