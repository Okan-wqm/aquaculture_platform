/** Exact IndexedDB coordinate shared by the runtime adapter and test browser. */
export const OFFLINE_QUEUE_STORAGE_AUTHORITY_V1 = Object.freeze({
  databaseName: 'aquamobil-queue',
  objectStoreName: 'queue',
  databaseVersion: 1,
} as const);
