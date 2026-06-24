/**
 * Sensor Service REST Routes
 *
 * Note: Primary sensor operations use GraphQL through Apollo Federation Gateway.
 * These REST routes are for specific endpoints that don't fit GraphQL patterns
 * (e.g., file uploads, streaming data, WebSocket connections).
 */

import { Module, Controller, Get, Post, Req, Res, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { signedFetch } from '@aquaculture/backend-common/http';

// Helper to extract tenant UUID from incoming request for signed propagation.
function resolveTenantId(req: Request): string {
  const raw = req.headers['x-tenant-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(trimmed) ? trimmed : '';
}

/**
 * Sensor routes controller
 * Handles REST-specific sensor endpoints
 */
@Controller('api/v1/sensors')
export class SensorRoutesController {
  private readonly logger = new Logger(SensorRoutesController.name);
  private readonly sensorServiceUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.sensorServiceUrl = this.configService.get<string>(
      'SENSOR_SERVICE_URL',
      'http://localhost:3003',
    );
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
  @Get('mqtt/status')
  async getMqttStatus(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      // SECURITY (HIGH-003): signedFetch binds tenantId into HMAC signature.
      const response = await signedFetch(`${this.sensorServiceUrl}/api/mqtt/status`, {
        serviceName: 'gateway-api',
        tenantId: resolveTenantId(req),
        audience: 'sensor-service',
        headers: {
          Authorization: req.headers.authorization || '',
        },
      });

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

    try {
      // SECURITY (HIGH-003): signed multipart forward with tenant-bound HMAC.
      const response = await signedFetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/firmware`,
        {
          method: 'POST',
          serviceName: 'gateway-api',
          tenantId: resolveTenantId(req),
          audience: 'sensor-service',
          headers: {
            Authorization: req.headers.authorization || '',
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
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
  @Get(':sensorId/export')
  async exportData(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sensorId = req.params.sensorId;
    const queryString = new URLSearchParams(req.query as Record<string, string>).toString();

    try {
      // SECURITY (HIGH-003): signed export request with tenant-bound HMAC.
      const response = await signedFetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/export?${queryString}`,
        {
          serviceName: 'gateway-api',
          tenantId: resolveTenantId(req),
          audience: 'sensor-service',
          headers: {
            Authorization: req.headers.authorization || '',
          },
        },
      );

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
