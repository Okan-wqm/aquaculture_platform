import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import { Repository, DataSource } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import {
  AssignUserToModuleInput,
  AssignmentResult,
  UserModuleInfo,
  MyTenantInfo,
  TenantTableInfo,
  TableDataResult,
  GetTableDataInput,
} from '../dto/tenant-admin.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

/**
 * Database query result interfaces
 */
interface TableInfoRow {
  tableName: string;
  rowCount: string | null;
}

interface CountRow {
  count: string;
}

interface ColumnInfoRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface DataRow {
  [key: string]: unknown;
}

/**
 * TenantAdminService
 *
 * Service for tenant admin operations:
 * - View own tenant info
 * - View assigned modules
 * - Assign module managers/users
 * - View tenant database (read-only)
 */
@Injectable()
export class TenantAdminService {
  private readonly logger = new Logger(TenantAdminService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(TenantModule)
    private readonly tenantModuleRepository: Repository<TenantModule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get current user's tenant info with stats
   */
  async getMyTenant(userId: string): Promise<MyTenantInfo> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.tenantId) {
      throw new NotFoundException('User or tenant not found');
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: user.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Count current users in tenant
    const currentUserCount = await this.userRepository.count({
      where: { tenantId: tenant.id, isActive: true },
    });

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description,
      logoUrl: tenant.logoUrl,
      status: tenant.status,
      plan: tenant.plan,
      maxUsers: tenant.maxUsers,
      currentUserCount,
    };
  }

  /**
   * Get modules assigned to current user's tenant
   * For TENANT_ADMIN: Returns all modules assigned to tenant
   * For MODULE_MANAGER/USER: Returns only assigned modules
   */
  async getMyModules(userId: string): Promise<UserModuleInfo[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // TENANT_ADMIN gets all tenant modules
    if (user.role === Role.TENANT_ADMIN) {
      if (!user.tenantId) {
        return [];
      }

      const tenantModules = await this.tenantModuleRepository.find({
        where: { tenantId: user.tenantId, isEnabled: true },
        relations: ['module'],
        order: { module: { sortOrder: 'ASC' } },
      });

      return tenantModules.map((tm) => ({
        id: tm.id,
        moduleId: tm.moduleId,
        name: tm.module.name,
        description: tm.module.description,
        icon: tm.module.icon,
        color: tm.module.color,
        isEnabled: tm.isEnabled,
        defaultRoute: tm.module.defaultRoute,
      }));
    }

    // MODULE_MANAGER and MODULE_USER get their assigned modules
    const assignments = await this.userModuleAssignmentRepository.find({
      where: { userId: user.id, isActive: true },
      relations: ['module'],
    });

    return assignments
      .filter((a) => a.isAccessible() && a.module)
      .map((a) => ({
        id: a.id,
        moduleId: a.moduleId,
        name: a.module.name,
        description: a.module.description,
        icon: a.module.icon,
        color: a.module.color,
        isEnabled: true,
        defaultRoute: a.module.defaultRoute,
      }));
  }

  /**
   * Get users assigned to a specific module in tenant
   */
  async getModuleUsers(
    tenantAdminId: string,
    moduleId: string,
  ): Promise<User[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // Verify module belongs to tenant
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId: admin.tenantId, moduleId },
    });

    if (!tenantModule) {
      throw new ForbiddenException('Module not assigned to tenant');
    }

    // Get all users assigned to this module
    const assignments = await this.userModuleAssignmentRepository.find({
      where: { moduleId, tenantId: admin.tenantId, isActive: true },
      relations: ['user'],
    });

    return assignments.map((a) => a.user);
  }

  /**
   * Assign a user to a module (create or update)
   */
  async assignUserToModule(
    tenantAdminId: string,
    input: AssignUserToModuleInput,
  ): Promise<AssignmentResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // Verify module belongs to tenant
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId: admin.tenantId, moduleId: input.moduleId },
      relations: ['module'],
    });

    if (!tenantModule) {
      throw new ForbiddenException('Module not assigned to tenant');
    }

    // Check tenant user limit
    const tenant = await this.tenantRepository.findOne({
      where: { id: admin.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (tenant.status !== TenantStatus.ACTIVE) {
      throw new ForbiddenException('Tenant is not active');
    }

    // Check if user already exists
    let user = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase(), tenantId: admin.tenantId },
    });

    let isNewUser = false;

    if (!user) {
      // Check user limit
      const currentUserCount = await this.userRepository.count({
        where: { tenantId: admin.tenantId, isActive: true },
      });

      if (currentUserCount >= tenant.maxUsers) {
        throw new BadRequestException(
          `User limit reached (${tenant.maxUsers}). Please upgrade your plan.`,
        );
      }

      // Create new user
      const role =
        input.role === 'manager' ? Role.MODULE_MANAGER : Role.MODULE_USER;

      user = this.userRepository.create({
        email: input.email.toLowerCase(),
        firstName: input.firstName,
        lastName: input.lastName,
        password: input.password,
        tenantId: admin.tenantId,
        role,
        isActive: true,
        isEmailVerified: false,
      });

      await this.userRepository.save(user);
      isNewUser = true;

      this.logger.log(
        `Created new user ${user.email} for tenant ${tenant.name}`,
      );
    }

    // Check existing assignment
    const existingAssignment = await this.userModuleAssignmentRepository.findOne(
      {
        where: { userId: user.id, moduleId: input.moduleId },
      },
    );

    if (existingAssignment) {
      // Reactivate if inactive
      if (!existingAssignment.isActive) {
        existingAssignment.isActive = true;
        existingAssignment.isPrimaryManager = input.role === 'manager';
        await this.userModuleAssignmentRepository.save(existingAssignment);

        return {
          success: true,
          message: 'User assignment reactivated',
          userId: user.id,
          isNewUser: false,
        };
      }

      return {
        success: true,
        message: 'User already assigned to module',
        userId: user.id,
        isNewUser: false,
      };
    }

    // Create assignment
    const assignment = this.userModuleAssignmentRepository.create({
      userId: user.id,
      moduleId: input.moduleId,
      tenantId: admin.tenantId,
      isPrimaryManager: input.role === 'manager',
      isActive: true,
      assignedBy: tenantAdminId,
    });

    await this.userModuleAssignmentRepository.save(assignment);

    this.logger.log(
      `Assigned user ${user.email} to module ${tenantModule.module.name}`,
    );

    return {
      success: true,
      message: isNewUser
        ? 'New user created and assigned to module'
        : 'User assigned to module',
      userId: user.id,
      isNewUser,
    };
  }

  /**
   * Remove user from module
   */
  async removeUserFromModule(
    tenantAdminId: string,
    userId: string,
    moduleId: string,
  ): Promise<boolean> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const assignment = await this.userModuleAssignmentRepository.findOne({
      where: { userId, moduleId, tenantId: admin.tenantId },
    });

    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    assignment.isActive = false;
    await this.userModuleAssignmentRepository.save(assignment);

    this.logger.log(`Removed user ${userId} from module ${moduleId}`);
    return true;
  }

  /**
   * Get tenant's users list
   */
  async getTenantUsers(tenantAdminId: string): Promise<User[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    return this.userRepository.find({
      where: { tenantId: admin.tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Deactivate a user in tenant
   */
  async deactivateUser(tenantAdminId: string, userId: string): Promise<User> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: admin.tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === Role.TENANT_ADMIN) {
      throw new ForbiddenException('Cannot deactivate tenant admin');
    }

    user.isActive = false;
    const saved = await this.userRepository.save(user);

    this.logger.log(`Deactivated user ${user.email}`);
    return saved;
  }

  /**
   * Activate a user in tenant
   */
  async activateUser(tenantAdminId: string, userId: string): Promise<User> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: admin.tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.isActive = true;
    const saved = await this.userRepository.save(user);

    this.logger.log(`Activated user ${user.email}`);
    return saved;
  }

  // =========================================================
  // Database Viewer Methods (Read-Only)
  // =========================================================

  /**
   * Get list of tables in tenant's schema
   * Only works if tenant has separate schema
   */
  async getTenantTables(tenantAdminId: string): Promise<TenantTableInfo[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: admin.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Get schema name from tenant slug
    const schemaName = `tenant_${tenant.slug.replace(/-/g, '_')}`;

    try {
      // Query PostgreSQL information_schema
      const tables = (await this.dataSource.query(
        `
        SELECT
          table_name as "tableName",
          (SELECT reltuples::bigint
           FROM pg_class
           WHERE oid = (quote_ident($1) || '.' || quote_ident(table_name))::regclass) as "rowCount"
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
        [schemaName],
      )) as TableInfoRow[];

      // Map tables to modules (based on naming convention)
      return tables.map((t) => ({
        tableName: t.tableName,
        rowCount: Number(t.rowCount) || 0,
        module: this.inferModuleFromTableName(t.tableName),
      }));
    } catch (error) {
      this.logger.warn(
        `Could not query tenant schema ${schemaName}: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Return main schema tables for the tenant (filtered by tenant_id)
      return this.getMainSchemaTables(admin.tenantId);
    }
  }

  /**
   * Get data from a specific table (paginated)
   * Uses row-level tenant isolation with WHERE tenantId = ?
   */
  async getTableData(
    tenantAdminId: string,
    input: GetTableDataInput,
  ): Promise<TableDataResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const tenantId = admin.tenantId;

    // Validate identifiers (prevent SQL injection)
    const validIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!validIdentifier.test(input.schemaName) || !validIdentifier.test(input.tableName)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    // Get tenant's assigned modules
    const tenantModules = await this.tenantModuleRepository.find({
      where: { tenantId, isEnabled: true },
      relations: ['module'],
    });

    // Module schemas (farm, hr, sensor, etc.)
    const moduleSchemas = tenantModules
      .map(tm => tm.module?.code)
      .filter((code): code is string => !!code);

    // Get tenant's dedicated schema name
    const tenantSchemaName = this.getTenantSchemaName(tenantId);

    // Allowed schemas: tenant's own schema + auth + tenant's module schemas
    const allowedSchemas = [tenantSchemaName, 'auth', ...moduleSchemas];

    // Validate schema access
    if (!allowedSchemas.includes(input.schemaName)) {
      throw new ForbiddenException(
        `Access denied: You do not have permission to view tables in schema '${input.schemaName}'`,
      );
    }

    const limit = Math.min(input.limit, 1000); // Max 1000 rows
    const offset = input.offset;
    const fullTableName = `"${input.schemaName}"."${input.tableName}"`;

    try {
      // Get columns
      const columnsResult = (await this.dataSource.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `,
        [input.schemaName, input.tableName],
      )) as Array<{ column_name: string }>;

      if (columnsResult.length === 0) {
        throw new NotFoundException(`Table not found: ${input.schemaName}.${input.tableName}`);
      }

      const columns = columnsResult.map((c) => c.column_name);

      // Check if table has tenantId column
      const hasTenantId = columns.includes('tenantId');

      // Get total count (with tenant filter if applicable)
      let totalRows = 0;
      if (hasTenantId) {
        const countResult = (await this.dataSource.query(
          `SELECT COUNT(*) as count FROM ${fullTableName} WHERE "tenantId" = $1`,
          [tenantId],
        )) as CountRow[];
        totalRows = Number(countResult[0]?.count) || 0;
      } else {
        const countResult = (await this.dataSource.query(
          `SELECT COUNT(*) as count FROM ${fullTableName}`,
        )) as CountRow[];
        totalRows = Number(countResult[0]?.count) || 0;
      }

      // Get data (with tenant filter if applicable)
      let rows: DataRow[];
      if (hasTenantId) {
        rows = (await this.dataSource.query(
          `SELECT * FROM ${fullTableName} WHERE "tenantId" = $1 ORDER BY 1 LIMIT $2 OFFSET $3`,
          [tenantId, limit, offset],
        )) as DataRow[];
      } else {
        rows = (await this.dataSource.query(
          `SELECT * FROM ${fullTableName} ORDER BY 1 LIMIT $1 OFFSET $2`,
          [limit, offset],
        )) as DataRow[];
      }

      return {
        tableName: `${input.schemaName}.${input.tableName}`,
        totalRows,
        columns,
        rows: JSON.stringify(rows),
        offset,
        limit,
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to get table data: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException(
        `Could not read table: ${input.schemaName}.${input.tableName}`,
      );
    }
  }

  /**
   * Generate tenant schema name from tenant ID
   * Format: tenant_{first8chars_of_uuid} (e.g., tenant_4b529829)
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 8);
    return `tenant_${cleanId}`;
  }

  /**
   * Infer module from table name based on naming convention
   */
  private inferModuleFromTableName(tableName: string): string | null {
    const moduleMapping: Record<string, string> = {
      farms: 'farm',
      ponds: 'farm',
      tanks: 'farm',
      stocks: 'farm',
      harvests: 'farm',
      employees: 'hr',
      departments: 'hr',
      attendance: 'hr',
      leaves: 'hr',
      cultures: 'seapod',
      products: 'inventory',
      warehouses: 'inventory',
      customers: 'crm',
      contacts: 'crm',
      accounts: 'finance',
      invoices: 'finance',
      transactions: 'finance',
      projects: 'project',
      tasks: 'project',
    };

    for (const [prefix, module] of Object.entries(moduleMapping)) {
      if (tableName.toLowerCase().includes(prefix)) {
        return module;
      }
    }

    return null;
  }

  /**
   * Get tables from main schema (when tenant doesn't have separate schema)
   */
  private async getMainSchemaTables(
    tenantId: string,
  ): Promise<TenantTableInfo[]> {
    // List of known tables that have tenant_id
    const tenantTables = [
      'farms',
      'ponds',
      'stocks',
      'employees',
      'departments',
      'sensors',
      'sensor_readings',
    ];

    const result: TenantTableInfo[] = [];

    for (const tableName of tenantTables) {
      try {
        const countResult = (await this.dataSource.query(
          `SELECT COUNT(*) as count FROM "${tableName}" WHERE "tenantId" = $1`,
          [tenantId],
        )) as CountRow[];

        result.push({
          tableName,
          rowCount: Number(countResult[0]?.count) || 0,
          module: this.inferModuleFromTableName(tableName),
        });
      } catch {
        // Table doesn't exist or doesn't have tenantId column
        continue;
      }
    }

    return result;
  }

  /**
   * Get data from main schema table (filtered by tenant_id)
   */
  private async getMainSchemaTableData(
    tenantId: string,
    input: GetTableDataInput,
    limit: number,
    offset: number,
  ): Promise<TableDataResult> {
    try {
      const tableName = input.tableName;

      // Get columns
      const columnsResult = (await this.dataSource.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
        [tableName],
      )) as Array<{ column_name: string }>;

      const columns = columnsResult.map((c) => c.column_name);

      // Get total count (filtered by tenant)
      const countResult = (await this.dataSource.query(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE "tenantId" = $1`,
        [tenantId],
      )) as CountRow[];
      const totalRows = Number(countResult[0]?.count) || 0;

      // Get data (filtered by tenant)
      const rows = (await this.dataSource.query(
        `SELECT * FROM "${tableName}" WHERE "tenantId" = $1 ORDER BY 1 LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      )) as DataRow[];

      return {
        tableName,
        totalRows,
        columns,
        rows: JSON.stringify(rows),
        offset,
        limit,
      };
    } catch {
      throw new BadRequestException(
        `Could not read table: ${input.tableName}`,
      );
    }
  }
}
