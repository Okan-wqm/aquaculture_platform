/** Browser durability primitives required by every AquaMobil test lane. */
import 'fake-indexeddb/auto';

import { OFFLINE_QUEUE_STORAGE_AUTHORITY_V1 } from '../pwa/offline-queue-storage.authority';

await new Promise<void>((resolve, reject) => {
  const request = indexedDB.open(
    OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.databaseName,
    OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.databaseVersion,
  );
  request.onupgradeneeded = () => {
    if (
      !request.result.objectStoreNames.contains(OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.objectStoreName)
    ) {
      request.result.createObjectStore(OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.objectStoreName);
    }
  };
  request.onerror = () => reject(request.error ?? new Error('Test queue database open failed'));
  request.onsuccess = () => {
    request.result.close();
    resolve();
  };
});
