import { Controller } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@platform/backend-common';
import { DataSource } from 'typeorm';

/**
 * Config Service Health Controller
 * Extends the standard health controller with consistent K8s probe format.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    super(dataSource);
    this.serviceName = 'config-service';
  }
}
