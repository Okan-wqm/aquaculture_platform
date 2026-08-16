/** Stable runtime authority identities shared by catalogs and their providers. */
export const FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 = Object.freeze({
  BATCH_AGGREGATE: 'farm-service/BatchAggregateMutationPort/v1',
  FEEDING_AGGREGATE: 'farm-service/FeedingAggregateMutationPort/v1',
  MOBILE_COMMAND_RECEIPT: 'backend-common/MobileCommandReceiptService/v1',
  STORAGE_AGGREGATE: 'storage-aggregate-authority/stock-movement/v1',
  OUTBOX_EVENT: 'platform-outbox-authority/event/v1',
  FEEDING_CATALOG_KERNEL: 'feeding-db-kernel/catalog-admission/v1',
  FEEDING_OPERATION_KERNEL: 'feeding-db-kernel/operation-run/v1',
  FEEDING_PROVENANCE_KERNEL: 'feeding-db-kernel/historical-provenance/v1',
  FEEDING_SCHEDULE_DISPATCH_KERNEL: 'feeding-db-kernel/schedule-dispatch/v1',
} as const);

export type FarmDurableMutationAuthorityIdV1 =
  (typeof FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1)[keyof typeof FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1];
