import { Logger, Module, type OnModuleInit } from '@nestjs/common';

import { CspReportController } from './csp-report.controller';

/**
 * NestJS module class for CSP violation report ingestion.
 *
 * The class body declares an OnModuleInit hook so the @Module decorator has a
 * concrete bearer (the @typescript-eslint/no-extraneous-class rule rejects
 * decorator-only empty classes). The hook logs module bootstrap, which is
 * useful for production diagnostics — modules silently failing to wire is
 * a recurrent cause of "feature missing" reports.
 */
@Module({
  controllers: [CspReportController],
})
export class CspReportModule implements OnModuleInit {
  private readonly logger = new Logger(CspReportModule.name);

  onModuleInit(): void {
    this.logger.log('CSP violation report endpoint registered at POST /api/csp-report');
  }
}
