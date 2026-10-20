/**
 * The broker endpoint an edge device is told to connect to (ADR-048 DEC-10.1,
 * DEC-10.2; SENSOR-MEDIUM-220).
 *
 * Devices reach the broker on 8883 over TLS and nothing else: the internal
 * `mosquitto:1883` listener serves the service accounts on the isolated
 * Docker network only, and Suderra OS egress admits 8883 alone. The endpoint
 * type has no plaintext form — `port` is the literal 8883 and `tls` the
 * literal `true` — so no configuration, remote setting or port number can
 * produce one. Every response and template that names the broker to a device
 * (activation, self-registration, the generic installers, the Suderra OS site
 * config) takes this type.
 */

/** The one port a device reaches the broker on. */
export const DEVICE_BROKER_PORT = 8883;

export interface DeviceBrokerEndpoint {
  readonly host: string;
  readonly port: typeof DEVICE_BROKER_PORT;
  readonly tls: true;
}

/** A DNS name or dotted IPv4 address: no scheme, port, path, credentials or space. */
const BROKER_HOST =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export class DeviceBrokerConfigError extends Error {
  constructor(source: string, host: string) {
    super(
      `${source} must be a bare broker host name (devices always use TLS on ${DEVICE_BROKER_PORT}); got ${JSON.stringify(host)}`,
    );
    this.name = 'DeviceBrokerConfigError';
  }
}

export function isDeviceBrokerHost(host: string): boolean {
  return BROKER_HOST.test(host);
}

/** The device endpoint for `host`; `source` names where the host came from. */
export function deviceBrokerEndpoint(host: string, source: string): DeviceBrokerEndpoint {
  if (!isDeviceBrokerHost(host)) {
    throw new DeviceBrokerConfigError(source, host);
  }
  return { host, port: DEVICE_BROKER_PORT, tls: true };
}
