/**
 * Get Stock-Events Summary Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060).
 *
 * count + recent-list run SEQUENTIALLY on the single tenant-asserted connection
 * (one pg connection cannot service concurrent queries).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In, MoreThanOrEqual } from 'typeorm';

import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import {
  MobileStockEvent,
  MobileStockEventType,
  StockEventsSummary,
} from '../dto/mobile-dashboard.dto';
import { GetStockEventsSummaryQuery } from '../queries/get-stock-events-summary.query';

/**
 * The tank operations that ARE stock events, and the wire enum member each one
 * becomes. One closed table drives both the SQL filter and the mapping, so an
 * operation type cannot be queried without a mapping nor mapped without being
 * queried (FARM-HIGH-319 — the old `toUpperCase()` fallback could mint a
 * value the schema never declared).
 */
const STOCK_EVENT_TYPE_BY_OPERATION = {
  [OperationType.MORTALITY]: MobileStockEventType.MORTALITY,
  [OperationType.CULL]: MobileStockEventType.CULL,
  [OperationType.TRANSFER_OUT]: MobileStockEventType.TRANSFER,
  [OperationType.HARVEST]: MobileStockEventType.HARVEST,
} satisfies Partial<Record<OperationType, MobileStockEventType>>;

type StockEventOperationType = keyof typeof STOCK_EVENT_TYPE_BY_OPERATION;

const STOCK_EVENT_OPERATION_TYPES: readonly StockEventOperationType[] = [
  OperationType.MORTALITY,
  OperationType.CULL,
  OperationType.TRANSFER_OUT,
  OperationType.HARVEST,
];

function isStockEventOperation(
  operationType: OperationType,
): operationType is StockEventOperationType {
  return STOCK_EVENT_OPERATION_TYPES.some((candidate) => candidate === operationType);
}

@QueryHandler(GetStockEventsSummaryQuery)
export class GetStockEventsSummaryHandler
  implements IQueryHandler<GetStockEventsSummaryQuery>
{
  private readonly logger = new Logger(GetStockEventsSummaryHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetStockEventsSummaryQuery): Promise<StockEventsSummary> {
    const { tenantId, daysBack } = query;
    const boundedDaysBack = Math.min(Math.max(daysBack, 1), 90);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - boundedDaysBack);

    const where = {
      tenantId,
      operationType: In(STOCK_EVENT_OPERATION_TYPES),
      isDeleted: false,
      createdAt: MoreThanOrEqual(since),
    };

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const thisWeekEventsCount = await queryRunner.manager.count(TankOperation, { where });
      const recentOperations = await queryRunner.manager.find(TankOperation, {
        where,
        order: { createdAt: 'DESC' },
        take: 10,
      });

      return {
        thisWeekEventsCount,
        recentEvents: recentOperations.flatMap((operation) => this.toStockEvent(operation)),
      };
    });
  }

  /**
   * A row outside the closed table cannot reach here through the `In` filter;
   * if one ever does (a filter edit without a mapping edit), it is dropped and
   * logged rather than serialised as a value the schema does not declare.
   */
  private toStockEvent(operation: TankOperation): MobileStockEvent[] {
    if (!isStockEventOperation(operation.operationType)) {
      this.logger.warn({
        message: 'tank operation is not a mobile stock event; skipped',
        operationId: operation.id,
        operationType: operation.operationType,
      });
      return [];
    }

    return [
      {
        id: operation.id,
        type: STOCK_EVENT_TYPE_BY_OPERATION[operation.operationType],
        tankName: operation.tankName ?? operation.tankCode ?? operation.tankId,
        quantity: Math.abs(Number(operation.quantity ?? 0)),
        createdAt: operation.createdAt,
        note: this.eventNote(operation),
      },
    ];
  }

  private eventNote(operation: TankOperation): string | undefined {
    if (operation.operationType === OperationType.TRANSFER_OUT && operation.destinationTankName) {
      return `To ${operation.destinationTankName}`;
    }

    return (
      operation.mortalityDetail ??
      operation.cullDetail ??
      operation.transferReason ??
      operation.notes ??
      undefined
    );
  }
}
