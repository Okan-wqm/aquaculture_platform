import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ScadaDeployLog, ScadaDeployStatus } from '../entities/scada-deploy-log.entity';

export interface ScadaDeployLogListResult {
  items: ScadaDeployLog[];
  total: number;
}

@Injectable()
export class ScadaDeployLogService {
  private readonly logger = new Logger(ScadaDeployLogService.name);

  constructor(
    @InjectRepository(ScadaDeployLog)
    private readonly deployLogRepo: Repository<ScadaDeployLog>,
  ) {}

  /**
   * Create a new SCADA deploy log entry.
   * Called before sending MQTT deploy command.
   */
  async createLog(params: {
    tenantId: string;
    packageId: string;
    deviceId: string;
    commandId: string;
    version: number;
    deployedBy?: string;
  }): Promise<ScadaDeployLog> {
    const log = this.deployLogRepo.create({
      tenantId: params.tenantId,
      packageId: params.packageId,
      deviceId: params.deviceId,
      commandId: params.commandId,
      version: params.version,
      status: ScadaDeployStatus.SENT,
      sentAt: new Date(),
      deployedBy: params.deployedBy,
    });

    const saved = await this.deployLogRepo.save(log);
    this.logger.log(
      `Created SCADA deploy log ${saved.id} for package ${params.packageId} -> device ${params.deviceId}`,
    );
    return saved;
  }

  /** @internal MQTT handler only - no tenant context available */
  async updateStatus(
    commandId: string,
    status: ScadaDeployStatus,
    data?: {
      errorMessage?: string;
      healthCheckResults?: Record<string, unknown>;
      rolledBackTo?: number;
    },
  ): Promise<ScadaDeployLog | null> {
    const log = await this.deployLogRepo.findOne({ where: { commandId } });
    if (!log) {
      this.logger.warn(`SCADA deploy log not found for command ${commandId}`);
      return null;
    }

    log.status = status;

    // Set timestamps based on status progression
    const now = new Date();
    switch (status) {
      case ScadaDeployStatus.RECEIVED:
        log.receivedAt = now;
        break;
      case ScadaDeployStatus.DEPLOYING:
        log.receivedAt = log.receivedAt ?? now;
        break;
      case ScadaDeployStatus.VERIFYING:
        log.deployedAt = now;
        break;
      case ScadaDeployStatus.SUCCESS:
        log.verifiedAt = now;
        log.deployedAt = log.deployedAt ?? now;
        break;
      case ScadaDeployStatus.FAILED:
        log.deployedAt = log.deployedAt ?? now;
        break;
      case ScadaDeployStatus.ROLLED_BACK:
        break;
    }

    if (data?.errorMessage) log.errorMessage = data.errorMessage;
    if (data?.healthCheckResults) log.healthCheckResults = data.healthCheckResults;
    if (data?.rolledBackTo != null) log.rolledBackTo = data.rolledBackTo;

    const saved = await this.deployLogRepo.save(log);
    this.logger.log(
      `SCADA deploy log ${log.id} status updated to ${status} (command: ${commandId})`,
    );
    return saved;
  }

  /**
   * Get deploy logs by device with pagination.
   */
  async getByDevice(
    deviceId: string,
    tenantId: string,
    page = 1,
    limit = 20,
  ): Promise<ScadaDeployLogListResult> {
    const safeLimit = Math.min(limit, 100);
    const [items, total] = await this.deployLogRepo.findAndCount({
      where: { deviceId, tenantId },
      order: { sentAt: 'DESC' },
      skip: (page - 1) * safeLimit,
      take: safeLimit,
    });
    return { items, total };
  }

  /**
   * Get deploy logs by package.
   */
  async getByPackage(
    packageId: string,
    tenantId: string,
  ): Promise<ScadaDeployLog[]> {
    return this.deployLogRepo.find({
      where: { packageId, tenantId },
      order: { sentAt: 'DESC' },
    });
  }

  /**
   * Get the latest deploy log for a device.
   */
  async getLatestByDevice(
    deviceId: string,
    tenantId: string,
  ): Promise<ScadaDeployLog | null> {
    return this.deployLogRepo.findOne({
      where: { deviceId, tenantId },
      order: { sentAt: 'DESC' },
    });
  }

  /**
   * Find deploy log by commandId (tenant-scoped).
   */
  async findByCommandId(commandId: string, tenantId: string): Promise<ScadaDeployLog | null> {
    return this.deployLogRepo.findOne({ where: { commandId, tenantId } });
  }
}
