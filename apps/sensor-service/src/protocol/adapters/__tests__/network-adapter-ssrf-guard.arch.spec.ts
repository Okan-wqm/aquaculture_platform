import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * SENSOR-HIGH-072/075 architecture guard: every protocol adapter that dials an
 * operator-supplied host must route it through an SSRF guard before opening a
 * socket, so a tenant cannot point a connection test at cloud metadata,
 * loopback, or RFC-1918 internal services and read latency/error as a port
 * scanner. This pins the covered set against regression (a refactor silently
 * dropping the guard). A NEW network adapter must both call a guard and be
 * added here.
 */
const GUARD_TOKENS = [
  'resolveAndValidateHost', // base helper — pins the resolved IP (raw sockets)
  'assertOutboundHostAllowed', // base helper — validate-only (URL/TLS adapters)
  'ssrfValidator', // per-adapter guard predating the base helpers
  'safeFetch',
  'validateHost',
];

// Adapters that establish an outbound connection to an operator-supplied host.
const HOST_DIALING_ADAPTERS = [
  'industrial/modbus-tcp.adapter.ts',
  'industrial/siemens-s7.adapter.ts',
  'industrial/opcua.adapter.ts',
  'iot/mqtt.adapter.ts',
  'iot/amqp.adapter.ts',
  'iot/http-rest.adapter.ts',
  'iot/websocket.adapter.ts',
  'serial/tcp-socket.adapter.ts',
];

describe('network adapter SSRF guard coverage', () => {
  it.each(HOST_DIALING_ADAPTERS)('%s validates the outbound host before connecting', (relPath) => {
    const source = readFileSync(join(__dirname, '..', relPath), 'utf8');
    const hasGuard = GUARD_TOKENS.some((token) => source.includes(token));
    expect(hasGuard).toBe(true);
  });
});
