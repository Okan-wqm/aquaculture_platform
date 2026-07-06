import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { DeploymentLog, DeploymentStatus } from '../entities/deployment-log.entity';

/**
 * DeploymentLog Service
 * Tracks program deployments to edge devices
 */
@Injectable()
export class DeploymentLogService {
  private readonly logger = new Logger(DeploymentLogService.name);

  constructor(
    @InjectRepository(DeploymentLog)
    private readonly deploymentLogRepo: Repository<DeploymentLog>,
  ) {}

  /**
   * Create a new deployment log entry
   * Called before sending MQTT deploy command
   */
  async createLog(params: {
    tenantId: string;
    programId: string;
    deviceId: string;
    commandId: string;
    version: number;
    edgeScript?: Record<string, unknown>;
    deployedBy?: string;
    artifactId?: string;
    checksumSha256?: string;
  }): Promise<DeploymentLog> {
    const log = this.deploymentLogRepo.create({
      tenantId: params.tenantId,
      programId: params.programId,
      deviceId: params.deviceId,
      commandId: params.commandId,
      version: params.version,
      status: DeploymentStatus.PENDING,
      edgeScript: params.edgeScript,
      deployedBy: params.deployedBy,
      artifactId: params.artifactId,
      checksumSha256: params.checksumSha256,
      deployedAt: new Date(),
    });

    const saved = await this.deploymentLogRepo.save(log);
    this.logger.log(
      `Created deployment log ${saved.id} for program ${params.programId} -> device ${params.deviceId}`,
    );
    return saved;
  }

  /**
   * Update deployment status to DEPLOYING
   * Called when MQTT message is sent
   */
  async markDeploying(commandId: string): Promise<void> {
    await this.deploymentLogRepo.update(
      { commandId },
      { status: DeploymentStatus.DEPLOYING },
    );
  }

  /**
   * Handle deployment response from edge device
   * Called when MQTT response arrives
   */
  async handleResponse(
    commandId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    const log = await this.deploymentLogRepo.findOne({
      where: { commandId },
    });

    if (!log) {
      this.logger.warn(`Deployment log not found for command ${commandId}`);
      return;
    }

    log.status = success ? DeploymentStatus.SUCCESS : DeploymentStatus.FAILED;
    log.completedAt = new Date();
    log.edgeAckAt = new Date();
    if (errorMessage) {
      log.errorMessage = errorMessage;
    }

    await this.deploymentLogRepo.save(log);
    this.logger.log(
      `Deployment ${log.id} ${success ? 'succeeded' : 'failed'} for command ${commandId}`,
    );
  }

  /**
   * Find a deployment log by ID with tenant isolation
   */
  async findById(id: string, tenantId: string): Promise<DeploymentLog | null> {
    return this.deploymentLogRepo.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Get deployment history for a device
   */
  async getHistory(
    tenantId: string,
    deviceId?: string,
    page = 1,
    limit = 20,
  ): Promise<IStandardPaginatedResult<DeploymentLog>> {
    const where: Record<string, unknown> = { tenantId };
    if (deviceId) where['deviceId'] = deviceId;

    const [items, total] = await this.deploymentLogRepo.findAndCount({
      where,
      order: { deployedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Find the latest deployment log for a program/device combination.
   * Used by rollback four-eyes check to identify the original deployer.
   *
   * @param programId - The program that was deployed
   * @param deviceId  - The target device
   * @param tenantId  - Tenant scope for security isolation
   * @returns The most recent deployment log, or null if none found
   */
  async findLatestForProgram(
    programId: string,
    deviceId: string,
    tenantId: string,
  ): Promise<DeploymentLog | null> {
    return this.deploymentLogRepo.findOne({
      where: { programId, deviceId, tenantId },
      order: { deployedAt: 'DESC' },
    });
  }

  /**
   * Mark a deployment as rolled back
   */
  async markRolledBack(commandId: string): Promise<void> {
    await this.deploymentLogRepo.update(
      { commandId },
      {
        status: DeploymentStatus.ROLLED_BACK,
        completedAt: new Date(),
      },
    );
  }
}
