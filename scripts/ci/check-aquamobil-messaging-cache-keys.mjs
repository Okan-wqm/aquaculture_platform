#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

const root = process.cwd();

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function fail(message) {
  process.stderr.write(`aquamobil-messaging-cache-keys gate failed: ${message}\n`);
  process.exit(1);
}

const files = [
  'web/apps/aquamobil/src/hooks/useMessageSocket.ts',
  'web/apps/aquamobil/src/hooks/useMessages.ts',
  'web/apps/aquamobil/src/hooks/useChannels.ts',
  'web/apps/aquamobil/src/hooks/useSendMessage.ts',
  'web/apps/aquamobil/src/hooks/useAiConsent.ts',
  'web/apps/aquamobil/src/utils/offline-sync-invalidation.ts',
  'web/apps/aquamobil/src/pwa/offline-cache.ts',
];

for (const file of files) {
  const source = read(file);
  if (!source.includes('createTenantQueryKey') && file.includes('/hooks/')) {
    fail(`${file} must use createTenantQueryKey for React Query messaging state`);
  }
}

const socketSource = read('web/apps/aquamobil/src/hooks/useMessageSocket.ts');
if (/\[['"]messaging['"]/.test(socketSource)) {
  fail('useMessageSocket.ts contains raw messaging query keys');
}
if (!socketSource.includes("createTenantQueryKey(tenantId, 'messaging', 'messages'")) {
  fail('useMessageSocket.ts must update message pages through tenant-prefixed keys');
}

const aiConsentSource = read('web/apps/aquamobil/src/hooks/useAiConsent.ts');
if (/\[['"]messaging['"]/.test(aiConsentSource)) {
  fail('useAiConsent.ts contains raw messaging query keys');
}

// MOB-MEDIUM-031: the offline read cache is keyed by an OfflineCacheScope (tenant +
// user + moduleAccess, built only from the signed token), not by a bare tenant id.
const offlineCacheSource = read('web/apps/aquamobil/src/pwa/offline-cache.ts');
if (
  !/export async function readThroughOfflineCache<T>\(\s*scope: OfflineCacheScope \| null,/.test(
    offlineCacheSource,
  )
) {
  fail('offline-cache.ts must key every cached read by an OfflineCacheScope');
}

const invalidationSource = read('web/apps/aquamobil/src/utils/offline-sync-invalidation.ts');
if (!invalidationSource.includes('createTenantQueryKey(tenantId')) {
  fail('offline sync invalidation must build tenant-prefixed query keys');
}

process.stdout.write('OK: AquaMobil messaging cache keys are tenant-prefixed\n');
