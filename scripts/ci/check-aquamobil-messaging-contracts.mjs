#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

const root = process.cwd();

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function fail(message) {
  process.stderr.write(`aquamobil-messaging-contracts gate failed: ${message}\n`);
  process.exit(1);
}

const pushServicePath = 'apps/messaging-service/src/notification/messaging-push.service.ts';
const swPath = 'web/apps/aquamobil/src/pwa/messaging-sw.ts';
const swNavPath = 'web/apps/aquamobil/src/hooks/useSwNavigation.ts';
const socketHookPath = 'web/apps/aquamobil/src/hooks/useMessageSocket.ts';
const channelListPath = 'web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx';
const gatewayPath = 'apps/gateway-api/src/websocket/messaging.gateway.ts';
const messagingNatsPath = 'apps/messaging-service/src/event-handlers/messaging-nats.handler.ts';

const pushService = read(pushServicePath);
const sw = read(swPath);
const swNav = read(swNavPath);
const socketHook = read(socketHookPath);
const channelList = read(channelListPath);
const gateway = read(gatewayPath);
const messagingNats = read(messagingNatsPath);

if (!pushService.includes('notificationRef')) {
  fail(`${pushServicePath} must emit opaque notificationRef values`);
}
const pushPayloadData = pushService.match(
  /const pushPayload:[\s\S]*?data:\s*\{(?<data>[\s\S]*?)\},\s*badge:/m,
);
if (!pushPayloadData?.groups?.data) {
  fail(`${pushServicePath} must declare pushPayload.data explicitly`);
}
if (/\bchannelId\b|\bmessageId\b/.test(pushPayloadData.groups.data)) {
  fail(`${pushServicePath} push data must not expose channelId/messageId`);
}
if (!pushService.includes('msg:push:ref:')) {
  fail(`${pushServicePath} must persist notificationRef resolution state`);
}

if (!sw.includes('notificationRef')) {
  fail(`${swPath} must carry notificationRef from push to app`);
}
if (/payload\.data\.channelId|payload\.data\.messageId|notification\.data[\s\S]*channelId/.test(sw)) {
  fail(`${swPath} must not consume channelId/messageId from push payload`);
}
if (!swNav.includes('NAVIGATE_TO_NOTIFICATION_REF')) {
  fail(`${swNavPath} must handle service-worker notificationRef navigation`);
}
if (!socketHook.includes('resolveNotificationRef')) {
  fail(`${socketHookPath} must expose authenticated notificationRef resolver`);
}
if (!channelList.includes('notificationRef') || !channelList.includes('resolveNotificationRef')) {
  fail(`${channelListPath} must resolve notificationRef after auth before channel navigation`);
}
if (!gateway.includes("@SubscribeMessage('resolveNotificationRef')")) {
  fail(`${gatewayPath} must expose authenticated resolveNotificationRef socket API`);
}
if (!messagingNats.includes("@MessagePattern('request.messaging.resolveNotificationRef')")) {
  fail(`${messagingNatsPath} must verify and consume notificationRefs in messaging-service`);
}

process.stdout.write('OK: AquaMobil messaging push contract uses opaque notificationRef\n');
