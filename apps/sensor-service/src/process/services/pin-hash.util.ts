/**
 * Package control-security PIN hashing (SENSOR-CRITICAL-006).
 *
 * PINs guard physical actuation on operator screens. They were stored as
 * PLAINTEXT (`widget.config.pin`) inside packageData — readable by any tenant
 * member via the scadaPackage GraphQL query — and compared in the browser.
 * The server now owns the secret: a salted scrypt hash at package level
 * (`controlPermissions.pinHash`), verified only via the PIN_VERIFY socket
 * message. Node's built-in scrypt keeps this dependency-free; PINs are short
 * secrets, so the salt + memory-hard KDF are what make offline guessing
 * expensive.
 *
 * Format: `scrypt$<salt-b64>$<hash-b64>` — the prefix doubles as the marker
 * that distinguishes an already-hashed value from a legacy plaintext one at
 * the save boundary.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const PREFIX = 'scrypt';
const KEY_LEN = 64;
const SALT_LEN = 16;

/** Is this stored value already a hash (vs. a legacy plaintext PIN)? */
export function isPinHash(value: string): boolean {
  return value.startsWith(`${PREFIX}$`);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(pin, salt, KEY_LEN);
  return `${PREFIX}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (expected.length !== KEY_LEN) return false;
  const actual = scryptSync(pin, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}
