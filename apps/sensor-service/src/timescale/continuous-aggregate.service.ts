import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Continuous Aggregate Service
 *
 * Provides runtime visibility into TimescaleDB continuous aggregate
 * refresh state and allows on-demand manual refresh of lagging
 * aggregates without redeploying a migration.
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class ContinuousAggregateService {
  private readonly logger = new Logger(ContinuousAggregateService.name);

  /** Known aggregate views, in dependency order (lowest → highest granularity) */
  private static readonly KNOWN_AGGREGATES = [
    'metrics_1min',
    'metrics_1hour',
    'metrics_1day',
  ] as const;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the last completed refresh time for each known aggregate.
   */
  async getRefreshStatus(): Promise<Array<{
    viewName: string;
    lastRefresh: Date | null;
    behindBy: string | null;
  }>> {
    const rows: Array<{ view_name: string; last_run_started_at: Date | null }> =
      await this.dataSource.query(
        `SELECT view_name, last_run_started_at
         FROM timescaledb_information.continuous_aggregate_stats
         WHERE view_name = ANY($1)`,
        [ContinuousAggregateService.KNOWN_AGGREGATES],
      );

    const byName = new Map(rows.map((r) => [r.view_name, r]));

    return ContinuousAggregateService.KNOWN_AGGREGATES.map((name) => {
      const row = byName.get(name);
      const lastRefresh = row?.last_run_started_at ?? null;
      let behindBy: string | null = null;
      if (lastRefresh) {
        const ms = Date.now() - lastRefresh.getTime();
        behindBy = `${Math.round(ms / 1000)}s`;
      }
      return { viewName: name, lastRefresh, behindBy };
    });
  }

  /**
   * Manually trigger a CALL refresh_continuous_aggregate() for the given view
   * over the specified window.  Use sparingly — prefer the scheduled policy
   * for routine refreshes.
   */
  async refresh(
    viewName: string,
    startTime: Date,
    endTime: Date,
  ): Promise<void> {
    // Validate against known views to prevent SQL injection
    const knownViews: readonly string[] = ContinuousAggregateService.KNOWN_AGGREGATES;
    if (!knownViews.includes(viewName)) {
      throw new Error(`Unknown continuous aggregate: ${viewName}`);
    }

    this.logger.log(
      `Manual refresh of ${viewName} from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    await this.dataSource.query(
      `CALL refresh_continuous_aggregate($1, $2, $3)`,
      [viewName, startTime, endTime],
    );
  }
}
