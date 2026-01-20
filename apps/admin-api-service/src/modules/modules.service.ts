import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
  ) {}

  /**
   * List all modules with filtering and pagination
   */
  async listModules(
    filter: ModuleFilter,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginatedModules> {
    const offset = (page - 1) * limit;

    let whereConditions: string[] = [];
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
        COALESCE(m.price, 0) as price,
        COUNT(tm.id)::int as "tenantsCount",
        m."createdAt" as "createdAt",
        m."updatedAt" as "updatedAt"
      FROM public.modules m
      LEFT JOIN public.tenant_modules tm ON m.id = tm."moduleId"
      ${whereClause}
      GROUP BY m.id
      ORDER BY m.name ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM public.modules m
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
      const [
        totalResult,
        activeResult,
        coreResult,
        assignmentsResult,
        usageResult,
      ] = await Promise.all([
        this.dataSource.query(`SELECT COUNT(*) as count FROM public.modules`),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM public.modules WHERE "isActive" = true`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM public.modules WHERE COALESCE(is_core, false) = true`,
        ),
        this.dataSource.query(`SELECT COUNT(*) as count FROM public.tenant_modules`),
        this.dataSource.query(`
          SELECT
            m.id as "moduleId",
            m.name as "moduleName",
            COUNT(tm.id)::int as "tenantsCount"
          FROM public.modules m
          LEFT JOIN public.tenant_modules tm ON m.id = tm."moduleId"
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
          COALESCE(m.price, 0) as price,
          COUNT(tm.id)::int as "tenantsCount",
          m."createdAt" as "createdAt",
          m."updatedAt" as "updatedAt"
        FROM public.modules m
        LEFT JOIN public.tenant_modules tm ON m.id = tm."moduleId"
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
        FROM public.modules m
        LEFT JOIN public.tenant_modules tm ON m.id = tm."moduleId"
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
    try {
      const result = await this.dataSource.query(
        `
        INSERT INTO public.modules (code, name, description, "defaultRoute", icon, is_core, "isActive", price)
        VALUES ($1, $2, $3, $4, $5, $6, true, $7)
        RETURNING id, code, name, description, "defaultRoute" as "defaultRoute", icon,
                  COALESCE(is_core, false) as "isCore", "isActive" as "isActive", price, "createdAt" as "createdAt"
      `,
        [
          dto.code,
          dto.name,
          dto.description || null,
          dto.defaultRoute,
          dto.icon || null,
          dto.isCore || false,
          dto.price || 0,
        ],
      );

      this.logger.log(`Created module: ${dto.code}`);
      return { ...result[0], tenantsCount: 0 };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(`Module with code ${dto.code} already exists`);
      }
      this.logger.error(`Failed to create module: ${(error as Error).message}`);
      throw error;
    }
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
    const updates: string[] = [];
    const params: (string | boolean | number)[] = [];
    let paramIndex = 1;

    if (dto.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(dto.name);
    }
    if (dto.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(dto.description);
    }
    if (dto.defaultRoute !== undefined) {
      updates.push(`"defaultRoute" = $${paramIndex++}`);
      params.push(dto.defaultRoute);
    }
    if (dto.icon !== undefined) {
      updates.push(`icon = $${paramIndex++}`);
      params.push(dto.icon);
    }
    if (dto.isActive !== undefined) {
      updates.push(`"isActive" = $${paramIndex++}`);
      params.push(dto.isActive);
    }
    if (dto.price !== undefined) {
      updates.push(`price = $${paramIndex++}`);
      params.push(dto.price);
    }

    if (updates.length === 0) {
      return this.getModuleById(id);
    }

    updates.push(`"updatedAt" = NOW()`);
    params.push(id);

    try {
      await this.dataSource.query(
        `
        UPDATE public.modules
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
      `,
        params,
      );

      this.logger.log(`Updated module: ${id}`);
      return this.getModuleById(id);
    } catch (error) {
      this.logger.error(`Failed to update module: ${(error as Error).message}`);
      throw error;
    }
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
    try {
      // Check if module is assigned to any tenants
      const assignments = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM public.tenant_modules WHERE "moduleId" = $1`,
        [id],
      );

      if (parseInt(assignments[0]?.count || '0', 10) > 0) {
        throw new ConflictException(
          `Cannot delete module that is assigned to tenants. Remove assignments first.`,
        );
      }

      const result = await this.dataSource.query(
        `DELETE FROM public.modules WHERE id = $1 RETURNING id`,
        [id],
      );

      if (!result[0]) {
        throw new NotFoundException(`Module with ID ${id} not found`);
      }

      this.logger.log(`Deleted module: ${id}`);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      this.logger.error(`Failed to delete module: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get tenants assigned to a module
   */
  async getModuleTenants(
    moduleId: string,
    page: number = 1,
    limit: number = 50,
  ) {
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
          FROM public.tenants t
          JOIN public.tenant_modules tm ON t.id = tm."tenantId"
          WHERE tm."moduleId" = $1
          ORDER BY tm."activatedAt" DESC
          LIMIT $2 OFFSET $3
        `,
          [moduleId, limit, offset],
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as total FROM public.tenant_modules WHERE "moduleId" = $1`,
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
    page: number = 1,
    limit: number = 50,
  ) {
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
          FROM public.tenant_modules tm
          JOIN public.tenants t ON tm."tenantId" = t.id
          JOIN public.modules m ON tm."moduleId" = m.id
          ${whereClause}
          ORDER BY tm."activatedAt" DESC
          LIMIT $${paramIndex++} OFFSET $${paramIndex}
        `,
          [...params, limit, offset],
        ),
        this.dataSource.query(
          `SELECT COUNT(*) as total FROM public.tenant_modules tm ${whereClause}`,
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
      // Check if tenant_modules table has quantities and configuration columns
      // If they exist, use them; otherwise, use the basic insert
      const hasExtendedColumns = await this.checkExtendedColumns();

      let result;
      if (hasExtendedColumns && (dto.quantities || dto.configuration)) {
        result = await this.dataSource.query(
          `
          INSERT INTO public.tenant_modules (
            "tenantId", "moduleId", "expiresAt", "assignedBy",
            "quantities", "configuration"
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT ("tenantId", "moduleId") DO UPDATE SET
            "expiresAt" = EXCLUDED."expiresAt",
            "quantities" = COALESCE(EXCLUDED."quantities", tenant_modules."quantities"),
            "configuration" = COALESCE(EXCLUDED."configuration", tenant_modules."configuration")
          RETURNING id, "tenantId" as "tenantId", "moduleId" as "moduleId",
                    "activatedAt" as "assignedAt", "expiresAt" as "expiresAt",
                    "quantities", "configuration"
        `,
          [
            dto.tenantId,
            dto.moduleId,
            dto.expiresAt || null,
            dto.assignedBy || dto.tenantId,
            dto.quantities ? JSON.stringify(dto.quantities) : null,
            dto.configuration ? JSON.stringify(dto.configuration) : null,
          ],
        );
      } else {
        result = await this.dataSource.query(
          `
          INSERT INTO public.tenant_modules ("tenantId", "moduleId", "expiresAt", "assignedBy")
          VALUES ($1, $2, $3, $4)
          ON CONFLICT ("tenantId", "moduleId") DO UPDATE SET "expiresAt" = $3
          RETURNING id, "tenantId" as "tenantId", "moduleId" as "moduleId",
                    "activatedAt" as "assignedAt", "expiresAt" as "expiresAt"
        `,
          [dto.tenantId, dto.moduleId, dto.expiresAt || null, dto.assignedBy || dto.tenantId],
        );
      }

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
          FROM public.tenant_modules tm
          JOIN public.tenants t ON tm."tenantId" = t.id
          JOIN public.modules m ON tm."moduleId" = m.id
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
          FROM public.tenant_modules tm
          JOIN public.tenants t ON tm."tenantId" = t.id
          JOIN public.modules m ON tm."moduleId" = m.id
          WHERE tm.id = $1
        `;

      const assignment = await this.dataSource.query(selectQuery, [result[0].id]);

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
        AND table_schema = 'public'
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
        `DELETE FROM public.tenant_modules WHERE "tenantId" = $1 AND "moduleId" = $2 RETURNING id`,
        [tenantId, moduleId],
      );

      if (!result[0]) {
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
}
