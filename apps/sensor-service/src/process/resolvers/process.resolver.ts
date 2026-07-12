import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { Tenant, CurrentUser, CurrentUserPayload, Roles, Role } from '@aquaculture/backend-common/decorators';

import {
  CreateProcessInput,
  UpdateProcessInput,
  ProcessFilterInput,
  ProcessPaginationInput,
  ProcessType,
  ProcessResultType,
  ProcessListType,
  DeleteProcessResultType,
  DeployProcessResultType,
} from '../dto/process.dto';
import {
  CreateScadaPackageInput,
  UpdateScadaPackageInput,
  ScadaPackageFilterInput,
  ScadaPackageType,
  ScadaPackageListType,
  DeployScadaPackageResultType,
  ScadaBackfillResultType,
  DeployScadaWithAutomationInput,
  UnifiedDeployResultType,
} from '../dto/scada-package.dto';
import {
  DeployLogFilterInput,
  ScadaDeployLogType,
  ScadaDeployLogListType,
} from '../dto/scada-deploy-log.dto';
import { Process } from '../entities/process.entity';
import { ScadaPackage } from '../entities/scada-package.entity';
import { ProcessService } from '../services/process.service';
import { ScadaPackageService } from '../services/scada-package.service';
import { ScadaDeployLogService } from '../services/scada-deploy-log.service';


@Resolver(() => ProcessType)
export class ProcessResolver {
  constructor(
    private processService: ProcessService,
    private scadaPackageService: ScadaPackageService,
    private scadaDeployLogService: ScadaDeployLogService,
  ) {}

  // ============================================================================
  // Queries
  // ============================================================================

  @Query(() => ProcessType, { name: 'process', nullable: true })
  async getProcess(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<ProcessType | null> {
    const process = await this.processService.getProcess(id, tenantId);
    if (!process) return null;
    return this.mapToType(process);
  }

  @Query(() => ProcessListType, { name: 'processes' })
  async listProcesses(
    @Args('filter', { nullable: true }) filter?: ProcessFilterInput,
    @Args('pagination', { nullable: true }) pagination?: ProcessPaginationInput,
    @Tenant() tenantId?: string,
  ): Promise<ProcessListType> {
    const result = await this.processService.listProcesses(tenantId ?? '', filter, pagination);
    return {
      ...result,
      items: result.items.map((p) => this.mapToType(p)),
    };
  }

  @Query(() => [ProcessType], { name: 'activeProcesses' })
  async getActiveProcesses(
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Tenant() tenantId?: string,
  ): Promise<ProcessType[]> {
    const processes = await this.processService.getActiveProcesses(tenantId ?? '', siteId);
    return processes.map((p) => this.mapToType(p));
  }

  @Query(() => [ProcessType], { name: 'processTemplates' })
  async getProcessTemplates(
    @Tenant() tenantId: string,
  ): Promise<ProcessType[]> {
    const templates = await this.processService.getTemplates(tenantId);
    return templates.map((p) => this.mapToType(p));
  }

  // ============================================================================
  // Mutations
  // SECURITY: All mutations require elevated permissions
  // ============================================================================

  /**
   * Create a new process
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProcessResultType, { name: 'createProcess' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createProcess(
    @Args('input') input: CreateProcessInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.createProcess(input, tenantId, user.sub);
      return {
        success: true,
        message: 'Process created successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to create process',
      };
    }
  }

  /**
   * Update an existing process
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProcessResultType, { name: 'updateProcess' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateProcess(
    @Args('input') input: UpdateProcessInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.updateProcess(input, tenantId, user.sub);
      return {
        success: true,
        message: 'Process updated successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to update process',
      };
    }
  }

  /**
   * Delete (archive) a process
   * SECURITY: Requires TENANT_ADMIN
   */
  @Mutation(() => DeleteProcessResultType, { name: 'deleteProcess' })
  @Roles(Role.TENANT_ADMIN)
  async deleteProcess(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeleteProcessResultType> {
    try {
      const success = await this.processService.deleteProcess(id, tenantId);
      return {
        success,
        message: success ? 'Process archived successfully' : 'Failed to archive process',
        deletedId: success ? id : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to delete process',
      };
    }
  }

  /**
   * Duplicate a process
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProcessResultType, { name: 'duplicateProcess' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async duplicateProcess(
    @Args('id', { type: () => ID }) id: string,
    @Args('newName') newName: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.duplicateProcess(id, newName, tenantId, user.sub);
      return {
        success: true,
        message: 'Process duplicated successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to duplicate process',
      };
    }
  }

  /**
   * Create process from template
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProcessResultType, { name: 'createProcessFromTemplate' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFromTemplate(
    @Args('templateId', { type: () => ID }) templateId: string,
    @Args('name') name: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ProcessResultType> {
    try {
      const process = await this.processService.createFromTemplate(templateId, name, tenantId, user.sub);
      return {
        success: true,
        message: 'Process created from template successfully',
        process: this.mapToType(process),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to create process from template',
      };
    }
  }

  /**
   * Deploy a process to an edge device
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => DeployProcessResultType, { name: 'deployProcessToEdge' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deployProcessToEdge(
    @Args('processId', { type: () => ID }) processId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DeployProcessResultType> {
    try {
      const result = await this.processService.deployProcessToEdge(
        processId,
        deviceId,
        tenantId,
        user.sub,
      );
      return {
        success: result.success,
        message: result.message,
        processId: result.success ? processId : undefined,
        deviceId: result.success ? deviceId : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Failed to deploy process',
      };
    }
  }

  // ============================================================================
  // SCADA Package Queries
  // ============================================================================

  @Query(() => ScadaPackageType, { name: 'scadaPackage', nullable: true })
  async getScadaPackage(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<ScadaPackageType | null> {
    const pkg = await this.scadaPackageService.getScadaPackage(id, tenantId);
    if (!pkg) return null;
    return this.mapScadaPackageToType(pkg, tenantId);
  }

  @Query(() => ScadaPackageListType, { name: 'scadaPackages' })
  async listScadaPackages(
    @Args('filter', { nullable: true }) filter?: ScadaPackageFilterInput,
    @Args('pagination', { nullable: true }) pagination?: ProcessPaginationInput,
    @Tenant() tenantId?: string,
  ): Promise<ScadaPackageListType> {
    const result = await this.scadaPackageService.listScadaPackages(tenantId ?? '', filter, pagination);
    return {
      ...result,
      items: await Promise.all(result.items.map(p => this.mapScadaPackageToType(p, tenantId))),
    };
  }

  // ============================================================================
  // SCADA Deploy Log Queries
  // ============================================================================

  @Query(() => ScadaDeployLogListType, { name: 'scadaDeployLogs' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async scadaDeployLogs(
    @Args('filter') filter: DeployLogFilterInput,
    @Tenant() tenantId: string,
  ): Promise<ScadaDeployLogListType> {
    if (filter.packageId) {
      const items = await this.scadaDeployLogService.getByPackage(filter.packageId, tenantId);
      return { items, total: items.length };
    }
    if (filter.deviceId) {
      return this.scadaDeployLogService.getByDevice(
        filter.deviceId,
        tenantId,
        filter.page,
        filter.limit,
      );
    }
    // Neither filter provided — return empty result
    return { items: [], total: 0 };
  }

  @Query(() => ScadaDeployLogType, { name: 'latestScadaDeployLog', nullable: true })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async latestScadaDeployLog(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
  ): Promise<ScadaDeployLogType | null> {
    return this.scadaDeployLogService.getLatestByDevice(deviceId, tenantId);
  }

  // ============================================================================
  // SCADA Package Mutations
  // ============================================================================

  @Mutation(() => ScadaPackageType, { name: 'createScadaPackage' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createScadaPackage(
    @Args('input') input: CreateScadaPackageInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ScadaPackageType> {
    const pkg = await this.scadaPackageService.createScadaPackage(input, tenantId, user.sub);
    return this.mapScadaPackageToType(pkg, tenantId);
  }

  @Mutation(() => ScadaPackageType, { name: 'updateScadaPackage' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateScadaPackage(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateScadaPackageInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ScadaPackageType> {
    const pkg = await this.scadaPackageService.updateScadaPackage(id, input, tenantId, user.sub);
    return this.mapScadaPackageToType(pkg, tenantId);
  }

  /**
   * Backfill this tenant's legacy SCADA package docs to ScadaPackageDocV2
   * (Faz 6 / 6d). Idempotent; `dryRun` previews without writing. Run per tenant
   * for a platform-wide migration. SECURITY: TENANT_ADMIN only.
   */
  @Mutation(() => ScadaBackfillResultType, { name: 'backfillScadaPackageDocs' })
  @Roles(Role.TENANT_ADMIN)
  async backfillScadaPackageDocs(
    @Tenant() tenantId: string,
    @Args('dryRun', { type: () => Boolean, nullable: true, defaultValue: false }) dryRun: boolean,
  ): Promise<ScadaBackfillResultType> {
    return this.scadaPackageService.backfillPackageDocsToV2(tenantId, { dryRun });
  }

  @Mutation(() => DeleteProcessResultType, { name: 'deleteScadaPackage' })
  @Roles(Role.TENANT_ADMIN)
  async deleteScadaPackage(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DeleteProcessResultType> {
    try {
      const result = await this.scadaPackageService.deleteScadaPackage(id, tenantId, user.sub);
      // Honest per-device reporting (WF-011): archive always succeeds; the
      // message names which devices got the undeploy and which were missed.
      const sent = result.undeploy.filter((r) => r.sent);
      const missed = result.undeploy.filter((r) => !r.sent);
      const parts = ['Paket arşivlendi'];
      if (sent.length > 0) parts.push(`undeploy gönderildi: ${sent.length} cihaz`);
      if (missed.length > 0) {
        parts.push(`ulaşılamadı: ${missed.map((r) => r.message).join('; ')}`);
      }
      return { success: true, message: parts.join(' — '), deletedId: id };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }

  @Mutation(() => DeployScadaPackageResultType, { name: 'deployScadaPackageToEdge' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deployScadaPackageToEdge(
    @Args('packageId', { type: () => ID }) packageId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DeployScadaPackageResultType> {
    try {
      const result = await this.scadaPackageService.deployScadaPackageToEdge(packageId, deviceId, tenantId, user.sub);
      return { success: result.success, message: result.message, packageId: result.success ? packageId : undefined, deviceId: result.success ? deviceId : undefined };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * Roll a device back to a previously-shipped SCADA artifact snapshot
   * (real rollback, Faz 3 — republishes the archived content verbatim).
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER.
   */
  @Mutation(() => DeployScadaPackageResultType, { name: 'rollbackScadaPackageDeploy' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async rollbackScadaPackageDeploy(
    @Args('artifactId', { type: () => ID }) artifactId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DeployScadaPackageResultType> {
    try {
      const result = await this.scadaPackageService.rollbackScadaPackageDeploy(
        artifactId,
        deviceId,
        tenantId,
        user.sub,
      );
      return {
        success: result.success,
        message: result.message,
        deviceId: result.success ? deviceId : undefined,
      };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * Deploy SCADA package together with its bound automation programs.
   * Deploys automation programs first, then the SCADA package.
   * If any automation deployment fails, SCADA deployment is aborted.
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => UnifiedDeployResultType, { name: 'deployScadaWithAutomation' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deployScadaWithAutomation(
    @Args('input') input: DeployScadaWithAutomationInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<UnifiedDeployResultType> {
    try {
      const result = await this.scadaPackageService.deployScadaWithAutomation(
        input.packageId,
        input.deviceId,
        tenantId,
        user.sub,
        input.programIds,
      );
      return {
        success: result.success,
        message: result.message,
        automationResults: result.automationResults.map((r) => ({
          programId: r.programId,
          success: r.success,
          message: r.message,
          commandId: r.commandId,
        })),
        scadaResult: result.scadaResult
          ? {
              packageId: result.scadaResult.packageId,
              success: result.scadaResult.success,
              message: result.scadaResult.message,
            }
          : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message || 'Unified deployment failed',
        automationResults: [],
      };
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private mapToType(process: Process): ProcessType {
    return {
      id: process.id,
      name: process.name,
      description: process.description,
      status: process.status,
      nodes: process.nodes,
      edges: process.edges,
      tenantId: process.tenantId,
      siteId: process.siteId,
      departmentId: process.departmentId,
      metadata: process.metadata,
      isTemplate: process.isTemplate,
      templateName: process.templateName,
      createdAt: process.createdAt,
      updatedAt: process.updatedAt,
      createdBy: process.createdBy,
      updatedBy: process.updatedBy,
    };
  }

  private async mapScadaPackageToType(pkg: ScadaPackage, tenantId?: string): Promise<ScadaPackageType> {
    let processName: string | undefined;
    if (pkg.processId && tenantId) {
      try {
        const process = await this.processService.getProcess(pkg.processId, tenantId);
        processName = process?.name;
      } catch {
        // Process may have been deleted; leave processName undefined
      }
    }
    return {
      id: pkg.id,
      tenantId: pkg.tenantId,
      name: pkg.name,
      description: pkg.description,
      version: pkg.version,
      processId: pkg.processId,
      processName,
      packageData: pkg.packageData,
      status: pkg.status,
      createdBy: pkg.createdBy,
      updatedBy: pkg.updatedBy,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
    };
  }
}
