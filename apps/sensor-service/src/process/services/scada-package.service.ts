import { randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { upcastScadaPackageDoc } from '@platform/sensor-contracts';
import {
  formatValidationErrors,
  validateScadaPackageDocV2,
} from '@platform/sensor-contracts/validators';

import { AutomationService } from '../../automation/automation.service';
import { AutomationProgram, ProgramStatus } from '../../automation/entities/automation-program.entity';
import { ProgramVariable } from '../../automation/entities/program-variable.entity';
import { ArtifactService } from '../../deploy-artifact/artifact.service';
import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';
import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';

import {
  CreateScadaPackageInput,
  UpdateScadaPackageInput,
  ScadaPackageFilterInput,
} from '../dto/scada-package.dto';
import { ProcessPaginationInput } from '../dto/process.dto';
import { Process } from '../entities/process.entity';
import { ScadaPackage, ScadaPackageStatus } from '../entities/scada-package.entity';
import { ScadaDeployLogService } from './scada-deploy-log.service';
import { TagResolutionService } from './tag-resolution.service';

@Injectable()
export class ScadaPackageService {
  private readonly logger = new Logger(ScadaPackageService.name);

  /** Max packageData size: 1 MB */
  private static readonly MAX_PACKAGE_DATA_BYTES = 1_048_576;

  private validatePackageDataSize(data: Record<string, unknown>): void {
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
    if (size > ScadaPackageService.MAX_PACKAGE_DATA_BYTES) {
      throw new BadRequestException(
        `packageData exceeds maximum size (${(size / 1024).toFixed(0)} KB > 1024 KB)`,
      );
    }
  }

  private validatePackageDataStructure(data: Record<string, unknown>): void {
    // Screens must be an array if present
    if (data.screens !== undefined && !Array.isArray(data.screens)) {
      throw new BadRequestException('packageData.screens must be an array');
    }
    // Each screen must have widgets as array if present
    if (Array.isArray(data.screens)) {
      for (const screen of data.screens) {
        if (screen && typeof screen === 'object' && 'widgets' in screen) {
          if (!Array.isArray((screen as Record<string, unknown>).widgets)) {
            throw new BadRequestException('Each screen.widgets must be an array');
          }
        }
      }
    }
  }

  /**
   * Save-time trust boundary (ScadaPackageDocV2): upcast whatever the
   * client sent to the current document contract, then validate it against
   * the canonical JSON Schema. Returns the upcasted document — the stored
   * row is always V2, so read paths only upcast legacy pre-Faz2 rows.
   */
  private async upcastAndValidatePackageData(
    data: Record<string, unknown>,
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    const deviceCode = await this.resolveDeviceCode(
      (data.meta as Record<string, unknown> | undefined)?.edgeDeviceId,
      tenantId,
    );
    const doc = upcastScadaPackageDoc(data, deviceCode ? { deviceCode } : undefined);
    if (!validateScadaPackageDocV2(doc)) {
      throw new BadRequestException(
        `packageData failed ScadaPackageDocV2 validation: ${formatValidationErrors(validateScadaPackageDocV2)}`,
      );
    }
    return doc;
  }

  /** Best-effort edgeDeviceId → deviceCode lookup for TagRef promotion. */
  private async resolveDeviceCode(
    edgeDeviceId: unknown,
    tenantId: string,
  ): Promise<string | undefined> {
    if (typeof edgeDeviceId !== 'string' || !edgeDeviceId || !this.edgeDeviceService) {
      return undefined;
    }
    try {
      const device = await this.edgeDeviceService.findByIdOrFail(edgeDeviceId, tenantId);
      return device.deviceCode;
    } catch {
      // Unknown/foreign device: legacy local names simply stay unpromoted.
      return undefined;
    }
  }

  /**
   * Strip sensitive fields (e.g. pinHash) from packageData before returning to clients.
   * Returns a shallow-modified copy — does NOT mutate the DB record.
   */
  private sanitizePackageData(pkg: ScadaPackage): ScadaPackage {
    const data = pkg.packageData;
    const controlPermissions = data.controlPermissions as Record<string, unknown> | undefined;
    if (controlPermissions?.pinHash) {
      // Return a copy — do not mutate the original entity that may be cached by TypeORM
      const clone = Object.assign(Object.create(Object.getPrototypeOf(pkg)), pkg);
      clone.packageData = {
        ...data,
        controlPermissions: {
          ...controlPermissions,
          pinHash: '[REDACTED]',
        },
      };
      return clone;
    }
    return pkg;
  }

  constructor(
    @InjectRepository(ScadaPackage)
    private readonly scadaPackageRepository: Repository<ScadaPackage>,
    @InjectRepository(Process)
    private readonly processRepository: Repository<Process>,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    @Optional()
    @Inject(EdgeDeviceService)
    private readonly edgeDeviceService: EdgeDeviceService | null,
    @Optional()
    @Inject(ScadaDeployLogService)
    private readonly scadaDeployLogService: ScadaDeployLogService | null,
    @Optional()
    @Inject(AutomationService)
    private readonly automationService: AutomationService | null,
    @Optional()
    @InjectRepository(AutomationProgram)
    private readonly automationProgramRepo: Repository<AutomationProgram> | null,
    @Optional()
    @InjectRepository(ProgramVariable)
    private readonly programVariableRepo: Repository<ProgramVariable> | null,
    @Optional()
    @Inject(TagResolutionService)
    private readonly tagResolutionService: TagResolutionService | null,
    @Optional()
    @Inject(ArtifactService)
    private readonly artifactService: ArtifactService | null,
  ) {}

  /**
   * Collect the tag-name strings widgets bind to (`config.tagName`, legacy
   * `config.tag`) from every screen in the package document.
   */
  private collectWidgetTagNames(data: Record<string, unknown>): string[] {
    const names = new Set<string>();
    const screens = Array.isArray(data.screens) ? data.screens : [];
    for (const screen of screens) {
      const widgets = (screen as { widgets?: unknown[] })?.widgets;
      if (!Array.isArray(widgets)) continue;
      for (const widget of widgets) {
        const config = (widget as { config?: Record<string, unknown> })?.config;
        for (const key of ['tagName', 'tag'] as const) {
          const value = config?.[key];
          if (typeof value === 'string' && value.length > 0) {
            names.add(value);
          }
        }
      }
    }
    return [...names];
  }

  async createScadaPackage(
    input: CreateScadaPackageInput,
    tenantId: string,
    userId?: string,
  ): Promise<ScadaPackage> {
    this.logger.log(`Creating SCADA package "${input.name}" for tenant ${tenantId}`);

    this.validatePackageDataSize(input.packageData);
    this.validatePackageDataStructure(input.packageData);
    const packageData = await this.upcastAndValidatePackageData(input.packageData, tenantId);

    if (input.processId) {
      const process = await this.processRepository.findOne({
        where: { id: input.processId, tenantId },
      });
      if (!process) {
        throw new NotFoundException(
          `Process with id ${input.processId} not found in current tenant`,
        );
      }
    }

    const pkg = this.scadaPackageRepository.create({
      ...input,
      packageData,
      tenantId,
      status: ScadaPackageStatus.DRAFT,
      version: 1,
      createdBy: userId,
    });
    return this.scadaPackageRepository.save(pkg);
  }

  async updateScadaPackage(
    id: string,
    input: UpdateScadaPackageInput,
    tenantId: string,
    userId?: string,
  ): Promise<ScadaPackage> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${id} not found`);

    if (input.processId !== undefined) {
      const process = await this.processRepository.findOne({
        where: { id: input.processId, tenantId },
      });
      if (!process) {
        throw new NotFoundException(
          `Process with id ${input.processId} not found in current tenant`,
        );
      }
    }

    if (input.packageData !== undefined) {
      this.validatePackageDataSize(input.packageData);
      this.validatePackageDataStructure(input.packageData);
      pkg.packageData = await this.upcastAndValidatePackageData(input.packageData, tenantId);
    }

    if (input.name !== undefined) pkg.name = input.name;
    if (input.description !== undefined) pkg.description = input.description;
    if (input.processId !== undefined) pkg.processId = input.processId;
    if (input.status !== undefined) pkg.status = input.status;

    pkg.version = pkg.version + 1;
    pkg.updatedBy = userId;

    return this.scadaPackageRepository.save(pkg);
  }

  async getScadaPackage(id: string, tenantId: string): Promise<ScadaPackage | null> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) return null;
    // Upcast-on-read: legacy pre-Faz2 rows come back as V2 documents (no
    // validation throw on read — reads must never break on old data).
    const deviceCode = await this.resolveDeviceCode(
      (pkg.packageData?.meta as Record<string, unknown> | undefined)?.edgeDeviceId,
      tenantId,
    );
    pkg.packageData = upcastScadaPackageDoc(
      pkg.packageData,
      deviceCode ? { deviceCode } : undefined,
    );
    return this.sanitizePackageData(pkg);
  }

  async listScadaPackages(
    tenantId: string,
    filter?: ScadaPackageFilterInput,
    pagination?: ProcessPaginationInput,
  ): Promise<IStandardPaginatedResult<ScadaPackage>> {
    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, 100);
    const offset = (page - 1) * limit;

    const where: FindOptionsWhere<ScadaPackage> = { tenantId };
    if (filter?.status) where.status = filter.status;
    if (filter?.processId) where.processId = filter.processId;

    let whereConditions: FindOptionsWhere<ScadaPackage> | FindOptionsWhere<ScadaPackage>[];
    if (filter?.searchTerm) {
      const escapedTerm = filter.searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_');
      whereConditions = [
        { ...where, name: ILike(`%${escapedTerm}%`) },
      ];
    } else {
      whereConditions = where;
    }

    const [items, total] = await this.scadaPackageRepository.findAndCount({
      where: whereConditions,
      order: { updatedAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    const sanitizedItems = items.map((item) => this.sanitizePackageData(item));
    return createStandardPaginatedResult(sanitizedItems, total, page, limit);
  }

  async deleteScadaPackage(id: string, tenantId: string): Promise<boolean> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${id} not found`);
    pkg.status = ScadaPackageStatus.ARCHIVED;
    await this.scadaPackageRepository.save(pkg);
    return true;
  }

  async deployScadaPackageToEdge(
    packageId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id: packageId, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${packageId} not found`);

    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return { success: false, message: 'Device is offline — cannot deploy SCADA package' };
    }

    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }

    // Validate automation bindings before deploying (TASK 2)
    await this.validateAutomationBindings(pkg);

    // Tag SSoT raporu (Faz 1, warn-only): widget tag bağlamalarını
    // `${deviceCode}/${tagName}` olarak registry'ye karşı çöz; çözülemeyenleri
    // logla. Bloklamaz — Faz 4 bunu deploy gate'ine çevirir.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(pkg.packageData);
      if (tagNames.length > 0) {
        const refs = tagNames.map((name) => `${device.deviceCode}/${name}`);
        const resolution = await this.tagResolutionService.resolve(tenantId, refs);
        if (resolution.unresolved.length > 0) {
          this.logger.warn(
            `deploy_scada_package ${packageId}: ${resolution.unresolved.length}/${refs.length} widget tag binding registry'de çözülemedi: ${JSON.stringify(resolution.unresolved)}`,
          );
        }
      }
    }

    const commandId = randomUUID();

    // Content-addressed snapshot (Faz 3): the CANONICAL package content is
    // archived (volatile envelope fields like deployedAt stay out so
    // identical content dedupes to one artifact). Rollback = republish by
    // artifact id with a fresh envelope.
    let artifact = null;
    if (this.artifactService) {
      try {
        artifact = await this.artifactService.snapshot(tenantId, {
          artifactType: DeployArtifactType.SCADA_PACKAGE,
          content: pkg.packageData,
          schemaVersion:
            typeof (pkg.packageData.meta as Record<string, unknown> | undefined)?.schemaVersion === 'number'
              ? ((pkg.packageData.meta as Record<string, unknown>).schemaVersion as number)
              : undefined,
          sourceEntityId: pkg.id,
          sourceEntityVersion: pkg.version,
          createdBy: userId,
        });
      } catch (snapshotError) {
        this.logger.error(
          `Failed to snapshot SCADA package artifact: ${(snapshotError as Error).message}`,
        );
      }
    }

    const packagePayload = {
      ...pkg.packageData,
      meta: {
        ...((pkg.packageData.meta ?? {}) as Record<string, unknown>),
        // Server-side fields MUST come last to prevent client override
        version: pkg.version,
        packageVersion: `${pkg.version}.0.0`,
        deployedBy: userId || 'system',
        deployedAt: new Date().toISOString(),
        edgeDeviceId: device.id,
        ...(artifact ? { artifactSha256: artifact.contentSha256 } : {}),
      },
    };

    const topic = `tenants/${tenantId}/devices/${device.id}/commands`;
    // Server-controlled envelope — spread packagePayload into params only,
    // so client packageData cannot override commandId/command/timestamp
    const payload = {
      commandId,
      command: 'deploy_scada_package',
      params: packagePayload,
      timestamp: new Date().toISOString(),
    };

    // Create SCADA deploy log entry before sending MQTT (TASK 1)
    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          packageId: pkg.id,
          deviceId: device.id,
          commandId,
          version: pkg.version,
          deployedBy: userId,
          artifactId: artifact?.id,
          checksumSha256: artifact?.contentSha256,
        });
      } catch (logError) {
        this.logger.error(`Failed to create SCADA deploy log: ${(logError as Error).message}`);
        // Continue with deployment even if logging fails
      }
    }

    try {
      await this.mqttClient.publish(topic, payload);
      pkg.status = ScadaPackageStatus.PUBLISHED;
      await this.scadaPackageRepository.save(pkg);

      this.logger.log(
        `SCADA package "${pkg.name}" v${pkg.version} deployed to device ${device.deviceCode} (command: ${commandId})`,
      );
      return { success: true, message: 'SCADA package deployed successfully' };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to deploy SCADA package: ${msg}`);
      return { success: false, message: `Failed to deploy: ${msg}` };
    }
  }

  /**
   * REAL rollback (Faz 3): republish a previously-shipped artifact snapshot
   * verbatim. Unlike the edge's single previous-version slot, any retained
   * artifact can be restored, any number of times.
   */
  async rollbackScadaPackageDeploy(
    artifactId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.artifactService) {
      throw new BadRequestException('Artifact service not available');
    }
    const artifact = await this.artifactService.getById(tenantId, artifactId);
    if (artifact.artifactType !== DeployArtifactType.SCADA_PACKAGE) {
      throw new BadRequestException(
        `Artifact ${artifactId} is a ${artifact.artifactType}, not a SCADA package`,
      );
    }

    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return { success: false, message: 'Device is offline — cannot roll back' };
    }
    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }

    const commandId = randomUUID();
    const version = artifact.sourceEntityVersion ?? 0;
    const payload = {
      commandId,
      command: 'deploy_scada_package',
      params: {
        ...artifact.content,
        meta: {
          ...((artifact.content.meta ?? {}) as Record<string, unknown>),
          version,
          packageVersion: `${version}.0.0`,
          deployedBy: userId || 'system',
          deployedAt: new Date().toISOString(),
          edgeDeviceId: device.id,
          artifactSha256: artifact.contentSha256,
          rollback: true,
        },
      },
      timestamp: new Date().toISOString(),
    };

    if (this.scadaDeployLogService) {
      try {
        await this.scadaDeployLogService.createLog({
          tenantId,
          packageId: artifact.sourceEntityId,
          deviceId: device.id,
          commandId,
          version,
          deployedBy: userId,
          artifactId: artifact.id,
          checksumSha256: artifact.contentSha256,
          rolledBackTo: artifact.sourceEntityVersion,
        });
      } catch (logError) {
        this.logger.error(
          `Failed to create rollback deploy log: ${(logError as Error).message}`,
        );
      }
    }

    try {
      await this.mqttClient.publish(
        `tenants/${tenantId}/devices/${device.id}/commands`,
        payload,
      );
      this.logger.log(
        `Rolled back device ${device.deviceCode} to SCADA artifact ${artifact.id} (v${version}, command: ${commandId})`,
      );
      return { success: true, message: `Rollback to artifact v${version} sent` };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to publish rollback: ${msg}`);
      return { success: false, message: `Failed to roll back: ${msg}` };
    }
  }

  // ==========================================================================
  // Automation Binding Validation (TASK 2)
  // ==========================================================================

  /**
   * Validate automation bindings in a SCADA package's metadata.
   *
   * When a package has `meta.automationBindings`, each binding references
   * an automation program and its variables. This method validates:
   *   1. Each referenced programId exists in the database
   *   2. Each program is in APPROVED or DEPLOYED status
   *   3. Each referenced variableId exists for that program
   *   4. Each boundWidgetId references a widget present in the package screens
   */
  private async validateAutomationBindings(pkg: ScadaPackage): Promise<void> {
    const meta = pkg.packageData.meta as Record<string, unknown> | undefined;
    const bindings: AutomationBinding[] | undefined = meta?.automationBindings as AutomationBinding[] | undefined;

    if (!bindings || !Array.isArray(bindings) || bindings.length === 0) {
      return; // No automation bindings — nothing to validate
    }

    if (!this.automationProgramRepo || !this.programVariableRepo) {
      this.logger.warn(
        'Automation repositories not available — skipping automation binding validation',
      );
      return;
    }

    const errors: string[] = [];

    // 1. Collect all unique programIds and variableIds from bindings
    const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const programIds = [...new Set(bindings.map((b) => b.programId).filter(isString))];
    const variableIds = [...new Set(bindings.map((b) => b.variableId).filter(isString))];
    const widgetIds = [...new Set(bindings.map((b) => b.boundWidgetId).filter(isString))];

    // 2. Validate programs exist and are in deployable status
    if (programIds.length > 0) {
      const programs = await this.automationProgramRepo.find({
        where: { id: In(programIds), tenantId: pkg.tenantId },
      });

      const foundIds = new Set(programs.map((p) => p.id));
      for (const pid of programIds) {
        if (!foundIds.has(pid)) {
          errors.push(`Automation program ${pid} not found`);
        }
      }

      for (const program of programs) {
        if (
          program.status !== ProgramStatus.APPROVED &&
          program.status !== ProgramStatus.DEPLOYED
        ) {
          errors.push(
            `Program "${program.programName}" (${program.id}) is in ${program.status} status; must be APPROVED or DEPLOYED`,
          );
        }
      }
    }

    // 3. Validate variables exist and belong to their referenced programs
    if (variableIds.length > 0) {
      const variables = await this.programVariableRepo.find({
        where: { id: In(variableIds) },
      });

      const foundVarIds = new Set(variables.map((v) => v.id));
      const varProgramMap = new Map(variables.map((v) => [v.id, v.programId]));

      for (const binding of bindings) {
        if (binding.variableId && !foundVarIds.has(binding.variableId)) {
          errors.push(`Variable ${binding.variableId} not found`);
        } else if (binding.variableId && binding.programId) {
          const actualProgramId = varProgramMap.get(binding.variableId);
          if (actualProgramId && actualProgramId !== binding.programId) {
            errors.push(
              `Variable ${binding.variableId} belongs to program ${actualProgramId}, not ${binding.programId}`,
            );
          }
        }
      }
    }

    // 4. Validate widget IDs exist in the package screens
    if (widgetIds.length > 0) {
      const packageWidgetIds = this.extractWidgetIds(pkg.packageData);
      for (const wid of widgetIds) {
        if (!packageWidgetIds.has(wid)) {
          errors.push(`Widget "${wid}" not found in package screens`);
        }
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(
        `Automation binding validation failed:\n- ${errors.join('\n- ')}`,
      );
    }
  }

  /**
   * Recursively extract all widget IDs from the SCADA package data.
   * Looks for `id` fields inside `screens[].widgets[]` and nested children.
   */
  private extractWidgetIds(packageData: Record<string, unknown>): Set<string> {
    const ids = new Set<string>();
    const screens = packageData.screens;
    if (!Array.isArray(screens)) return ids;

    const collectIds = (widgets: unknown[]): void => {
      for (const widget of widgets) {
        if (widget && typeof widget === 'object') {
          const w = widget as Record<string, unknown>;
          if (typeof w.id === 'string') {
            ids.add(w.id);
          }
          // Recurse into children
          if (Array.isArray(w.children)) {
            collectIds(w.children);
          }
          if (Array.isArray(w.widgets)) {
            collectIds(w.widgets);
          }
        }
      }
    };

    for (const screen of screens) {
      if (screen && typeof screen === 'object') {
        const s = screen as Record<string, unknown>;
        if (Array.isArray(s.widgets)) {
          collectIds(s.widgets);
        }
      }
    }

    return ids;
  }

  // ==========================================================================
  // Unified Deploy: SCADA + Automation (TASK 3)
  // ==========================================================================

  /**
   * Deploy a SCADA package together with its bound automation programs.
   *
   * Order of operations:
   *   1. Validate the SCADA package and its automation bindings
   *   2. Deploy each referenced automation program (must be running before SCADA reads variables)
   *   3. Deploy the SCADA package
   *
   * If any automation deployment fails, the SCADA package is NOT deployed.
   */
  async deployScadaWithAutomation(
    packageId: string,
    deviceId: string,
    tenantId: string,
    userId?: string,
    programIdOverrides?: string[],
  ): Promise<UnifiedDeployResult> {
    const pkg = await this.scadaPackageRepository.findOne({ where: { id: packageId, tenantId } });
    if (!pkg) throw new NotFoundException(`ScadaPackage ${packageId} not found`);

    // Determine which programs to deploy
    const meta = pkg.packageData.meta as Record<string, unknown> | undefined;
    const bindings: AutomationBinding[] | undefined = meta?.automationBindings as AutomationBinding[] | undefined;
    const programIds = programIdOverrides && programIdOverrides.length > 0
      ? programIdOverrides
      : [...new Set((bindings || []).map((b) => b.programId).filter(Boolean))];

    const automationResults: AutomationDeployStepResult[] = [];

    // Step 1: Deploy automation programs (if any)
    if (programIds.length > 0) {
      if (!this.automationService) {
        throw new BadRequestException(
          'AutomationService not available — cannot deploy automation programs',
        );
      }

      for (const programId of programIds) {
        try {
          const result = await this.automationService.deployProgram(
            programId,
            deviceId,
            tenantId,
            userId || 'system',
          );
          automationResults.push({
            programId,
            success: result.success,
            message: result.message,
            commandId: result.commandId,
          });

          if (!result.success) {
            // Abort: if an automation program fails to deploy, do not deploy SCADA
            return {
              success: false,
              message: `Automation program ${programId} deployment failed: ${result.message}. SCADA deployment aborted.`,
              automationResults,
            };
          }
        } catch (error) {
          const errMsg = (error as Error).message;
          automationResults.push({
            programId,
            success: false,
            message: errMsg,
          });
          return {
            success: false,
            message: `Automation program ${programId} deployment error: ${errMsg}. SCADA deployment aborted.`,
            automationResults,
          };
        }
      }
    }

    // Step 2: Deploy SCADA package (validation happens inside deployScadaPackageToEdge)
    try {
      const scadaResult = await this.deployScadaPackageToEdge(packageId, deviceId, tenantId, userId);
      return {
        success: scadaResult.success,
        message: scadaResult.success
          ? `Deployed ${programIds.length} automation program(s) and SCADA package successfully`
          : scadaResult.message,
        automationResults,
        scadaResult: {
          packageId,
          success: scadaResult.success,
          message: scadaResult.message,
        },
      };
    } catch (error) {
      const errMsg = (error as Error).message;
      return {
        success: false,
        message: `SCADA deployment failed: ${errMsg}`,
        automationResults,
        scadaResult: {
          packageId,
          success: false,
          message: errMsg,
        },
      };
    }
  }
}

// ==========================================================================
// Interfaces
// ==========================================================================

/** Shape of a single automation binding in packageData.meta.automationBindings */
interface AutomationBinding {
  programId: string;
  variableId?: string;
  boundWidgetId?: string;
}

/** Result for a single automation program deployment step */
export interface AutomationDeployStepResult {
  programId: string;
  success: boolean;
  message?: string;
  commandId?: string;
}

/** Combined result for unified SCADA + Automation deployment */
export interface UnifiedDeployResult {
  success: boolean;
  message: string;
  automationResults: AutomationDeployStepResult[];
  scadaResult?: {
    packageId: string;
    success: boolean;
    message?: string;
  };
}
