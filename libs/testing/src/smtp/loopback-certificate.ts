/**
 * A throwaway TLS identity for 127.0.0.1, minted in memory for one test.
 *
 * WHY: the services under test build their SMTP transports with
 * `requireTLS` and `rejectUnauthorized: true`, so a contract test must speak
 * real, VERIFIED TLS to reach the send path at all. Committing a key pair would
 * trip the gitleaks private-key rule and expire; the test toolchain has no
 * certificate generator as a declared dependency. `node:crypto` signs, so the
 * one missing piece is the DER encoding of an X.509 v3 certificate.
 * WHAT: an ECDSA P-256 key and a self-signed certificate whose subject
 * alternative name is IP 127.0.0.1, valid from one hour ago for one day.
 * The spec beside it proves the result parses, verifies against its own key
 * and matches the loopback address — a malformed encoding cannot pass silently.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export interface LoopbackCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

/** WHAT: one DER TLV; lengths ≥ 128 use the long form (RFC X.690 §8.1.3). */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const hex = body.length.toString(16);
  const length = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length]), length, body]);
}

/** WHAT: an OBJECT IDENTIFIER; the first two arcs share a byte, the rest are base-128. */
function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift(0x80 | (value & 0x7f));
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);

function utcTime(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${digits}Z`, 'ascii'));
}

function loopbackName(): Buffer {
  const commonName = sequence(oid('2.5.4.3'), der(0x0c, Buffer.from('127.0.0.1', 'utf8')));
  return sequence(der(0x31, commonName));
}

export function createLoopbackCertificate(): LoopbackCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaWithSha256 = sequence(oid('1.2.840.10045.4.3.2'));
  // INVARIANT: a positive, minimally encoded serial — the high bit clear and
  // the first byte non-zero. If violated → OpenSSL rejects the certificate.
  const serial = randomBytes(8);
  serial.writeUInt8((serial.readUInt8(0) & 0x7f) | 0x01, 0);
  const now = Date.now();
  // subjectAltName (2.5.29.17) = [iPAddress 127.0.0.1] — what hostname checks read.
  const subjectAltName = sequence(
    oid('2.5.29.17'),
    der(0x04, sequence(der(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaWithSha256,
    loopbackName(),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    loopbackName(),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(subjectAltName)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  const base64 = certificate.toString('base64');
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64));
  }
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
