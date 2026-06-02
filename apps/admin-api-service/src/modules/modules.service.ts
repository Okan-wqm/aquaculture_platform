import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateModuleCommand,
  type AdminModuleMutationResult,
  type AdminUpdateModuleCommand,
  type AdminDeleteModuleCommand,
  type AdminDeleteModuleResult,
  type AdminUpsertTenantModuleCommand,
  type AdminTenantModuleMutationResult,
  type AdminRemoveTenantModuleCommand,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { AuthCommandClientService } from '../auth/auth-command-client.service';

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

export interface PaginatedModules {
  data: ModuleDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: { moduleId: string; moduleName: string; tenantsCount: number }[];
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
  private readonly logger = new Logger(ModulesService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly authCommandClient: AuthCommandClientService,
  ) {}

  /**
   * List all modules with filtering and pagination
   */
  async listModules(filter: ModuleFilter, page = 1, limit = 50): Promise<PaginatedModules> {
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

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

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
        COALESCE(m.price, 0) as price,
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

      return {
        data: modules,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
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
      const [totalResult, activeResult, coreResult, assignmentsResult, usageResult] =
        await Promise.all([
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
      this.logger.error(`Failed to get module stats: ${(error as Error).message}`);
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
          COALESCE(m.price, 0) as price,
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
          COALESCE(m.price, 0) as price,
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
    price?: number;
  }): Promise<ModuleDto> {
    const result = await this.authCommandClient.request<
      AdminCreateModuleCommand,
      AdminModuleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE, {
      code: dto.code,
      name: dto.name,
      description: dto.description ?? null,
      defaultRoute: dto.defaultRoute,
      icon: dto.icon ?? null,
      isCore: dto.isCore ?? false,
      price: dto.price ?? 0,
    });
    this.authCommandClient.assertSuccess(result, `Could not create module ${dto.code}`);
    this.logger.log(`Created module: ${dto.code}`);
    const created = result.module!;
    return {
      ...created,
      tenantsCount: 0,
      createdAt: new Date(created.createdAt ?? Date.now()),
      updatedAt: new Date(created.updatedAt ?? Date.now()),
    };
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
      price?: number;
    },
  ): Promise<ModuleDto> {
    if (Object.keys(dto).length === 0) {
      return this.getModuleById(id);
    }

    const result = await this.authCommandClient.request<
      AdminUpdateModuleCommand,
      AdminModuleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE, {
      moduleId: id,
      ...dto,
    });
    this.authCommandClient.assertSuccess(result, `Could not update module ${id}`);
    this.logger.log(`Updated module: ${id}`);
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
    const result = await this.authCommandClient.request<
      AdminDeleteModuleCommand,
      AdminDeleteModuleResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE, { moduleId: id });
    this.authCommandClient.assertSuccess(result, `Could not delete module ${id}`);
    this.logger.log(`Deleted module: ${id}`);
  }

  /**
   * Get tenants assigned to a module
   */
  async getModuleTenants(moduleId: string, page = 1, limit = 50) {
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

      return {
        data: tenants,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      this.logger.error(`Failed to get module tenants: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get all tenant-module assignments
   */
  async getAssignments(filter: { tenantId?: string; moduleId?: string }, page = 1, limit = 50) {
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

      return {
        data: assignments,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      this.logger.error(`Failed to get assignments: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Assign module to tenant with optional quantities and configuration
   */
  async assignModuleToTenant(dto: AssignModuleDto): Promise<TenantModuleAssignment> {
    try {
      const hasExtendedColumns = await this.checkExtendedColumns();
      const result = await this.authCommandClient.request<
        AdminUpsertTenantModuleCommand,
        AdminTenantModuleMutationResult
      >(AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE, {
        tenantId: dto.tenantId,
        moduleId: dto.moduleId,
        expiresAt: dto.expiresAt?.toISOString() ?? null,
        assignedBy: dto.assignedBy || dto.tenantId,
        quantities: (dto.quantities as Record<string, unknown> | undefined) ?? null,
        configuration: dto.configuration ?? null,
      });
      this.authCommandClient.assertSuccess(result, `Could not assign module ${dto.moduleId}`);

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
          WHERE tm.id = $1
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
          WHERE tm.id = $1
        `;

      const assignment = await this.dataSource.query(selectQuery, [result.assignment!.id]);

      this.logger.log(
        `Assigned module ${dto.moduleId} to tenant ${dto.tenantId}${dto.quantities ? ' with quantities' : ''}`,
      );
      return assignment[0];
    } catch (error) {
      this.logger.error(`Failed to assign module: ${(error as Error).message}`);
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
  async removeModuleFromTenant(tenantId: string, moduleId: string): Promise<void> {
    const result = await this.authCommandClient.request<
      AdminRemoveTenantModuleCommand,
      AdminTenantModuleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.REMOVE_TENANT_MODULE, { tenantId, moduleId });
    this.authCommandClient.assertSuccess(result, `Could not remove module ${moduleId}`);
    this.logger.log(`Removed module ${moduleId} from tenant ${tenantId}`);
  }
}
