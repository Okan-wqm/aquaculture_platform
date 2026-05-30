#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { connect, StringCodec } from 'nats';

const root = process.cwd();

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function fail(message) {
  process.stderr.write(`messaging-nats-acl smoke failed: ${message}\n`);
  process.exit(1);
}

const servicesYaml = read('infrastructure/nats/services.yaml');
if (servicesYaml.includes('- "request.>"')) {
  fail('services.yaml contains broad request.> publish grant');
}
if (servicesYaml.includes('- "request.messaging.>"')) {
  fail('services.yaml contains broad request.messaging.> grant');
}
if (!servicesYaml.includes('- "events.*.MessageSent"')) {
  fail('messaging_service must explicitly publish canonical events.*.MessageSent');
}
if (!servicesYaml.includes('- "request.messaging.verifyMembership"')) {
  fail('gateway_service must publish explicit messaging membership request subject');
}
if (!servicesYaml.includes('- "request.messaging.resolveNotificationRef"')) {
  fail('gateway_service must publish explicit notificationRef resolver subject');
}

const natsUrl = process.env.NATS_URL;
if (!natsUrl) {
  fail('NATS_URL is required for real ACL smoke; static ACL checks are not enough');
}

const connection = await connect({
  servers: natsUrl,
  name: process.env.NATS_CLIENT_NAME ?? 'messaging-acl-smoke',
});

try {
  const sc = StringCodec();
  const tenantId =
    process.env.NATS_ACL_SMOKE_TENANT_ID ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const allowedSubject = `events.${tenantId}.MessageSent`;
  connection.publish(
    allowedSubject,
    sc.encode(
      JSON.stringify({
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'MessageSent',
        timestamp: new Date().toISOString(),
        tenantId,
        version: 1,
        channelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        senderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        contentType: 'TEXT',
        hasAttachments: false,
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  await connection.flush();
} finally {
  await connection.drain();
}

process.stdout.write('OK: messaging NATS ACL smoke publish completed\n');
