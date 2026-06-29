/**
 * Get Stock-Events Summary Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060).
 *
 * count + recent-list run SEQUENTIALLY on the single tenant-asserted connection
 * (one pg connection cannot service concurrent queries).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In, MoreThanOrEqual } from 'typeorm';

import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { MobileStockEvent, StockEventsSummary } from '../dto/mobile-dashboard.dto';
import { GetStockEventsSummaryQuery } from '../queries/get-stock-events-summary.query';

const STOCK_EVENT_OPERATION_TYPES = [
  OperationType.MORTALITY,
  OperationType.CULL,
  OperationType.TRANSFER_OUT,
  OperationType.HARVEST,
];

@QueryHandler(GetStockEventsSummaryQuery)
export class GetStockEventsSummaryHandler
  implements IQueryHandler<GetStockEventsSummaryQuery>
{
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
        recentEvents: recentOperations.map((operation) => this.toStockEvent(operation)),
      };
    });
  }

  private toStockEvent(operation: TankOperation): MobileStockEvent {
    return {
      id: operation.id,
      type: this.toMobileEventType(operation.operationType),
      tankName: operation.tankName ?? operation.tankCode ?? operation.tankId,
      quantity: Math.abs(Number(operation.quantity ?? 0)),
      createdAt: operation.createdAt,
      note: this.eventNote(operation),
    };
  }

  private toMobileEventType(operationType: OperationType): string {
    switch (operationType) {
      case OperationType.MORTALITY:
        return 'MORTALITY';
      case OperationType.CULL:
        return 'CULL';
      case OperationType.TRANSFER_OUT:
        return 'TRANSFER';
      case OperationType.HARVEST:
        return 'HARVEST';
      default:
        return operationType.toUpperCase();
    }
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
