import type { ConfigService } from '@nestjs/config';

/**
 * Where a device outside the platform reaches the MQTT broker: the edge
 * installer writes it into a gateway's configuration, and a sensor holding its
 * own broker principal is shown it with its credential (ADR-047 §8). One
 * resolution for both, so the two can never send devices to different hosts.
 *
 * The host is MQTT_PUBLIC_BROKER_HOST, else the host of
 * PROVISIONING_API_BASE_URL (the platform's public name; MQTT_BROKER_HOST may
 * be an internal Docker name). Port 8883 is TLS (nginx terminates it in
 * front of the broker).
 */
export interface PublicBrokerEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}

const TLS_PORT = 8883;

export function resolvePublicBrokerEndpoint(config: ConfigService): PublicBrokerEndpoint {
  const apiBaseUrl = config.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
  const host = config.get<string>('MQTT_PUBLIC_BROKER_HOST') ?? hostnameOf(apiBaseUrl);
  const port = Number(config.get('MQTT_BROKER_PORT', 1883));
  return { host, port, tls: port === TLS_PORT };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}
