import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { EdgeDeviceService } from './edge-device.service';

/**
 * SEC-M18: Strict validation regex for tenant IDs used in database queries.
 * Only lowercase UUID v4 format is accepted to prevent injection.
 */
const TENANT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * SEC-M18: Strict validation regex for device codes.
 * Only alphanumeric characters, hyphens, and underscores are accepted (max 128 chars).
 */
const DEVICE_CODE_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Payload for device ownership verification NATS request.
 */
interface VerifyDeviceOwnershipPayload {
  deviceCode: string;
  tenantId: string;
}

/**
 * Response for device ownership verification.
 */
interface VerifyDeviceOwnershipResponse {
  owned: boolean;
}

/**
 * NATS message handler for edge device cross-service queries.
 *
 * SEC-M18: Provides a request-reply endpoint that allows the gateway-api
 * to verify that a specific edge device belongs to a given tenant before
 * subscribing WebSocket clients to its data stream. This prevents
 * unauthorized cross-tenant device data access via device code enumeration.
 */
@Controller()
export class EdgeDeviceNatsController {
  private readonly logger = new Logger(EdgeDeviceNatsController.name);

  constructor(
    private readonly edgeDeviceService: EdgeDeviceService,
  ) {}

  /**
   * Verify that a device with the given code belongs to the specified tenant.
   *
   * Called by gateway-api before subscribing a WebSocket client to an
   * edge device I/O data stream. Returns `{ owned: true }` only if the
   * device exists in the database AND its tenantId matches the request.
   *
   * @param data - The verification payload containing deviceCode and tenantId
   * @returns Ownership verification result
   */
  @MessagePattern('request.sensor.verifyDeviceOwnership')
  async verifyDeviceOwnership(
    @Payload() data: VerifyDeviceOwnershipPayload,
  ): Promise<VerifyDeviceOwnershipResponse> {
    // SEC-M18: Validate tenantId format to prevent SQL injection via crafted NATS payloads
    if (!data.tenantId || !TENANT_ID_REGEX.test(data.tenantId)) {
      this.logger.warn(
        `SEC-M18: Invalid tenantId format in device ownership verification: ${String(data.tenantId).substring(0, 50)}`,
      );
      return { owned: false };
    }

    // SEC-M18: Validate deviceCode format
    if (!data.deviceCode || !DEVICE_CODE_REGEX.test(data.deviceCode)) {
      this.logger.warn(
        `SEC-M18: Invalid deviceCode format in ownership verification: ${String(data.deviceCode).substring(0, 50)}`,
      );
      return { owned: false };
    }

    try {
      const device = await this.edgeDeviceService.findByCode(
        data.deviceCode,
        data.tenantId,
      );
      const owned = device !== null;

      if (!owned) {
        this.logger.debug(
          `SEC-M18: Device ownership denied — deviceCode=${data.deviceCode} tenantId=${data.tenantId}`,
        );
      }

      return { owned };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SEC-M18: Device ownership verification failed: ${message}`,
      );
      // Safe default: deny access when the database is unreachable
      return { owned: false };
    }
  }
}
