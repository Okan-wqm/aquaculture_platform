#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

const operations = read('web/apps/aquamobil/src/graphql/messaging-operations.ts');
const sw = read('web/apps/aquamobil/src/pwa/messaging-sw.ts');
const fcmSw = read('web/apps/aquamobil/public/firebase-messaging-sw.js');
const navigation = read('web/apps/aquamobil/src/hooks/useSwNavigation.ts');

if (!operations.includes('mutation ResolveNotificationRef')) {
  failures.push('GraphQL operations must include ResolveNotificationRef mutation.');
}
if (!operations.includes('resolveNotificationRef(notificationRef: $notificationRef)')) {
  failures.push('ResolveNotificationRef must call resolveNotificationRef with the opaque ref.');
}
if (!sw.includes('notificationRef') || !sw.includes('NAVIGATE_TO_NOTIFICATION_REF')) {
  failures.push('messaging service worker must carry notificationRef to the app.');
}
if (
  sw.includes('channelId: payload.data.channelId') ||
  sw.includes('messageId: payload.data.messageId')
) {
  failures.push('messaging service worker must not put channelId/messageId in push data.');
}
if (!fcmSw.includes('notificationRef') || !fcmSw.includes('NAVIGATE_TO_NOTIFICATION_REF')) {
  failures.push('Firebase service worker must carry notificationRef to the app.');
}
if (!navigation.includes('RESOLVE_NOTIFICATION_REF') || !navigation.includes('graphqlRequest')) {
  failures.push('useSwNavigation must resolve notificationRef through authenticated GraphQL.');
}

if (failures.length > 0) {
  console.error('AquaMobil messaging contract gate failed.');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('AquaMobil messaging contract gate passed.');
