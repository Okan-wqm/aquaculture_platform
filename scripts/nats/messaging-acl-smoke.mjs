#!/usr/bin/env node
import { connect, StringCodec } from 'nats';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const server = process.env.NATS_SMOKE_URL ?? 'tls://127.0.0.1:4222';
const certDir = process.env.NATS_SMOKE_CERT_DIR ?? 'certs/nats';
const tenantId = process.env.NATS_SMOKE_TENANT_ID ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sc = StringCodec();

function serviceTls(serviceName) {
  return {
    caFile: join(certDir, 'ca-cert.pem'),
    certFile: join(certDir, 'clients', `${serviceName}-cert.pem`),
    keyFile: join(certDir, 'clients', `${serviceName}-key.pem`),
  };
}

async function assertReadable(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`required NATS smoke file is missing or unreadable: ${path}`);
  }
}

async function connectAs(serviceName, name = serviceName) {
  const tls = serviceTls(serviceName);
  await Promise.all([
    assertReadable(tls.caFile),
    assertReadable(tls.certFile),
    assertReadable(tls.keyFile),
  ]);

  return connect({
    servers: server,
    name: `messaging-acl-smoke-${name}`,
    tls,
    noRandomize: true,
    reconnect: false,
    timeout: 5000,
  });
}

function monitorPermissionViolations(nc) {
  const events = [];
  const waiters = [];

  const loop = (async () => {
    for await (const status of nc.status()) {
      const text = `${status.type} ${String(status.data ?? '')}`;
      events.push(text);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(text)) {
          waiter.resolve(text);
        }
      }
    }
  })();

  loop.catch(() => {});

  return {
    wait(timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(isPermissionViolationStatus);
        if (existing) {
          resolve(existing);
          return;
        }

        const waiter = {
          predicate: isPermissionViolationStatus,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        };
        const timer = setTimeout(() => {
          reject(
            new Error(
              `expected NATS permission violation within ${timeoutMs}ms; saw statuses: ${events.join(' | ') || '<none>'}`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function isPermissionViolationStatus(event) {
  return event.includes('Permissions Violation') || event.includes('PERMISSIONS_VIOLATION');
}

async function nextMessage(sub, timeoutMs = 3000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${sub.getSubject()}`)), timeoutMs),
  );
  const next = (async () => {
    for await (const msg of sub) return msg;
    throw new Error(`subscription closed before receiving ${sub.getSubject()}`);
  })();
  return Promise.race([next, timeout]);
}

async function expectPermissionViolation(serviceName, action) {
  const nc = await connectAs(serviceName, `${serviceName}-denied`);
  const monitor = monitorPermissionViolations(nc);
  try {
    await action(nc);
    try {
      await nc.flush();
    } catch {
      // Permission failures may close the connection before flush completes.
    }
    await monitor.wait();
  } finally {
    await nc.close();
  }
}

async function expectNoClientCertRejected() {
  try {
    await connect({
      servers: server,
      name: 'messaging-acl-smoke-no-client-cert',
      tls: { caFile: join(certDir, 'ca-cert.pem') },
      noRandomize: true,
      reconnect: false,
      timeout: 3000,
    });
  } catch {
    return;
  }
  throw new Error('NATS accepted a TLS connection without a client certificate');
}

async function main() {
  await expectNoClientCertRejected();

  const gateway = await connectAs('gateway_service', 'gateway-allowed');
  const messaging = await connectAs('messaging_service', 'messaging-allowed');
  const notification = await connectAs('notification_service', 'notification-allowed');
  const auth = await connectAs('auth_service', 'auth-allowed');
  const farm = await connectAs('farm_service', 'farm-allowed');

  try {
    const messageSubject = `events.${tenantId}.ChannelMessageSent`;
    const gatewaySub = gateway.subscribe(messageSubject);
    await gateway.flush();
    messaging.publish(
      messageSubject,
      sc.encode(JSON.stringify({ eventType: 'ChannelMessageSent', tenantId, eventId: 'smoke-1' })),
    );
    await messaging.flush();
    const gatewayMsg = await nextMessage(gatewaySub);
    if (gatewayMsg.subject !== messageSubject) {
      throw new Error(`gateway received unexpected subject: ${gatewayMsg.subject}`);
    }

    const pushSubject = `events.${tenantId}.ChatPushRequested`;
    const notificationSub = notification.subscribe(pushSubject);
    await notification.flush();
    messaging.publish(
      pushSubject,
      sc.encode(JSON.stringify({ eventType: 'ChatPushRequested', tenantId, eventId: 'smoke-2' })),
    );
    await messaging.flush();
    const notificationMsg = await nextMessage(notificationSub);
    if (notificationMsg.subject !== pushSubject) {
      throw new Error(`notification received unexpected subject: ${notificationMsg.subject}`);
    }

    const responder = messaging.subscribe('request.messaging.markRead');
    (async () => {
      for await (const msg of responder) {
        msg.respond(sc.encode(JSON.stringify({ ok: true })));
      }
    })().catch(() => {});
    await messaging.flush();
    const reply = await gateway.request(
      'request.messaging.markRead',
      sc.encode(JSON.stringify({ tenantId, channelId: tenantId, messageId: tenantId })),
      { timeout: 3000 },
    );
    const decodedReply = JSON.parse(sc.decode(reply.data));
    if (decodedReply.ok !== true) {
      throw new Error('gateway request.messaging.markRead did not receive expected reply');
    }

    const authAdminResponder = auth.subscribe('request.auth.admin.checkUserLimit');
    (async () => {
      for await (const msg of authAdminResponder) {
        msg.respond(sc.encode(JSON.stringify({ success: true, canCreate: true })));
      }
    })().catch(() => {});
    await auth.flush();
    const authAdminReply = await gateway.request(
      'request.auth.admin.checkUserLimit',
      sc.encode(JSON.stringify({ tenantId })),
      { timeout: 3000 },
    );
    if (JSON.parse(sc.decode(authAdminReply.data)).success !== true) {
      throw new Error('gateway request.auth.admin.checkUserLimit did not receive expected reply');
    }

    const authQueryResponder = auth.subscribe('auth.queries.ValidateTenantUsers');
    (async () => {
      for await (const msg of authQueryResponder) {
        msg.respond(sc.encode(JSON.stringify({ success: true, allValid: true })));
      }
    })().catch(() => {});
    await auth.flush();
    const authQueryReply = await messaging.request(
      'auth.queries.ValidateTenantUsers',
      sc.encode(JSON.stringify({ tenantId, userIds: [tenantId] })),
      { timeout: 3000 },
    );
    if (JSON.parse(sc.decode(authQueryReply.data)).allValid !== true) {
      throw new Error('messaging auth.queries.ValidateTenantUsers did not receive expected reply');
    }

    const farmResponder = farm.subscribe('request.farm.getTankRegistry');
    (async () => {
      for await (const msg of farmResponder) {
        msg.respond(sc.encode(JSON.stringify([{ id: tenantId, code: 'T-1', name: 'Tank 1' }])));
      }
    })().catch(() => {});
    await farm.flush();
    const farmReply = await messaging.request(
      'request.farm.getTankRegistry',
      sc.encode(JSON.stringify({ tenantId })),
      { timeout: 3000 },
    );
    if (!Array.isArray(JSON.parse(sc.decode(farmReply.data)))) {
      throw new Error('messaging request.farm.getTankRegistry did not receive expected reply');
    }
  } finally {
    await Promise.all([
      gateway.close(),
      messaging.close(),
      notification.close(),
      auth.close(),
      farm.close(),
    ]);
  }

  await expectPermissionViolation('gateway_service', async (nc) => {
    nc.publish('request.auth.verifyPassword', sc.encode('{}'));
  });

  await expectPermissionViolation('messaging_service', async (nc) => {
    nc.publish('request.auth.admin.createUser', sc.encode('{}'));
  });

  await expectPermissionViolation('messaging_service', async (nc) => {
    nc.publish(`events.${tenantId}.SensorReading`, sc.encode('{}'));
  });

  await expectPermissionViolation('notification_service', async (nc) => {
    nc.subscribe('events.>');
  });

  console.log('NATS messaging mTLS ACL smoke passed.');
}

main().catch((error) => {
  console.error(`NATS messaging mTLS ACL smoke failed: ${error.message}`);
  process.exit(1);
});
