/**
 * Sensor Service REST Routes
 *
 * Note: Primary sensor operations use GraphQL through Apollo Federation Gateway.
 * These REST routes are for specific endpoints that don't fit GraphQL patterns
 * (e.g., file uploads, streaming data, WebSocket connections).
 */

import {
  Module,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import {
  buildGatewayVerifiedUserAssertion,
  requireCanonicalGatewayAssertionRoles,
  signedFetch,
} from '@aquaculture/backend-common/http';
import type {
  ImpersonationOperationDescriptor,
  ImpersonationPermissionsContract,
} from '@aquaculture/shared-contracts';

import type { AuthenticatedUser, ImpersonationOperationAuthorizer } from '../../types';
import {
  enforceImpersonationOperations,
  resolveRestImpersonationOperation,
} from '../../security/impersonation-operation-authority';
import {
  assertImpersonationReceiptLedgerCommitted,
  assertImpersonationReceiptLedgerReconciled,
  expectImpersonationOperationDispatch,
  markImpersonationOperationDispatched,
} from '../../security/impersonation-receipt-completion';
import {
  GATEWAY_SENSOR_CONTROLLER_PATH,
  GATEWAY_SENSOR_EXPORT_HANDLER_PATH,
  GATEWAY_SENSOR_MQTT_HANDLER_PATH,
  SENSOR_EXPORT_OUTWARD_TEMPLATE,
  SENSOR_MQTT_OUTWARD_PATH,
} from './sensor-impersonation-routes';

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SensorGatewayRequest = Request & {
  readonly user?: Omit<AuthenticatedUser, 'tenantId'> & {
    readonly tenantId?: string | null;
    readonly mfaVerified?: boolean;
  };
  readonly effectiveTenantId?: string;
  readonly impersonationSessionId?: string;
  readonly impersonationPermissions?: ImpersonationPermissionsContract;
  readonly authorizeImpersonationOperations?: ImpersonationOperationAuthorizer;
};

/**
 * Sensor routes controller
 * Handles REST-specific sensor endpoints
 */
@Controller(GATEWAY_SENSOR_CONTROLLER_PATH)
export class SensorRoutesController {
  private readonly logger = new Logger(SensorRoutesController.name);
  private readonly sensorServiceUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.sensorServiceUrl = this.configService.get<string>(
      'SENSOR_SERVICE_URL',
      'http://localhost:3003',
    );
  }

  private async downstreamContext(
    req: SensorGatewayRequest,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<{
    readonly tenantId: string;
    readonly assertion: string;
    readonly impersonationOperations?: readonly ImpersonationOperationDescriptor[];
  }> {
    const user = req.user;
    if (!user?.sub) throw new UnauthorizedException('Authentication required');
    const tenantId = req.effectiveTenantId ?? user.tenantId ?? undefined;
    if (!tenantId || !TENANT_UUID_RE.test(tenantId)) {
      throw new UnauthorizedException('A validated tenant context is required');
    }
    const hasImpersonationContext =
      req.impersonationSessionId !== undefined || req.impersonationPermissions !== undefined;
    let impersonationOperations: readonly ImpersonationOperationDescriptor[] | undefined;
    if (hasImpersonationContext) {
      if (!req.impersonationSessionId || !req.impersonationPermissions) {
        throw new ForbiddenException('Canonical impersonation context is incomplete');
      }
      const operations = [
        resolveRestImpersonationOperation({
          serviceName: 'sensor-service',
          method,
          path,
        }),
      ] as const;
      enforceImpersonationOperations(req.impersonationPermissions, operations);
      if (!req.authorizeImpersonationOperations) {
        throw new ForbiddenException('Impersonation authorization receipt callback is missing');
      }
      expectImpersonationOperationDispatch(req, operations);
      await req.authorizeImpersonationOperations(operations);
      assertImpersonationReceiptLedgerCommitted(req);
      impersonationOperations = operations;
    }
    return {
      tenantId,
      assertion: buildGatewayVerifiedUserAssertion({
        subject: user.sub,
        tenantId: user.tenantId ?? null,
        effectiveTenantId: tenantId,
        roles: requireCanonicalGatewayAssertionRoles(user.roles ?? []),
        email: user.email,
        mfaVerified: user.mfaVerified,
        assignedSiteIds: user.assignedSiteIds,
        mobileFeatures: user.mobileFeatures,
        resourcePermissions: user.resourcePermissions,
        planLevel: user.planLevel,
        impersonationSessionId: req.impersonationSessionId,
        impersonationPermissions: req.impersonationPermissions,
      }),
      ...(impersonationOperations ? { impersonationOperations } : {}),
    };
  }

  /**
   * Health check for sensor service connectivity
   */
  @Get('health')
  async healthCheck(): Promise<{ status: string; service: string; timestamp: string }> {
    try {
      const response = await fetch(`${this.sensorServiceUrl}/health`);
      const status = response.ok ? 'healthy' : 'unhealthy';
      return {
        status,
        service: 'sensor-service',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unreachable',
        service: 'sensor-service',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Proxy MQTT connection status endpoint
   */
  @Get(GATEWAY_SENSOR_MQTT_HANDLER_PATH)
  async getMqttStatus(@Req() req: Request, @Res() res: Response): Promise<void> {
    const context = await this.downstreamContext(
      req as SensorGatewayRequest,
      'GET',
      SENSOR_MQTT_OUTWARD_PATH,
    );
    try {
      // SECURITY (HIGH-003): signedFetch binds tenantId into HMAC signature.
      if (context.impersonationOperations) {
        markImpersonationOperationDispatched(
          req as SensorGatewayRequest,
          context.impersonationOperations,
        );
        assertImpersonationReceiptLedgerReconciled(req as SensorGatewayRequest);
      }
      const responsePromise = signedFetch(`${this.sensorServiceUrl}/api/mqtt/status`, {
        serviceName: 'gateway-api',
        tenantId: context.tenantId,
        effectiveTenantId: context.tenantId,
        audience: 'sensor-service',
        headers: {
          Authorization: req.headers.authorization || '',
          'x-verified-user-assertion': context.assertion,
        },
      });
      const response = await responsePromise;

      const data: unknown = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      this.logger.error('Failed to fetch MQTT status', { error });
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Unable to reach sensor service',
      });
    }
  }

  /**
   * Proxy sensor firmware upload endpoint
   * Used for OTA firmware updates to sensors
   */
  @Post(':sensorId/firmware')
  async uploadFirmware(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sensorId = req.params.sensorId;
    const sensorRequest = req as SensorGatewayRequest;
    if (
      sensorRequest.impersonationSessionId !== undefined ||
      sensorRequest.impersonationPermissions !== undefined ||
      sensorRequest.authorizeImpersonationOperations !== undefined
    ) {
      throw new ForbiddenException('Firmware streaming does not support impersonation');
    }
    const context = await this.downstreamContext(
      sensorRequest,
      'POST',
      '/api/sensors/:sensorId/firmware',
    );

    try {
      // SECURITY (HIGH-003): signed multipart forward with tenant-bound HMAC.
      const response = await signedFetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/firmware`,
        {
          method: 'POST',
          serviceName: 'gateway-api',
          tenantId: context.tenantId,
          effectiveTenantId: context.tenantId,
          audience: 'sensor-service',
          headers: {
            Authorization: req.headers.authorization || '',
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            'x-verified-user-assertion': context.assertion,
          },
          body: req.body as BodyInit,
        },
      );

      const data: unknown = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      this.logger.error('Failed to upload firmware', { sensorId, error });
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Unable to reach sensor service',
      });
    }
  }

  /**
   * Proxy sensor data export endpoint
   * Streams large data exports directly
   */
  @Get(GATEWAY_SENSOR_EXPORT_HANDLER_PATH)
  async exportData(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sensorId = req.params.sensorId;
    const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
    const context = await this.downstreamContext(
      req as SensorGatewayRequest,
      'GET',
      SENSOR_EXPORT_OUTWARD_TEMPLATE,
    );

    try {
      // SECURITY (HIGH-003): signed export request with tenant-bound HMAC.
      if (context.impersonationOperations) {
        markImpersonationOperationDispatched(
          req as SensorGatewayRequest,
          context.impersonationOperations,
        );
        assertImpersonationReceiptLedgerReconciled(req as SensorGatewayRequest);
      }
      const responsePromise = signedFetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/export?${queryString}`,
        {
          serviceName: 'gateway-api',
          tenantId: context.tenantId,
          effectiveTenantId: context.tenantId,
          audience: 'sensor-service',
          headers: {
            Authorization: req.headers.authorization || '',
            'x-verified-user-assertion': context.assertion,
          },
        },
      );
      const response = await responsePromise;

      // Forward headers for file download
      res.setHeader(
        'Content-Type',
        response.headers.get('content-type') || 'application/octet-stream',
      );
      res.setHeader(
        'Content-Disposition',
        response.headers.get('content-disposition') ||
          `attachment; filename="${sensorId}-export.csv"`,
      );

      // Stream the response
      const reader = response.body?.getReader();
      if (reader) {
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (!done && result.value) {
            res.write(result.value);
          }
        }
      }
      res.end();
    } catch (error) {
      this.logger.error('Failed to export sensor data', { sensorId, error });
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Unable to reach sensor service',
      });
    }
  }
}

/**
 * Sensor Routes Module
 */
@Module({
  controllers: [SensorRoutesController],
})
export class SensorRoutesModule {}
