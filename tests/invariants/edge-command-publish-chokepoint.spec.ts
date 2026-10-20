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
 * Tier-3 make-detectable: in every backend source file but the publisher,
 *   - no command topic is built (`…/devices/${…}/commands`), and
 *   - no MQTT client `.publish(` is called (the broker client's own
 *     definition excepted).
 * Both checks run on comment-stripped source, so a doc comment that names
 * the topic does not trip them.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PUBLISHER = 'apps/sensor-service/src/edge-device/edge-command-publisher.service.ts';
const MQTT_CLIENT = 'apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts';

/** A command topic built by interpolation or by concatenation. */
const COMMAND_TOPIC = /devices\/\$\{[^}]*\}\/commands|\+\s*['"`]\/commands['"`]/;
const MQTT_PUBLISH = /\b\w*mqtt\w*\??\s*(?:!\s*)?\.\s*publish\s*\(/i;

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

  it('only EdgeCommandPublisher calls an MQTT client publish', () => {
    expect(offenders(MQTT_PUBLISH, new Set([PUBLISHER, MQTT_CLIENT]))).toEqual([]);
  });

  it('the publisher itself still builds the topic and signs for Suderra OS devices', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, PUBLISHER), 'utf8'));
    expect(source).toMatch(COMMAND_TOPIC);
    expect(source).toMatch(MQTT_PUBLISH);
    expect(source).toContain('EdgeAgentChannel.SUDERRA_OS');
    expect(source).toContain('signPlatformCommand(');
  });

  it('the detectors catch the shapes SENSOR-HIGH-206 recorded', () => {
    for (const line of [
      'await mqtt.publish(`tenants/${device.tenantId}/devices/${device.id}/commands`, {',
      'await this.mqttClient.publish(topic, payload);',
      'await this.mqttClient!.publish(topic, payload);',
      'const topic = `tenants/${tenantId}/devices/${edgeDeviceId}/commands`;',
      "const topic = 'tenants/' + t + '/devices/' + d + '/commands';",
    ]) {
      expect(COMMAND_TOPIC.test(line) || MQTT_PUBLISH.test(line)).toBe(true);
    }
    expect(MQTT_PUBLISH.test('await this.eventBus.publish({')).toBe(false);
    // Reading a topic is not building one: the broker ACL inspects it.
    expect(COMMAND_TOPIC.test("if (topic.endsWith('/commands')) return true;")).toBe(false);
  });
});
