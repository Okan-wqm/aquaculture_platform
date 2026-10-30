import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * The pure half of a sensor's broker credential (ADR-047 §1): the username
 * and secret it is issued, the keyring of server-side peppers, and the HMAC
 * the sensor row keeps instead of the secret. Free functions, so the issuing
 * service and the broker's CONNECT check share one derivation.
 *
 * A 256-bit random secret needs no slow KDF (ADR-047 deliberately overrides
 * the PBKDF2 rule here): HMAC-SHA-256 under a pepper only the service holds
 * is enough, and keeps the CONNECT check off a 0.5 s derivation. The pepper
 * is named by a key id stored next to the HMAC, so peppers rotate without
 * reissuing credentials.
 */

/** Environment variable carrying the keyring (JSON, see parseSensorSecretKeyring). */
export const SENSOR_MQTT_SECRET_KEYRING_ENV = 'MQTT_SENSOR_SECRET_KEYRING';

/**
 * An issued username: `s` and 22 lowercase base32 characters (110 random
 * bits), 23 in all, the client-ID length MQTT 3.1.1 guarantees. It names no
 * sensor; sensor.sensor_mqtt_directory maps it. The database checks the same
 * shape (migration 1826000000000).
 */
export const SENSOR_MQTT_USERNAME_PATTERN = /^s[a-z2-7]{22}$/;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const USERNAME_SYMBOLS = 22;
const SECRET_BYTES = 32;
const PEPPER_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** One pepper of the keyring. */
export interface SensorSecretPepper {
  readonly kid: string;
  readonly key: Buffer;
}

/**
 * The peppers a stored HMAC may name, and the one new secrets are issued
 * under. A retired pepper stays (`previous`) until no sensor names it.
 */
export interface SensorSecretKeyring {
  readonly active: SensorSecretPepper;
  readonly byKid: ReadonlyMap<string, SensorSecretPepper>;
}

/**
 * Parse the keyring: a JSON array of `{ kid, secret, status }`, `secret` 64
 * hex characters (32 bytes), `status` `active` (exactly one), `previous`
 * (verifies, never issues) or `disabled` (dropped: a credential under it no
 * longer verifies). The shape the deploy bootstrap writes for
 * SERVICE_IDENTITY_KEYRING. Throws on anything else, so a malformed keyring
 * stops the service at boot instead of refusing every sensor at CONNECT.
 */
export function parseSensorSecretKeyring(raw: string): SensorSecretKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${SENSOR_MQTT_SECRET_KEYRING_ENV} must be JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${SENSOR_MQTT_SECRET_KEYRING_ENV} must be a JSON array of keys`);
  }

  const byKid = new Map<string, SensorSecretPepper>();
  const active: SensorSecretPepper[] = [];
  parsed.forEach((entry: unknown, index) => {
    const { kid, secret, status } = keyringEntry(entry, index);
    if (byKid.has(kid)) {
      throw new Error(`${SENSOR_MQTT_SECRET_KEYRING_ENV} names kid "${kid}" twice`);
    }
    if (status === 'disabled') {
      return;
    }
    const pepper = { kid, key: Buffer.from(secret, 'hex') };
    byKid.set(kid, pepper);
    if (status === 'active') {
      active.push(pepper);
    }
  });

  const [current, ...extra] = active;
  if (!current || extra.length > 0) {
    throw new Error(
      `${SENSOR_MQTT_SECRET_KEYRING_ENV} must hold exactly one active key (found ${active.length})`,
    );
  }
  return { active: current, byKid };
}

function keyringEntry(
  entry: unknown,
  index: number,
): { kid: string; secret: string; status: 'active' | 'previous' | 'disabled' } {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${SENSOR_MQTT_SECRET_KEYRING_ENV} entry ${index} must be an object`);
  }
  const kid: unknown = Reflect.get(entry, 'kid');
  const secret: unknown = Reflect.get(entry, 'secret');
  const status: unknown = Reflect.get(entry, 'status') ?? 'active';
  if (typeof kid !== 'string' || !KEY_ID_PATTERN.test(kid)) {
    throw new Error(
      `${SENSOR_MQTT_SECRET_KEYRING_ENV} entry ${index}: kid must be 1-64 of [A-Za-z0-9._-]`,
    );
  }
  if (
    typeof secret !== 'string' ||
    !new RegExp(`^[0-9a-fA-F]{${PEPPER_BYTES * 2}}$`).test(secret)
  ) {
    throw new Error(
      `${SENSOR_MQTT_SECRET_KEYRING_ENV} entry ${index}: secret must be ${PEPPER_BYTES * 2} hex characters`,
    );
  }
  if (status !== 'active' && status !== 'previous' && status !== 'disabled') {
    throw new Error(
      `${SENSOR_MQTT_SECRET_KEYRING_ENV} entry ${index}: status must be active, previous or disabled`,
    );
  }
  return { kid, secret, status };
}

/** A fresh username in the issued shape. */
export function newSensorMqttUsername(): string {
  // 14 bytes = 112 bits; the first 110 become 22 symbols of 5 bits each.
  const bytes = randomBytes(14);
  let symbols = 's';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && symbols.length <= USERNAME_SYMBOLS) {
      bits -= 5;
      symbols += BASE32_ALPHABET.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return symbols;
}

/** A fresh secret: 32 random bytes, base64url (43 characters, no padding). */
export function newSensorMqttSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/** HMAC-SHA-256 of a secret under a pepper, as the 64 hex characters the row keeps. */
export function sensorSecretHmac(pepper: SensorSecretPepper, secret: string): string {
  return createHmac('sha256', pepper.key).update(secret, 'utf8').digest('hex');
}

/**
 * Whether a presented secret is the one a row's HMAC was computed from, under
 * the pepper the row names. A row naming a pepper the keyring no longer holds
 * does not verify. Constant time in the secret.
 */
export function verifySensorSecret(
  keyring: SensorSecretKeyring,
  stored: { hmac: string; kid: string },
  presented: string,
): boolean {
  const pepper = keyring.byKid.get(stored.kid);
  if (!pepper) {
    return false;
  }
  const expected = Buffer.from(stored.hmac, 'hex');
  const actual = Buffer.from(sensorSecretHmac(pepper, presented), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
