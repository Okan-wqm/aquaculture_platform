import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from './helpers/ts-source';

/**
 * ADR-048 DEC-9.2 — one command publish path.
 *
 * `EdgeCommandPublisher` (apps/sensor-service/src/edge-device/
 * edge-command-publisher.service.ts) is the only component that writes to an
 * edge device's command topic: it reads the device's channel from the device
 * row and signs a platform-actor envelope for a Suderra OS agent, which
 * accepts nothing else (DEC-9.1). A second path would publish unsigned
 * commands — the defect SENSOR-HIGH-206 recorded at ten call sites in
 * edge-device.service.ts and three VFD services.
 *
 * Two layers:
 *   - Tier 1: MqttClientService, the one module that may load the `mqtt`
 *     client library, has no general publish and no raw-client accessor. Its
 *     only write, `publishDeviceCommand`, refuses any topic that is not a
 *     device command topic (shared-mqtt/device-command-topic.ts, the same
 *     pattern the broker ACL reads).
 *   - Tier 3: in every backend source file but the publisher, no command
 *     topic is built (`…/devices/${…}/commands`), nothing names
 *     `publishDeviceCommand` (a call, a destructuring, a bracket access), and
 *     nothing but MqttClientService loads the `mqtt` library, so no second
 *     client can be opened to write past the publisher.
 * Every check runs on comment-stripped source, so a doc comment that names
 * the topic or the method does not trip it.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PUBLISHER = 'apps/sensor-service/src/edge-device/edge-command-publisher.service.ts';
const MQTT_CLIENT = 'apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts';
/**
 * The protocol adapter for third-party MQTT sensors: it dials only the
 * operator-configured external broker of a sensor, through the outbound-host
 * guard that refuses loopback and private addresses (SENSOR-HIGH-075), so it
 * never reaches the platform broker — where, besides, the ACL admits a
 * command write from the `sensor_service` principal alone
 * (MqttAuthService.checkTopicAccess, ADR-048 DEC-9.3).
 */
const EXTERNAL_SENSOR_ADAPTER = 'apps/sensor-service/src/protocol/adapters/iot/mqtt.adapter.ts';

/** A command topic built by interpolation or by concatenation. */
const COMMAND_TOPIC = /devices\/\$\{[^}]*\}\/commands|\+\s*['"`]\/commands['"`]/;
/** Any reference to the one device-command write. */
const COMMAND_WRITE = /\bpublishDeviceCommand\b/;
/** A runtime load of the MQTT client library (a type-only import loads nothing). */
const MQTT_LIBRARY =
  /\bimport\s+(?!type\b)[^;]*?\bfrom\s+['"]mqtt['"]|\brequire\(\s*['"]mqtt['"]\s*\)|\bimport\(\s*['"]mqtt['"]\s*\)/;

function backendSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*.ts', 'libs/*.ts', 'platform/*.ts'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts') &&
        !/\/(__tests__|__mocks__|test-helpers|testing)\//.test(path),
    );
}

function offenders(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const path of backendSources()) {
    if (allowed.has(path)) continue;
    const lines = stripComments(readFileSync(join(REPO_ROOT, path), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line)) out.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe('edge command publish chokepoint (ADR-048 DEC-9.2)', () => {
  it('only EdgeCommandPublisher builds an edge command topic', () => {
    expect(offenders(COMMAND_TOPIC, new Set([PUBLISHER]))).toEqual([]);
  });

  it('only EdgeCommandPublisher names the device-command write', () => {
    expect(offenders(COMMAND_WRITE, new Set([PUBLISHER, MQTT_CLIENT]))).toEqual([]);
  });

  it('only MqttClientService (and the external-sensor adapter) loads the MQTT client library', () => {
    expect(offenders(MQTT_LIBRARY, new Set([MQTT_CLIENT, EXTERNAL_SENSOR_ADAPTER]))).toEqual([]);
  });

  it('MqttClientService writes device commands only: no general publish, no raw client', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, MQTT_CLIENT), 'utf8'));
    expect(source).not.toMatch(/^\s*(?:public\s+)?(?:async\s+)?publish\s*\(/m);
    expect(source).not.toMatch(/\bgetClient\s*\(/);
    expect(source).toMatch(/async publishDeviceCommand\(/);
    expect(source).toContain('isDeviceCommandTopic(topic)');
  });

  it('the external-sensor adapter still dials only through the outbound-host guard', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, EXTERNAL_SENSOR_ADAPTER), 'utf8'));
    const guard = source.indexOf('assertOutboundHostAllowed(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf('mqtt.connect('));
  });

  it('the publisher itself still builds the topic and signs for Suderra OS devices', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, PUBLISHER), 'utf8'));
    expect(source).toMatch(COMMAND_TOPIC);
    expect(source).toMatch(COMMAND_WRITE);
    expect(source).toContain('EdgeAgentChannel.SUDERRA_OS');
    expect(source).toContain('signPlatformCommand(');
  });

  it('the detectors catch the shapes SENSOR-HIGH-206 recorded and the ways around them', () => {
    for (const line of [
      'const topic = `tenants/${tenantId}/devices/${edgeDeviceId}/commands`;',
      "const topic = 'tenants/' + t + '/devices/' + d + '/commands';",
    ]) {
      expect(COMMAND_TOPIC.test(line)).toBe(true);
    }
    for (const line of [
      'await this.broker.publishDeviceCommand(topic, payload);',
      'const { publishDeviceCommand } = this.mqtt;',
      "await client['publishDeviceCommand'](topic, payload);",
    ]) {
      expect(COMMAND_WRITE.test(line)).toBe(true);
    }
    for (const line of [
      "import * as mqtt from 'mqtt';",
      "import { connect } from 'mqtt';",
      "import mqtt from 'mqtt';",
      "const mqtt = require('mqtt');",
      "const { connect } = await import('mqtt');",
    ]) {
      expect(MQTT_LIBRARY.test(line)).toBe(true);
    }
    expect(MQTT_LIBRARY.test("import type { IPublishPacket } from 'mqtt';")).toBe(false);
    expect(COMMAND_WRITE.test('await this.eventBus.publish({')).toBe(false);
    // Reading a topic is not building one: the broker ACL inspects it.
    expect(COMMAND_TOPIC.test("if (topic.endsWith('/commands')) return true;")).toBe(false);
  });
});
