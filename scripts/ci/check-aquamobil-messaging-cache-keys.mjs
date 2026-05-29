#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();
const root = join(repoRoot, 'web/apps/aquamobil/src');
const allowedFactory = 'web/apps/aquamobil/src/utils/messaging-query-keys.ts';
const violations = [];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

for (const file of walk(root)) {
  const rel = relative(repoRoot, file);
  if (rel === allowedFactory) continue;

  const source = readFileSync(file, 'utf8');
  if (/createTenantQueryKey\(\s*tenantId\s*,\s*['"]messaging['"]/.test(source)) {
    violations.push(`${rel}: raw messaging createTenantQueryKey usage`);
  }
  if (/\[\s*['"]messaging['"]\s*,/.test(source)) {
    violations.push(`${rel}: raw messaging query-key tuple usage`);
  }
}

const requiredFactoryUsers = [
  'web/apps/aquamobil/src/hooks/useChannels.ts',
  'web/apps/aquamobil/src/hooks/useMessages.ts',
  'web/apps/aquamobil/src/hooks/useMessageSocket.ts',
  'web/apps/aquamobil/src/hooks/useSendMessage.ts',
  'web/apps/aquamobil/src/hooks/useChannelActions.ts',
  'web/apps/aquamobil/src/hooks/useUnreadCount.ts',
  'web/apps/aquamobil/src/utils/offline-sync-invalidation.ts',
];

for (const rel of requiredFactoryUsers) {
  const source = readFileSync(join(repoRoot, rel), 'utf8');
  if (!source.includes('messagingQueryKeys')) {
    violations.push(`${rel}: must use messagingQueryKeys factory`);
  }
}

const offlineInvalidation = readFileSync(
  join(repoRoot, 'web/apps/aquamobil/src/utils/offline-sync-invalidation.ts'),
  'utf8',
);
for (const operation of ['sendMessage', 'editMessage', 'deleteMessage', 'markMessagesRead']) {
  if (!offlineInvalidation.includes(`${operation}:`)) {
    violations.push(
      `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts: missing ${operation} invalidation`,
    );
  }
}

if (violations.length > 0) {
  console.error('AquaMobil messaging cache-key gate failed.');
  console.error(
    'Use web/apps/aquamobil/src/utils/messaging-query-keys.ts for all messaging cache keys.',
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('AquaMobil messaging cache-key gate passed.');
