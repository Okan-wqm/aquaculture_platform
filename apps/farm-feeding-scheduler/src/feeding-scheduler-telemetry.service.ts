import {
  ServiceMetricsService,
  type MetricsContributorRegistry,
} from '@aquaculture/backend-common/metrics';
import { FEEDING_SCHEDULER_OBSERVABILITY_V1 } from '@aquaculture/feeding-contracts';
import {
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as client from 'prom-client';
import { DataSource } from 'typeorm';

import type { FeedingScheduleSweepEvidenceV1 } from './feeding-schedule-ingress.service';

interface FeedingSchedulerTelemetryRow {
  readonly generation: string;
  readonly status: 'succeeded' | 'failed';
  readonly stage: FeedingScheduleSweepEvidenceV1['stage'];
  readonly recordedAt: Date;
  readonly readyBacklogCount: string;
  readonly delayedBacklogCount: string;
  readonly leasedBacklogCount: string;
  readonly quarantinedCount: string;
  readonly rejectedCount: string;
  readonly oldestOutstandingDueAt: Date | null;
}

export interface FeedingSchedulerHealthV1 {
  readonly healthy: boolean;
  readonly generation: number | null;
  readonly status: 'succeeded' | 'failed' | null;
  readonly stage: FeedingScheduleSweepEvidenceV1['stage'] | null;
  readonly recordedAt: Date | null;
  readonly heartbeatAgeSeconds: number | null;
  readonly readyBacklogCount: number;
  readonly delayedBacklogCount: number;
  readonly leasedBacklogCount: number;
  readonly quarantinedCount: number;
  readonly rejectedCount: number;
  readonly oldestOutstandingDueAt: Date | null;
}

interface FeedingSchedulerHealthRow {
  readonly healthy: boolean;
  readonly generation: string | null;
  readonly status: 'succeeded' | 'failed' | null;
  readonly stage: FeedingScheduleSweepEvidenceV1['stage'] | null;
  readonly recordedAt: Date | null;
  readonly heartbeatAgeSeconds: string | null;
  readonly readyBacklogCount: string | null;
  readonly delayedBacklogCount: string | null;
  readonly leasedBacklogCount: string | null;
  readonly quarantinedCount: string | null;
  readonly rejectedCount: string | null;
  readonly oldestOutstandingDueAt: Date | null;
}

function nonNegativeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Feeding scheduler telemetry returned invalid ${field}`);
  }
  return parsed;
}

@Injectable()
export class FeedingSchedulerTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly registry = new client.Registry();
  private readonly backlog = new client.Gauge<'state'>({
    name: 'feeding_scheduler_dispatch_backlog',
    help: 'Current durable feeding dispatch backlog by bounded state',
    labelNames: ['state'],
    registers: [this.registry],
  });
  private readonly terminal = new client.Gauge<'disposition'>({
    name: 'feeding_scheduler_terminal_dispatches',
    help: 'Current terminal feeding dispatch rows requiring operator visibility',
    labelNames: ['disposition'],
    registers: [this.registry],
  });
  private readonly lastSweepDispatches = new client.Gauge<'disposition'>({
    name: 'feeding_scheduler_last_sweep_dispatches',
    help: 'Dispatch outcomes recorded by the last durable scheduler sweep',
    labelNames: ['disposition'],
    registers: [this.registry],
  });
  private readonly lastSweepFailures = new client.Gauge({
    name: 'feeding_scheduler_last_sweep_failures',
    help: 'Failure count recorded by the last durable scheduler sweep',
    registers: [this.registry],
  });
  private readonly heartbeatGeneration = new client.Gauge({
    name: 'feeding_scheduler_durable_heartbeat_generation',
    help: 'Monotonic generation of the durable scheduler heartbeat',
    registers: [this.registry],
  });
  private readonly oldestOutstandingDue = new client.Gauge({
    name: 'feeding_scheduler_oldest_outstanding_due_timestamp_seconds',
    help: 'Unix due timestamp of the oldest pending or leased dispatch; zero when empty',
    registers: [this.registry],
  });

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: ServiceMetricsService,
  ) {}

  onModuleInit(): void {
    const contributor: MetricsContributorRegistry = this.metrics;
    contributor.registerContributor('feeding-scheduler', this.registry);
    this.backlog.set({ state: 'ready' }, 0);
    this.backlog.set({ state: 'delayed' }, 0);
    this.backlog.set({ state: 'leased' }, 0);
    this.terminal.set({ disposition: 'quarantined' }, 0);
    this.terminal.set({ disposition: 'rejected' }, 0);
    for (const disposition of FEEDING_SCHEDULER_OBSERVABILITY_V1.dispositionKeys) {
      this.lastSweepDispatches.set({ disposition }, 0);
    }
    this.lastSweepFailures.set(0);
    this.heartbeatGeneration.set(0);
    this.oldestOutstandingDue.set(0);
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  async recordSweep(evidence: FeedingScheduleSweepEvidenceV1): Promise<void> {
    const rows: FeedingSchedulerTelemetryRow[] = await this.dataSource.query(
      `SELECT generation::text AS generation, status, stage, "recordedAt",
              "readyBacklogCount"::text AS "readyBacklogCount",
              "delayedBacklogCount"::text AS "delayedBacklogCount",
              "leasedBacklogCount"::text AS "leasedBacklogCount",
              "quarantinedCount"::text AS "quarantinedCount",
              "rejectedCount"::text AS "rejectedCount", "oldestOutstandingDueAt"
         FROM farm.record_feeding_scheduler_sweep($1::jsonb)`,
      [canonicalJsonStringify(createCanonicalJsonDocumentV1(evidence))],
    );
    const row = rows[0];
    if (!row || !(row.recordedAt instanceof Date)) {
      throw new Error('Feeding scheduler sweep was not durably recorded');
    }
    this.observe(row);
    for (const disposition of FEEDING_SCHEDULER_OBSERVABILITY_V1.dispositionKeys) {
      this.lastSweepDispatches.set({ disposition }, evidence.dispositions[disposition]);
    }
    this.lastSweepFailures.set(evidence.failureDigests.length);
  }

  async readHealth(observedAt: Date): Promise<FeedingSchedulerHealthV1> {
    const rows: FeedingSchedulerHealthRow[] = await this.dataSource.query(
      `SELECT healthy, generation::text AS generation, status, stage, "recordedAt",
              "heartbeatAgeSeconds"::text AS "heartbeatAgeSeconds",
              "readyBacklogCount"::text AS "readyBacklogCount",
              "delayedBacklogCount"::text AS "delayedBacklogCount",
              "leasedBacklogCount"::text AS "leasedBacklogCount",
              "quarantinedCount"::text AS "quarantinedCount",
              "rejectedCount"::text AS "rejectedCount", "oldestOutstandingDueAt"
         FROM farm.read_feeding_scheduler_health($1::timestamptz)`,
      [observedAt],
    );
    const row = rows[0];
    if (
      !row ||
      row.generation === null ||
      row.status === null ||
      row.stage === null ||
      !(row.recordedAt instanceof Date) ||
      row.readyBacklogCount === null ||
      row.delayedBacklogCount === null ||
      row.leasedBacklogCount === null ||
      row.quarantinedCount === null ||
      row.rejectedCount === null
    ) {
      return Object.freeze({
        healthy: false,
        generation: null,
        status: null,
        stage: null,
        recordedAt: null,
        heartbeatAgeSeconds: null,
        readyBacklogCount: 0,
        delayedBacklogCount: 0,
        leasedBacklogCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        oldestOutstandingDueAt: null,
      });
    }
    const telemetryRow: FeedingSchedulerTelemetryRow = {
      generation: row.generation,
      status: row.status,
      stage: row.stage,
      recordedAt: row.recordedAt,
      readyBacklogCount: row.readyBacklogCount,
      delayedBacklogCount: row.delayedBacklogCount,
      leasedBacklogCount: row.leasedBacklogCount,
      quarantinedCount: row.quarantinedCount,
      rejectedCount: row.rejectedCount,
      oldestOutstandingDueAt: row.oldestOutstandingDueAt,
    };
    this.observe(telemetryRow);
    return Object.freeze({
      healthy: row.healthy,
      generation: nonNegativeInteger(row.generation, 'generation'),
      status: row.status,
      stage: row.stage,
      recordedAt: row.recordedAt,
      heartbeatAgeSeconds:
        row.heartbeatAgeSeconds === null
          ? null
          : nonNegativeInteger(row.heartbeatAgeSeconds, 'heartbeatAgeSeconds'),
      readyBacklogCount: nonNegativeInteger(row.readyBacklogCount, 'readyBacklogCount'),
      delayedBacklogCount: nonNegativeInteger(row.delayedBacklogCount, 'delayedBacklogCount'),
      leasedBacklogCount: nonNegativeInteger(row.leasedBacklogCount, 'leasedBacklogCount'),
      quarantinedCount: nonNegativeInteger(row.quarantinedCount, 'quarantinedCount'),
      rejectedCount: nonNegativeInteger(row.rejectedCount, 'rejectedCount'),
      oldestOutstandingDueAt: row.oldestOutstandingDueAt,
    });
  }

  private observe(row: FeedingSchedulerTelemetryRow): void {
    const generation = nonNegativeInteger(row.generation, 'generation');
    this.heartbeatGeneration.set(generation);
    this.backlog.set(
      { state: 'ready' },
      nonNegativeInteger(row.readyBacklogCount, 'readyBacklogCount'),
    );
    this.backlog.set(
      { state: 'delayed' },
      nonNegativeInteger(row.delayedBacklogCount, 'delayedBacklogCount'),
    );
    this.backlog.set(
      { state: 'leased' },
      nonNegativeInteger(row.leasedBacklogCount, 'leasedBacklogCount'),
    );
    this.terminal.set(
      { disposition: 'quarantined' },
      nonNegativeInteger(row.quarantinedCount, 'quarantinedCount'),
    );
    this.terminal.set(
      { disposition: 'rejected' },
      nonNegativeInteger(row.rejectedCount, 'rejectedCount'),
    );
    this.oldestOutstandingDue.set(
      row.oldestOutstandingDueAt ? row.oldestOutstandingDueAt.getTime() / 1_000 : 0,
    );
  }
}
