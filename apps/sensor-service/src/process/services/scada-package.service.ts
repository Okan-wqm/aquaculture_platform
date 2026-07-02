import { createHash, randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { upcastScadaPackageDoc } from '@platform/sensor-contracts';
import {
  formatValidationErrors,
  validateCommandEnvelope,
  validateDeployScadaPackageParams,
  validateScadaPackageDocV2,
} from '@platform/sensor-contracts/validators';

import { AutomationService } from '../../automation/automation.service';
import { AutomationProgram, ProgramStatus } from '../../automation/entities/automation-program.entity';
import { ProgramVariable } from '../../automation/entities/program-variable.entity';
import { ArtifactService, canonicalJsonStringify } from '../../deploy-artifact/artifact.service';
import { DeploySigningService } from '../../deploy-artifact/deploy-signing.service';
import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';
import { EdgeDeviceService } from '../../edge-device/edge-device.service';
import {
  ReleaseBundleArtifactRef,
  ReleaseBundleManifest,
} from '../../release-bundle/entities/release-bundle.entity';
import { ReleaseBundleService } from '../../release-bundle/release-bundle.service';
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
    @Optional()
    @Inject(DeploySigningService)
    private readonly deploySigningService: DeploySigningService | null,
    @Optional()
    @Inject(ReleaseBundleService)
    private readonly releaseBundleService: ReleaseBundleService | null,
    @Optional()
    @Inject(OutboxPublisher)
    private readonly outboxPublisher: OutboxPublisher | null,
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

  /**
   * Flip a package to PUBLISHED — called by the bundle-ack path when the
   * edge CONFIRMS the atomic apply (Faz 5). The single-command deploy
   * path still flips on publish; the bundle path only flips on device
   * confirmation, so PUBLISHED means "running on the device", not
   * "left the broker".
   */
  async markPackagePublished(packageId: string, tenantId: string): Promise<void> {
    const pkg = await this.scadaPackageRepository.findOne({
      where: { id: packageId, tenantId },
    });
    if (!pkg) {
      this.logger.warn(`Cannot mark package ${packageId} PUBLISHED — not found`);
      return;
    }
    pkg.status = ScadaPackageStatus.PUBLISHED;
    await this.scadaPackageRepository.save(pkg);
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

    // Deploy always ships the CURRENT document contract: legacy rows that
    // were saved before Faz 2 upcast here (deploy reads the repo directly,
    // bypassing getScadaPackage's read-path upcast).
    const packageDoc = upcastScadaPackageDoc(pkg.packageData, {
      deviceCode: device.deviceCode,
    });

    // Tag SSoT raporu (Faz 1, warn-only): widget tag bağlamalarını
    // `${deviceCode}/${tagName}` olarak registry'ye karşı çöz; çözülemeyenleri
    // logla. Bloklamaz — Faz 4 bunu deploy gate'ine çevirir.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(packageDoc);
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
          content: packageDoc,
          schemaVersion: packageDoc.meta.schemaVersion,
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

    // Faz 4: ed25519 signature over tenant + artifact sha256 under domain
    // tag `scada-pkg-v1` — verified by the edge against
    // firmware_signing_pubkey before applying the package.
    const signature =
      artifact && this.deploySigningService
        ? this.deploySigningService.signDeployArtifact(
            'scada-package',
            tenantId,
            artifact.contentSha256,
          )
        : null;

    const packagePayload = {
      ...packageDoc,
      meta: {
        ...packageDoc.meta,
        // Server-side fields MUST come last to prevent client override
        version: pkg.version,
        packageVersion: `${pkg.version}.0.0`,
        deployedBy: userId || 'system',
        deployedAt: new Date().toISOString(),
        edgeDeviceId: device.id,
        ...(artifact ? { artifactSha256: artifact.contentSha256 } : {}),
        ...(signature ? { signature } : {}),
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

    // Publish-boundary contract validation (Faz 4): the shipped payload must
    // match the canonical schemas the Rust agent is parity-tested against.
    if (!validateDeployScadaPackageParams(packagePayload)) {
      throw new BadRequestException(
        `deploy_scada_package payload violates the canonical contract: ${formatValidationErrors(validateDeployScadaPackageParams)}`,
      );
    }
    if (!validateCommandEnvelope(payload)) {
      throw new BadRequestException(
        `Command envelope violates the canonical contract: ${formatValidationErrors(validateCommandEnvelope)}`,
      );
    }

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
    // Rollback republishes signed content: same artifact sha256, same
    // domain tag — the edge cannot distinguish (nor needs to) a rollback
    // from a fresh deploy at the signature layer.
    const signature = this.deploySigningService
      ? this.deploySigningService.signDeployArtifact(
          'scada-package',
          tenantId,
          artifact.contentSha256,
        )
      : null;
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
          ...(signature ? { signature } : {}),
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
  // Unified Deploy: SCADA + Automation — release-bundle builder (Faz 5)
  // ==========================================================================

  /**
   * Deploy a SCADA package together with its bound automation programs as
   * ONE two-phase release bundle (enterprise plan Faz 5).
   *
   * The pre-Faz-5 shape published N+1 independent fire-and-forget commands
   * (programs first, then the package) — a crash or broker outage between
   * them left the device half-deployed with no record of it. Now:
   *
   *   1. Each program + the package is snapshotted as a content-addressed
   *      artifact and staged into a signed manifest.
   *   2. The `release_bundles` PENDING row and the `DeployBundleRequested`
   *      outbox event commit in ONE transaction — a crash cannot lose the
   *      dispatch, and the dispatch cannot precede the commit.
   *   3. The edge verifies the manifest signature + every artifact
   *      checksum, then applies everything atomically under its deploy
   *      lock and acks staged → confirmed (or failed with nothing applied).
   *
   * Bundles are ALWAYS signed — the builder refuses to run without the
   * signing key rather than shipping an unsigned bundle.
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

    // Determine which programs ride the bundle
    const meta = pkg.packageData.meta as Record<string, unknown> | undefined;
    const bindings: AutomationBinding[] | undefined = meta?.automationBindings as AutomationBinding[] | undefined;
    const programIds = programIdOverrides && programIdOverrides.length > 0
      ? programIdOverrides
      : [...new Set((bindings || []).map((b) => b.programId).filter(Boolean))];

    // Bundle pipeline preconditions — fail loudly with the exact remedy.
    if (!this.edgeDeviceService) {
      throw new BadRequestException('Edge device service not available');
    }
    if (!this.artifactService) {
      throw new BadRequestException(
        'Artifact service not available — bundle deploys require the content-addressed store',
      );
    }
    const releaseBundleService = this.releaseBundleService;
    const outboxPublisher = this.outboxPublisher;
    if (!releaseBundleService || !outboxPublisher) {
      throw new BadRequestException(
        'Release-bundle pipeline not available (ReleaseBundleModule / outbox not wired)',
      );
    }
    const deploySigningService = this.deploySigningService;
    if (!deploySigningService?.isConfigured) {
      throw new BadRequestException(
        'Bundle deploys require deploy signing — set SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX (unsigned bundles do not exist)',
      );
    }
    const automationService = this.automationService;
    if (programIds.length > 0 && !automationService) {
      throw new BadRequestException(
        'AutomationService not available — cannot bundle automation programs',
      );
    }

    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);
    if (!device.isOnline) {
      return {
        success: false,
        message: 'Device is offline — cannot deploy release bundle',
        automationResults: [],
      };
    }

    const automationResults: AutomationDeployStepResult[] = [];
    const artifactRefs: ReleaseBundleArtifactRef[] = [];

    // Step 1: stage automation programs into the bundle (programs lead so
    // they are running before SCADA reads their variables — same ordering
    // contract as before, now enforced by manifest order + edge apply).
    for (const programId of programIds) {
      if (!automationService) break;
      try {
        const prep = await automationService.prepareProgramBundleArtifact(
          programId,
          deviceId,
          tenantId,
          userId || 'system',
        );
        artifactRefs.push({
          artifactId: prep.artifactId,
          kind: DeployArtifactType.AUTOMATION_PROGRAM,
          sha256: prep.sha256,
          sourceEntityId: programId,
          logCommandId: prep.logCommandId,
          version: prep.version,
        });
        automationResults.push({
          programId,
          success: true,
          message: 'Staged into release bundle',
          commandId: prep.logCommandId,
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        automationResults.push({ programId, success: false, message: errMsg });
        return {
          success: false,
          message: `Automation program ${programId} staging failed: ${errMsg}. Bundle aborted — nothing published.`,
          automationResults,
        };
      }
    }

    // Step 2: stage the SCADA package artifact
    let packageRef: ReleaseBundleArtifactRef;
    try {
      packageRef = await this.prepareScadaPackageBundleArtifact(pkg, device, tenantId, userId);
      artifactRefs.push(packageRef);
    } catch (error) {
      const errMsg = (error as Error).message;
      return {
        success: false,
        message: `SCADA package staging failed: ${errMsg}. Bundle aborted — nothing published.`,
        automationResults,
        scadaResult: { packageId, success: false, message: errMsg },
      };
    }

    // Step 3: signed manifest + transactional PENDING row + outbox event
    const bundleId = randomUUID();
    const commandId = randomUUID();
    const previous = await releaseBundleService.findLastConfirmed(tenantId, device.id);
    const manifest: ReleaseBundleManifest = { bundleId, artifacts: artifactRefs };
    const manifestSha256 = createHash('sha256')
      .update(canonicalJsonStringify(manifest))
      .digest('hex');
    const signature = deploySigningService.signDeployArtifact(
      'bundle',
      tenantId,
      manifestSha256,
    );
    if (!signature) {
      throw new BadRequestException(
        'Deploy signing became unavailable while building the bundle',
      );
    }

    await this.scadaPackageRepository.manager.transaction(async (manager) => {
      await releaseBundleService.createPending(
        tenantId,
        {
          bundleId,
          deviceId: device.id,
          commandId,
          manifest,
          manifestSha256,
          signature,
          previousBundleId: previous?.id,
          createdBy: userId,
        },
        manager,
      );
      await outboxPublisher.enqueue(
        {
          ...createBaseEvent('DeployBundleRequested', tenantId),
          bundleId,
          deviceId: device.id,
          commandId,
        },
        manager,
        { aggregateId: bundleId },
      );
    });

    this.logger.log(
      `Release bundle ${bundleId} committed for device ${device.deviceCode} ` +
        `(${artifactRefs.length} artifact(s), command ${commandId}) — outbox will dispatch`,
    );

    return {
      success: true,
      message:
        `Release bundle ${bundleId} queued for ${device.deviceCode}: ` +
        `${programIds.length} program(s) + SCADA package. ` +
        'The edge acks staged → confirmed; package status flips to PUBLISHED on confirmation.',
      automationResults,
      scadaResult: {
        packageId,
        success: true,
        message: `Staged into release bundle (artifact ${packageRef.artifactId})`,
      },
    };
  }

  /**
   * Snapshot + validate + log the SCADA package for a bundle — everything
   * `deployScadaPackageToEdge` does EXCEPT the MQTT publish and the
   * premature PUBLISHED flip (the package becomes PUBLISHED only when the
   * edge CONFIRMS the bundle).
   */
  private async prepareScadaPackageBundleArtifact(
    pkg: ScadaPackage,
    device: { id: string; deviceCode: string },
    tenantId: string,
    userId?: string,
  ): Promise<ReleaseBundleArtifactRef> {
    if (!this.artifactService) {
      throw new BadRequestException(
        'Artifact service not available — bundle deploys require the content-addressed store',
      );
    }

    await this.validateAutomationBindings(pkg);

    const packageDoc = upcastScadaPackageDoc(pkg.packageData, {
      deviceCode: device.deviceCode,
    });
    if (!validateScadaPackageDocV2(packageDoc)) {
      throw new BadRequestException(
        `packageData failed ScadaPackageDocV2 validation: ${formatValidationErrors(validateScadaPackageDocV2)}`,
      );
    }

    // Tag SSoT warn report — same coverage as the single-command path.
    if (this.tagResolutionService) {
      const tagNames = this.collectWidgetTagNames(packageDoc);
      if (tagNames.length > 0) {
        const refs = tagNames.map((name) => `${device.deviceCode}/${name}`);
        const resolution = await this.tagResolutionService.resolve(tenantId, refs);
        if (resolution.unresolved.length > 0) {
          this.logger.warn(
            `bundle package ${pkg.id}: ${resolution.unresolved.length}/${refs.length} widget tag binding registry'de çözülemedi: ${JSON.stringify(resolution.unresolved)}`,
          );
        }
      }
    }

    const artifact = await this.artifactService.snapshot(tenantId, {
      artifactType: DeployArtifactType.SCADA_PACKAGE,
      content: packageDoc,
      schemaVersion: packageDoc.meta.schemaVersion,
      sourceEntityId: pkg.id,
      sourceEntityVersion: pkg.version,
      createdBy: userId,
    });

    const logCommandId = randomUUID();
    if (this.scadaDeployLogService) {
      await this.scadaDeployLogService.createLog({
        tenantId,
        packageId: pkg.id,
        deviceId: device.id,
        commandId: logCommandId,
        version: pkg.version,
        deployedBy: userId,
        artifactId: artifact.id,
        checksumSha256: artifact.contentSha256,
      });
    }

    return {
      artifactId: artifact.id,
      kind: DeployArtifactType.SCADA_PACKAGE,
      sha256: artifact.contentSha256,
      sourceEntityId: pkg.id,
      logCommandId,
      version: pkg.version,
    };
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
