import {
  CleanupDropProofRecoveryPoint,
  captureWalgRecoveryPoint,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Captures the WAL-G recovery point a tenant schema drop must carry (ADR-0009).
 *
 * This is the whole of admin-api's backup surface. The in-process pg_dump
 * subsystem it replaces required an encryption key production never set,
 * wrote to a volume nothing mounted, ran on every replica and could not
 * restore; every deprovision failed at its backup step. WAL-G, driven by
 * `tools/scripts/database/*` and the DR workflows, is the sole authority for
 * taking and restoring backups. The service asks the database where the WAL
 * is and binds that to the archive epoch the deploy declares.
 */
@Injectable()
export class WalgRecoveryPointService {
  private readonly logger = new Logger(WalgRecoveryPointService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async capture(): Promise<CleanupDropProofRecoveryPoint> {
    const point = await captureWalgRecoveryPoint(
      this.dataSource,
      this.configService.get<string>('WALG_BACKUP_EPOCH'),
    );
    this.logger.log(
      `Recovery point captured: epoch=${point.backupEpoch} lsn=${point.walLsn} db=${point.database}`,
    );
    return point;
  }
}
