import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DeviceEvent, DeviceEventType, DeviceEventSeverity } from './entities/device-event.entity';

/**
 * Device Event Service
 * Handles logging and querying of device lifecycle events.
 */
@Injectable()
export class DeviceEventService {
  private readonly logger = new Logger(DeviceEventService.name);

  constructor(
    @InjectRepository(DeviceEvent)
    private readonly deviceEventRepository: Repository<DeviceEvent>,
  ) {}

  /**
   * Log a device event
   */
  async logDeviceEvent(
    tenantId: string,
    deviceId: string | undefined,
    eventType: DeviceEventType,
    severity: DeviceEventSeverity,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeviceEvent> {
    const event = this.deviceEventRepository.create({
      tenantId,
      deviceId,
      eventType,
      severity,
      message,
      metadata,
    });
    return this.deviceEventRepository.save(event);
  }

  /**
   * Get device events with pagination
   */
  async getDeviceEvents(
    tenantId: string,
    deviceId?: string,
    eventType?: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: DeviceEvent[]; total: number; page: number; limit: number }> {
    const where: Record<string, unknown> = { tenantId };
    if (deviceId) where.deviceId = deviceId;
    if (eventType) where.eventType = eventType;

    const [items, total] = await this.deviceEventRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total, page, limit };
  }
}
