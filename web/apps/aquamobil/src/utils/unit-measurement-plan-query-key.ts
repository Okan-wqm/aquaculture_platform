/**
 * The query-key segment of a unit's water-quality measurement plan (the
 * `unitMeasurementPlan` query WaterQualityRecordPage reads). One constant, so
 * the page and the invalidation maps (farm-realtime-invalidation,
 * offline-sync-invalidation) cannot drift apart — they did: the maps kept
 * invalidating the retired 'equipment-params' key after the page moved.
 */
export const UNIT_MEASUREMENT_PLAN_QUERY_KEY = 'unit-measurement-plan' as const;
