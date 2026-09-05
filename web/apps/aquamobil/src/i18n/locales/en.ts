/**
 * AquaMobil English messages (P-28 — mobile i18n, Faz 6).
 *
 * Scope: the surfaces rewritten by the meal cutover (feeding) + shared bits.
 * Remaining legacy hardcoded strings are tracked for the post-Faz-8 retrofit.
 * Keys follow the shared-ui convention `{page}.{section}.{key}`; this map is
 * the MessageKey source of truth (tr.ts must mirror it — enforced by the
 * Record<MessageKey, string> type).
 */

export const en = {
  // ── Common ──
  'common.loading': 'Loading...',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.optional': 'Optional',

  // ── Feeding (meal cutover) ──
  'feeding.title': 'Record Feeding',
  'feeding.offlineCachedBanner':
    'Offline — showing last-synced plan. It will refresh when you reconnect.',
  'feeding.selectUnit': 'Select Unit',
  'feeding.selectUnitPlaceholder': '-- Select Unit --',
  'feeding.noPlanForUnit': 'No feeding plan for this unit today',
  'feeding.noPlanForUnitHint': 'This unit has no active feeding protocol assignment.',
  'feeding.noPlansToday': 'No feeding plans for today',
  'feeding.noPlansTodayHint':
    'Day plans are generated each morning for units with an active protocol assignment.',
  'feeding.progress': '{done}/{total} meals',
  'feeding.plannedTotal': 'Planned total',
  'feeding.feed': 'Feed',
  'feeding.biomass': 'Biomass',
  'feeding.rate': 'Rate',
  'feeding.expectedFcr': 'Expected FCR',
  'feeding.waterTemp': 'Water temp',
  'feeding.defaultTempWarning': 'No temperature source — base rate applied (no adjustment).',
  'feeding.meals': 'Meals',
  'feeding.meal': 'Meal {index}',
  'feeding.mealStatus.SCHEDULED': 'Scheduled',
  'feeding.mealStatus.FED': 'Fed',
  'feeding.mealStatus.PARTIALLY_FED': 'Partially fed',
  'feeding.mealStatus.SKIPPED': 'Skipped',
  'feeding.mealStatus.MISSED': 'Missed',
  'feeding.mealStatus.CANCELLED': 'Cancelled',
  'feeding.pour.amountTitle': 'Pour Amount (kg)',
  'feeding.pour.remaining': 'Remaining of plan: {kg} kg',
  'feeding.pour.finalize': 'Finish meal',
  'feeding.pour.finalizeHint':
    'Marks the meal as fed: variance, growth and remaining-meal recalculation run on finish.',
  'feeding.method.title': 'Feeding Method',
  'feeding.method.manual': 'Manual',
  'feeding.method.automatic': 'Automatic',
  'feeding.method.demand': 'Demand',
  'feeding.notes.title': 'Notes (Optional)',
  'feeding.notes.placeholder': 'Additional observations...',
  'feeding.record': 'Record Feeding',
  'feeding.recordKg': 'Record {kg} kg',
  // W8/FARM-MEDIUM-269 — close a partially-fed meal without inventing a pour.
  'feeding.finalizeOnly': 'Finish meal (no more feed)',
  'feeding.recording': 'Recording...',
  'feeding.recorded': 'Recorded!',
  'feeding.queuedForSync': 'Queued for sync',
  'feeding.offlineWillSync': 'Offline - will sync when connected',
  'feeding.errors.amountRequired': 'Amount must be greater than 0',
  'feeding.errors.amountMax': 'Amount cannot exceed 10000 kg',
  'feeding.errors.generic': 'Failed to record feeding',
} as const;

export type MessageKey = keyof typeof en;
