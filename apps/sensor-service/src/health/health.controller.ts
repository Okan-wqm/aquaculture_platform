import { Controller } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';

interface ExtensionQueryResult {
  extname: string;
}

/**
 * Sensor Service Health Controller
 * Extends the standard health controller with TimescaleDB readiness check.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    super(dataSource);
    this.serviceName = 'sensor-service';
  }

  /**
   * Adds TimescaleDB extension check to readiness probe.
   */
  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    return {
      timescale: await this.checkTimescale(),
    };
  }

  private async checkTimescale(): Promise<'ok' | 'error'> {
    try {
      if (!this.dataSource.isInitialized) {
        return 'error';
      }
      const result = await this.dataSource.query<ExtensionQueryResult[]>(
        "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
      );
      return result.length > 0 ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }
}
