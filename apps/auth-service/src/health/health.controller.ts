import { StandardHealthController } from '@aquaculture/backend-common/health';
import type { ReadinessResponse } from '@aquaculture/backend-common/health';
import { Controller, Get, HttpStatus, Optional, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';

const MFA_ENCRYPTION_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Auth Service Health Controller
 * Extends the standard health controller with consistent K8s probe format.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    @Optional() private readonly configService?: ConfigService,
  ) {
    super(dataSource);
    this.serviceName = 'auth-service';
  }

  @Get('ready')
  override async readiness(@Res() res: Response): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {
      database: await this.checkDatabase(),
      ...(await this.getAdditionalChecks()),
    };

    const hasError = Object.values(checks).some((status) => status === 'error');
    const body: ReadinessResponse = {
      status: hasError ? 'not_ready' : 'ok',
      checks: checks as ReadinessResponse['checks'],
    };

    res
      .status(hasError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK)
      .json(body);
  }

  protected override getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    const nodeEnv = (
      this.configService?.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development') ??
      process.env.NODE_ENV ??
      'development'
    ).toLowerCase();
    const aquaEnv = (
      this.configService?.get<string>('AQUA_ENV', process.env.AQUA_ENV ?? '') ??
      process.env.AQUA_ENV ??
      ''
    ).toLowerCase();
    const deployEnv = (
      this.configService?.get<string>('DEPLOY_ENV', process.env.DEPLOY_ENV ?? '') ??
      process.env.DEPLOY_ENV ??
      ''
    ).toLowerCase();
    const mfaKey = this.configService?.get<string>('MFA_ENCRYPTION_KEY') ?? process.env.MFA_ENCRYPTION_KEY;
    const isStrictKeyEnv =
      nodeEnv === 'production' ||
      aquaEnv === 'production' ||
      aquaEnv === 'staging' ||
      deployEnv === 'production' ||
      deployEnv === 'staging';

    if (!isStrictKeyEnv) {
      return Promise.resolve({});
    }

    return Promise.resolve({
      mfaEncryptionKey:
        mfaKey && MFA_ENCRYPTION_KEY_REGEX.test(mfaKey) ? 'ok' : 'error',
    });
  }
}
