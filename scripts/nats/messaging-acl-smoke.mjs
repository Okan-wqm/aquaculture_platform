#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { connect } from '@nats-io/transport-node';

const root = process.cwd();

function parseMode() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode'));
  if (!modeArg) {
    return 'live';
  }
  const mode = modeArg.includes('=') ? modeArg.split('=')[1] : process.argv[process.argv.indexOf(modeArg) + 1];
  if (mode !== 'static' && mode !== 'live') {
    fail(`unsupported --mode ${mode}; expected static or live`);
  }
  return mode;
}

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function fail(message) {
  process.stderr.write(`messaging-nats-acl smoke failed: ${message}\n`);
  process.exit(1);
}

function readPem(path, label, marker) {
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${label} at ${path} could not be read: ${message}`);
  }
  if (!pem.includes(marker)) {
    fail(`${label} at ${path} is not valid PEM material (${marker} missing)`);
  }
  return pem;
}

function buildNatsOptions() {
  const natsUrl = process.env.NATS_URL;
  if (!natsUrl) {
    fail('NATS_URL is required for real ACL smoke; static ACL checks are not enough');
  }

  const servers = natsUrl
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  const usesTls = servers.some((server) => server.startsWith('tls://'));
  const tlsEnabled = process.env.NATS_TLS_ENABLED === 'true';
  const certPath = process.env.NATS_TLS_CERT;
  const keyPath = process.env.NATS_TLS_KEY;
  const hasClientCert = Boolean(certPath && keyPath);
  const options = {
    servers,
    name: process.env.NATS_CLIENT_NAME ?? 'messaging-acl-smoke',
    reconnect: false,
    maxReconnectAttempts: 0,
  };

  if (usesTls && !tlsEnabled) {
    fail('NATS_URL uses tls:// but NATS_TLS_ENABLED is not "true"');
  }
  if (!usesTls && tlsEnabled) {
    fail('NATS_TLS_ENABLED=true but NATS_URL does not use tls://');
  }
  if (certPath && !keyPath) {
    fail('NATS_TLS_CERT is set but NATS_TLS_KEY is not');
  }
  if (keyPath && !certPath) {
    fail('NATS_TLS_KEY is set but NATS_TLS_CERT is not');
  }

  if (usesTls) {
    const caPath = process.env.NATS_TLS_CA;
    const insecureAllow = process.env.NATS_TLS_INSECURE_ALLOW === 'true';
    if (!caPath && !insecureAllow) {
      fail('NATS_URL uses tls:// but NATS_TLS_CA is not set');
    }
    if (caPath) {
      options.tls = {
        ca: readPem(caPath, 'NATS_TLS_CA', 'BEGIN CERTIFICATE'),
      };
      if (hasClientCert) {
        options.tls.cert = readPem(certPath, 'NATS_TLS_CERT', 'BEGIN CERTIFICATE');
        options.tls.key = readPem(keyPath, 'NATS_TLS_KEY', 'PRIVATE KEY');
      }
    }
  }

  if (!hasClientCert) {
    if (process.env.NATS_AUTH_TOKEN) {
      options.token = process.env.NATS_AUTH_TOKEN;
    } else if (process.env.NATS_AUTH_USER && process.env.NATS_AUTH_PASS) {
      options.user = process.env.NATS_AUTH_USER;
      options.pass = process.env.NATS_AUTH_PASS;
    }
  }

  return options;
}

function extractServiceNames(servicesYaml) {
  return [...servicesYaml.matchAll(/^\s*-\s+name:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(
    (match) => match[1],
  );
}

function extractGeneratedUserNames(natsConf) {
  return [...natsConf.matchAll(/user:\s*"([^"]+)"/g)].map((match) =>
    match[1].startsWith('CN=') ? match[1].slice(3) : match[1],
  );
}

function runStaticChecks() {
  const servicesYaml = read('infrastructure/nats/services.yaml');
  const natsConf = read('infrastructure/docker/nats/nats.conf');
  const services = extractServiceNames(servicesYaml);
  const generatedUsers = new Set(extractGeneratedUserNames(natsConf));

  if (services.length === 0) {
    fail('services.yaml did not yield any service names');
  }
  for (const service of services) {
    if (!generatedUsers.has(service)) {
      fail(`nats.conf missing generated user for CN=${service}`);
    }
  }
  if (servicesYaml.includes('- "request.>"') || natsConf.includes('"request.>"')) {
    fail('NATS ACL contains broad request.> grant');
  }
  if (
    servicesYaml.includes('- "request.messaging.>"') ||
    natsConf.includes('"request.messaging.>"')
  ) {
    fail('NATS ACL contains broad request.messaging.> grant');
  }
  if (!servicesYaml.includes('- "events.*.MessageSent"') || !natsConf.includes('"events.*.MessageSent"')) {
    fail('messaging_service must explicitly publish canonical events.*.MessageSent');
  }
  if (!servicesYaml.includes('- "request.messaging.verifyMembership"')) {
    fail('gateway_service must publish explicit messaging membership request subject');
  }
  if (!servicesYaml.includes('- "request.messaging.resolveNotificationRef"')) {
    fail('gateway_service must publish explicit notificationRef resolver subject');
  }
  for (const required of ['commands.notification.sendEmail', 'commands.notification.sendPush']) {
    if (!natsConf.includes(`"${required}"`)) {
      fail(`generated nats.conf missing required notification command ${required}`);
    }
  }
  for (const forbidden of ['commands.notification.sendSms', 'commands.notification.sendWebhook']) {
    if (servicesYaml.includes(forbidden) || natsConf.includes(forbidden)) {
      fail(`NATS ACL exposes unsupported notification command ${forbidden}`);
    }
  }
}

const mode = parseMode();
runStaticChecks();

if (mode === 'static') {
  process.stdout.write('OK: messaging NATS ACL static checks completed\n');
  process.exit(0);
}

const connection = await connect(buildNatsOptions());

try {
  const tenantId = process.env.NATS_ACL_SMOKE_TENANT_ID ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const allowedSubject = `events.${tenantId}.MessageSent`;
  // v3: publish accepts a string payload directly (UTF-8 encoded) — byte-identical
  // to the removed nats v2 StringCodec().encode().
  connection.publish(
    allowedSubject,
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
  );
  await connection.flush();
} finally {
  await connection.drain();
}

process.stdout.write('OK: messaging NATS ACL smoke publish completed\n');
