/**
 * Warehouse Summary Response DTO
 *
 * Lightweight aggregate response specifically shaped for the AquaMobil PWA
 * warehouse hub page (StorageHubPage). This DTO provides a mobile-optimized
 * subset of storage data: KPI counts, low-stock items, and recent movements.
 *
 * Architectural rationale:
 * - The web panel uses `storageOverview` which returns detailed category
 *   totals, location fill rates, etc. Mobile needs a slimmer payload.
 * - The AquaMobil client types are GENERATED from this schema (graphql-codegen,
 *   S1 gate); every closed vocabulary here is a GraphQL enum so the client
 *   cannot hand-write a union that drifts from the wire (FARM-HIGH-317).
 * - Tenant isolation is enforced at the resolver level via @CurrentTenant().
 *
 * @see GET_WAREHOUSE_SUMMARY in web/apps/aquamobil/src/graphql/operations.ts
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';

import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

/**
 * Feed stock-coverage severity. Thresholds live in the handler next to the
 * alert-engine constant (FEED_STOCKOUT_CRITICAL_DAYS); this enum is the wire
 * vocabulary the mobile hub filters and colours by.
 */
export enum WarehouseFeedCoverageStatus {
  OK = 'OK',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

registerEnumType(WarehouseFeedCoverageStatus, {
  name: 'WarehouseFeedCoverageStatus',
  description: 'Feed stock-coverage severity on the AquaMobil warehouse hub',
});

/**
 * An inventory item that has fallen below its minimum stock threshold.
 * Displayed as alert cards on the mobile warehouse hub.
 */
@ObjectType()
export class WarehouseLowStockItem {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => StorageItemType)
  itemType!: StorageItemType;

  @Field(() => Float)
  currentQty!: number;

  @Field(() => Float)
  minQty!: number;

  @Field()
  unit!: string;
}

/**
 * A recent stock movement for the warehouse hub's activity feed.
 * Limited to the last 24 hours to keep the mobile payload small.
 */
@ObjectType()
export class WarehouseRecentMovement {
  @Field(() => ID)
  id!: string;

  @Field(() => MovementType)
  movementType!: MovementType;

  @Field()
  itemName!: string;

  @Field(() => Float)
  quantity!: number;

  @Field()
  unit!: string;

  @Field()
  createdAt!: Date;
}

/**
 * Feed başına stok-kapsama satırı (Faz 7, P-27) — günlük forecast
 * snapshot'ının ucuz satır okuması: seri/grafik web'de kalır, mobil yalnız
 * "kaç gün yeter" cevabını taşır. coverageStatus eşikleri alert-engine
 * tüketicisiyle hizalıdır: ≤3 gün critical, ≤tedarik süresi warning.
 */
@ObjectType()
export class WarehouseFeedCoverage {
  @Field(() => ID)
  feedId!: string;

  @Field()
  feedCode!: string;

  @Field()
  feedName!: string;

  /** Ufuk içinde tükeniş yoksa null (OK). */
  @Field(() => Int, { nullable: true })
  daysOfCover!: number | null;

  @Field(() => String, { nullable: true })
  stockoutDate!: string | null;

  @Field(() => WarehouseFeedCoverageStatus)
  coverageStatus!: WarehouseFeedCoverageStatus;

  /**
   * Snapshot bayat mı (W6, FARM-LOW-266). Forecast günde bir hesaplanır;
   * 26 saatten eski bir satır en az bir koşuyu kaçırmış demektir ve
   * "kritik" olarak sunulmamalıdır — operatör kararını verinin YAŞINI
   * bilerek verir.
   */
  @Field()
  stale!: boolean;
}

/**
 * Top-level warehouse summary returned by the `warehouseSummary` query.
 * Field names match the frontend WarehouseSummary interface exactly.
 */
@ObjectType()
export class WarehouseSummaryResponse {
  /** Total number of distinct inventory items across all categories. */
  @Field(() => Int)
  totalItems!: number;

  /** Number of items currently below their minimum stock threshold. */
  @Field(() => Int)
  lowStockAlertCount!: number;

  /** Number of stock movements performed today (since midnight UTC). */
  @Field(() => Int)
  todaysMovementCount!: number;

  /** Items below their minimum stock level, capped at 10 for mobile. */
  @Field(() => [WarehouseLowStockItem])
  lowStockItems!: WarehouseLowStockItem[];

  /** Most recent stock movements (last 24h), capped at 10 for mobile. */
  @Field(() => [WarehouseRecentMovement])
  recentMovements!: WarehouseRecentMovement[];

  /** Feed başına kapsama (P-27) — en kötü kapsam önce, 10 ile sınırlı. */
  @Field(() => [WarehouseFeedCoverage])
  feedCoverage!: WarehouseFeedCoverage[];
}
