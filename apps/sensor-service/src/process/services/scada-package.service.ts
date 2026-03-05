import { randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike } from 'typeorm';

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

export interface ScadaPackageListResult {
  items: ScadaPackage[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

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
  ) {}

  async createScadaPackage(
    input: CreateScadaPackageInput,
    tenantId: string,
    userId?: string,
  ): Promise<ScadaPackage> {
    this.logger.log(`Creating SCADA package "${input.name}" for tenant ${tenantId}`);

    this.validatePackageDataSize(input.packageData);

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
    }

    if (input.name !== undefined) pkg.name = input.name;
    if (input.description !== undefined) pkg.description = input.description;
    if (input.processId !== undefined) pkg.processId = input.processId;
    if (input.packageData !== undefined) pkg.packageData = input.packageData;

    pkg.version = pkg.version + 1;
    pkg.updatedBy = userId;

    return this.scadaPackageRepository.save(pkg);
  }

  async getScadaPackage(id: string, tenantId: string): Promise<ScadaPackage | null> {
    return this.scadaPackageRepository.findOne({ where: { id, tenantId } });
  }

  async listScadaPackages(
    tenantId: string,
    filter?: ScadaPackageFilterInput,
    pagination?: ProcessPaginationInput,
  ): Promise<ScadaPackageListResult> {
    const offset = pagination?.offset || 0;
    const limit = Math.min(pagination?.limit || 20, 100);

    const where: FindOptionsWhere<ScadaPackage> = { tenantId };
    if (filter?.status) where.status = filter.status;
    if (filter?.processId) where.processId = filter.processId;

    let whereConditions: FindOptionsWhere<ScadaPackage> | FindOptionsWhere<ScadaPackage>[];
    if (filter?.searchTerm) {
      whereConditions = [
        { ...where, name: ILike(`%${filter.searchTerm}%`) },
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

    return { items, total, offset, limit, hasMore: offset + items.length < total };
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

    const packagePayload = {
      ...pkg.packageData,
      meta: {
        ...(pkg.packageData as any)?.meta,
        // Server-side fields MUST come last to prevent client override
        version: pkg.version,
        packageVersion: `${pkg.version}.0.0`,
        deployedBy: userId || 'system',
        deployedAt: new Date().toISOString(),
        edgeDeviceId: device.id,
      },
    };

    const topic = `tenants/${tenantId}/devices/${device.id}/commands`;
    // Server-controlled envelope — spread packagePayload into params only,
    // so client packageData cannot override commandId/command/timestamp
    const payload = {
      commandId: randomUUID(),
      command: 'deploy_scada_package',
      params: packagePayload,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.mqttClient.publish(topic, payload);
      pkg.status = ScadaPackageStatus.PUBLISHED;
      await this.scadaPackageRepository.save(pkg);

      this.logger.log(
        `SCADA package "${pkg.name}" v${pkg.version} deployed to device ${device.deviceCode}`,
      );
      return { success: true, message: 'SCADA package deployed successfully' };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error(`Failed to deploy SCADA package: ${msg}`);
      return { success: false, message: `Failed to deploy: ${msg}` };
    }
  }
}
