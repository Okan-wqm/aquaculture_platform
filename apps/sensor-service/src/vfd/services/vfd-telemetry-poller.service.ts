import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { forEachVerifiedTenantSchema } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';

import { VfdDeviceStatus } from '../entities/vfd.enums';
import { VfdDataReaderService } from './vfd-data-reader.service';

/**
 * VFD telemetry poller (SENSOR-HIGH-067).
 *
 * WHAT WAS MISSING
 *
 * `VfdDevice` has carried `poll_interval_ms` and `is_polling_enabled` since the
 * table existed; the registration wizard writes them and the device page renders
 * them. Nothing read them. sensor-service declared three scheduled jobs and none
 * touched a drive, so `readCriticalParameters` — which does open the edge read and
 * persist a `vfd_readings` row — was reachable only from an on-demand mutation
 * that no frontend code calls.
 *
 * The consequence was not an empty screen but a misleading one: `vfd_readings`
 * held whatever a manual read had last written, the UI polled it every three
 * seconds and showed a "live" indicator, and the numbers never changed. Two
 * columns of configuration described a behaviour the platform did not have.
 *
 * WHY IT SWEEPS PER TENANT SCHEMA
 *
 * `vfd_devices` and `vfd_readings` are per-tenant tables (they are in
 * `MODULE_SCHEMAS.sensor.tables`), so they exist once per tenant schema. A
 * scheduled job runs outside any request, hence outside any tenant context: an
 * unscoped repository query would resolve against the empty source-schema
 * template and silently find nothing.
 *
 * It uses `forEachVerifiedTenantSchema` rather than `forEachTenantSchema`: this
 * job makes a drive move, so it is exactly the "security-sensitive cross-tenant
 * job" the verified fan-out documents itself as required for. The tenant id comes
 * from the provisioning ledger instead of a `tenant_id` column read out of the
 * schema being swept, and suspended, migrating and pending-deletion tenants — who
 * legitimately still have a schema — are not polled.
 *
 * WHY EACH DEVICE CARRIES ITS OWN CADENCE
 *
 * The tick is fixed but the decision is per drive: a device is read only when the
 * newest reading it has is older than its own `poll_interval_ms`. That is what
 * makes the stored column mean what it says, rather than replacing it with one
 * global rate — a drive configured for 30s is not polled every 10s because the
 * job happens to run then.
 */
@Injectable()
export class VfdTelemetryPollerService {
  private readonly logger = new Logger(VfdTelemetryPollerService.name);
  private isPolling = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly dataReaderService: VfdDataReaderService,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  /**
   * Read every ACTIVE, polling-enabled drive that is due, across every tenant.
   *
   * The tick is the floor on cadence: a drive configured faster than this is
   * polled at this rate. Ten seconds is chosen against the UI's own three-second
   * refresh — fast enough that a panel is not showing minutes-old numbers, slow
   * enough that a site with many drives is not issuing continuous edge reads.
   */
  @ScheduledJob({ name: 'vfd.poll-telemetry', every: 10_000 })
  async pollDueDevices(): Promise<void> {
    if (this.isPolling) {
      // A slow edge read must delay the next cycle, never overlap it: two
      // concurrent reads of one drive would race for the same Modbus connection.
      this.logger.debug('Previous VFD poll cycle still running, skipping this tick');
      return;
    }

    this.isPolling = true;
    try {
      await forEachVerifiedTenantSchema(
        this.dataSource,
        async ({ schemaName, tenantId, queryRunner }) => {
          // Due = enabled, ACTIVE, and either never read or last read longer ago
          // than its own configured interval.
          const dueRows: { id: string }[] = await queryRunner.query(
            `SELECT d.id
             FROM vfd_devices d
             LEFT JOIN LATERAL (
               SELECT r.timestamp
                 FROM vfd_readings r
                WHERE r.vfd_device_id = d.id
                ORDER BY r.timestamp DESC
                LIMIT 1
             ) last ON TRUE
            WHERE d.is_polling_enabled = TRUE
              AND d.status = $1
              AND (
                last.timestamp IS NULL
                OR last.timestamp <= now() - make_interval(secs => d.poll_interval_ms / 1000.0)
              )`,
            [VfdDeviceStatus.ACTIVE],
          );

          if (dueRows.length === 0) return;

          this.logger.debug(`Polling ${dueRows.length} VFD drive(s) in schema ${schemaName}`);

          for (const row of dueRows) {
            // One unreachable drive must not stop the sweep: a failed edge read
            // throws rather than fabricating telemetry, and that is this drive's
            // problem, not the other tenants'.
            try {
              await withTenantContext(tenantId, async () => {
                await this.dataReaderService.readCriticalParameters(row.id, tenantId);
              });
            } catch (error) {
              this.logger.warn(
                `VFD telemetry poll failed for drive ${row.id} in schema ${schemaName}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        },
      );
    } finally {
      this.isPolling = false;
    }
  }
}
