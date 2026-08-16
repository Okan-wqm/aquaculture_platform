/**
 * Closed retirement authority for the v1 feeding-program write surface.
 *
 * These identities no longer have runtime methods or a compatibility shim.
 * The cutover invariant proves their absence from source, GraphQL metadata,
 * mutation catalog, client operation registry, and module composition.
 */
export const RETIRED_FEEDING_MUTATION_IDS_V1 = Object.freeze([
  'activateFeedingProgram',
  'addFeedAssignment',
  'addTanksToProgram',
  'addTankToProgram',
  'assignTemperatureSensor',
  'cancelFeedingProgram',
  'cloneFeedingProgram',
  'completeFeedingProgram',
  'createFeedingProgram',
  'deleteFeedingProgram',
  'generateDailyPlan',
  'pauseFeedingProgram',
  'reactivateTankInProgram',
  'recalculateDailyPlan',
  'recordBulkFeeding',
  'recordDailyFeeding',
  'removeFeedAssignment',
  'removeTankFromProgram',
  'restoreFeedingProgram',
  'skipDailyFeeding',
  'transitionTankFeed',
  'updateFCRTable',
  'updateFeedAssignment',
  'updateFeedingProgram',
  'updateProgramSettings',
] as const);

export type RetiredFeedingMutationIdV1 = (typeof RETIRED_FEEDING_MUTATION_IDS_V1)[number];
