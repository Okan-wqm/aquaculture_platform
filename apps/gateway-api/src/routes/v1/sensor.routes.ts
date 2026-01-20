/**
 * Sensor Service REST Routes
 *
 * Note: Primary sensor operations use GraphQL through Apollo Federation Gateway.
 * These REST routes are for specific endpoints that don't fit GraphQL patterns
 * (e.g., file uploads, streaming data, WebSocket connections).
 */

import { Module, Controller, Get, Post, Req, Res, UseGuards, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

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
      'http://localhost:3003'
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
      const response = await fetch(`${this.sensorServiceUrl}/api/mqtt/status`, {
        headers: {
          Authorization: req.headers.authorization || '',
          'X-Tenant-Id': req.headers['x-tenant-id'] as string || '',
        },
      });

      const data = await response.json();
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
  async uploadFirmware(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sensorId = req.params.sensorId;

    try {
      // Forward multipart form data to sensor service
      const response = await fetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/firmware`,
        {
          method: 'POST',
          headers: {
            Authorization: req.headers.authorization || '',
            'X-Tenant-Id': req.headers['x-tenant-id'] as string || '',
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
          },
          body: req.body,
        }
      );

      const data = await response.json();
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
  async exportData(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sensorId = req.params.sensorId;
    const queryString = new URLSearchParams(req.query as Record<string, string>).toString();

    try {
      const response = await fetch(
        `${this.sensorServiceUrl}/api/sensors/${sensorId}/export?${queryString}`,
        {
          headers: {
            Authorization: req.headers.authorization || '',
            'X-Tenant-Id': req.headers['x-tenant-id'] as string || '',
          },
        }
      );

      // Forward headers for file download
      res.setHeader(
        'Content-Type',
        response.headers.get('content-type') || 'application/octet-stream'
      );
      res.setHeader(
        'Content-Disposition',
        response.headers.get('content-disposition') || `attachment; filename="${sensorId}-export.csv"`
      );

      // Stream the response
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
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
