import { isSecretConfigKey } from '../../common/redact-protocol-secrets';

/**
 * Deep-map every secret-named string field of a protocol configuration through
 * `transform`, returning a new object (SENSOR-MEDIUM-080).
 *
 * "Secret-named" is decided by the single SSoT `isSecretConfigKey` — the same
 * predicate that drives GraphQL read-model redaction — so a new adapter field
 * matching `*password` / `*token` / `*secret` / `*apiKey` / `*psk` / … is
 * encrypted at rest automatically. Non-secret fields (host, port, topic, …) are
 * passed through UNCHANGED so the jsonb keeps its structure and the
 * `protocol_configuration->>'topic'` index + MQTT hot-path queries still work.
 *
 * The walk recurses into nested plain objects (e.g. an OAuth2 block) and copies
 * arrays / primitives / null verbatim. Only string values under a secret key are
 * transformed; a secret key holding a non-string (unexpected) is left untouched
 * so the mapper never corrupts data it does not understand.
 */
export function mapProtocolSecretFields(
  config: Record<string, unknown>,
  transform: (secretValue: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) {
      out[key] = value;
    } else if (isSecretConfigKey(key) && typeof value === 'string') {
      out[key] = transform(value);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mapProtocolSecretFields(value as Record<string, unknown>, transform);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * True if a config contains at least one secret-named string field (possibly
 * nested). Used to decide whether encryption is required for a given row/write.
 */
export function hasSecretField(config: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (isSecretConfigKey(key) && typeof value === 'string') {
      return true;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (hasSecretField(value as Record<string, unknown>)) {
        return true;
      }
    }
  }
  return false;
}
