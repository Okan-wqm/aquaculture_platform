/**
 * Protocol configurations carry live device/vendor credentials — Basic-auth
 * passwords, bearer tokens, API keys, OAuth2 client secrets, private keys,
 * PSKs — inside `protocolConfiguration`. These must never be echoed back
 * through a GraphQL read model or a connection-test result, where any
 * authenticated tenant user (lowest role included) could read every device's
 * live credentials (SENSOR-HIGH-081).
 *
 * Redact by field name before the value leaves the service. This is the
 * zero-effort default: a new adapter that adds a `*password` / `*secret` /
 * `*token` / `*apiKey` / `*privateKey` field is covered automatically.
 * Over-masking (e.g. an api-key HEADER name) is acceptable — the masked value
 * is display-only and is never written back to the stored config.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'clientkey',
  'client_key',
  'psk',
  'credential',
];

export const REDACTED_PLACEHOLDER = '***';

/** True if a configuration field name denotes a secret value. */
export function isSecretConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Return a copy of a protocol configuration with every secret-named field
 * masked. Recurses into nested objects (e.g. OAuth2 blocks). Null/undefined
 * values are preserved so a redacted config never fabricates a secret that was
 * not set.
 */
export function redactProtocolSecrets(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config || typeof config !== 'object') {
    return {};
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) {
      redacted[key] = value;
    } else if (isSecretConfigKey(key)) {
      redacted[key] = REDACTED_PLACEHOLDER;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactProtocolSecrets(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
