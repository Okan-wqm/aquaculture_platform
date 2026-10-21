/**
 * Reference verifier of the Suderra edge contract v1 (ADR-048 DEC-25),
 * shared by the contract's own invariant (tests/invariants/
 * suderra-edge-contracts.spec.ts) and by every producer that proves its
 * output against the contract — the cloud's statement producers
 * (apps/sensor-service/src/edge-device/__tests__/contracts-golden.spec.ts).
 * One verifier, so a producer test and the contract test cannot disagree
 * about what the contract accepts.
 *
 * DSSE PAE, Ed25519 with verify_strict semantics, the strict JSON rules,
 * schema validation, the per-statement checks of statements.json and the
 * fixture device contexts of fixtures/index.json.
 */

import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const CONTRACT_REL = 'contracts/suderra-edge';
export const CONTRACT = join(REPO_ROOT, CONTRACT_REL, 'v1');
export const FIXTURES = join(CONTRACT, 'fixtures');
export const SCHEMA_ID_PREFIX = 'urn:suderra:edge-contract:v1:schema:';
export const SEED_PREFIX = 'suderra-edge-contract:v1:TEST-ONLY:';

// ---------------------------------------------------------------- file helpers

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

export function contractRel(path: string): string {
  return relative(CONTRACT, path).split('\\').join('/');
}

export function readJson(path: string): JsonObject {
  return asObject(parseStrictJson(readFileSync(path, 'utf8')), path);
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function asObject(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value === undefined) {
    throw new Error(`${what} is not an object`);
  }
  return value;
}

export function asArray(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

export function asString(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

export function asNumber(value: Json | undefined, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} is not a number`);
  return value;
}

export function strings(value: Json | undefined, what: string): string[] {
  return asArray(value, what).map((item, i) => asString(item, `${what}[${i}]`));
}

export function objects(value: Json | undefined, what: string): JsonObject[] {
  return asArray(value, what).map((item, i) => asObject(item, `${what}[${i}]`));
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

export function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

export function sorted(items: Iterable<string>): string[] {
  return [...items].sort();
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

export function digestOf(value: Json | undefined): string | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const hex = value['sha256'];
  return typeof hex === 'string' ? hex : undefined;
}

// ------------------------------------------------------------ strict JSON parse

export const MAX_SAFE = 9007199254740991;

/**
 * RFC 8259 parser with the statements.json dsse.json rules: duplicate member
 * names, numbers other than safe integers, and unpaired surrogate escapes are
 * errors. JSON.parse accepts all three, which is the parser differential the
 * duplicate-member, fractional-number and lone-surrogate fixtures exploit.
 */
export function parseStrictJson(text: string): Json {
  let i = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} at offset ${i}`);
  };
  const skipWs = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text.charAt(i))) i += 1;
  };
  const token = (re: RegExp): string => {
    re.lastIndex = i;
    const match = re.exec(text);
    if (match === null) return fail('invalid token');
    i = re.lastIndex;
    return match[0];
  };
  // Raw control characters inside a string are refused by the JSON.parse
  // of the matched token below (RFC 8259 requires them escaped).
  const STRING = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const string = (): string => {
    const decoded = JSON.parse(token(STRING)) as string;
    for (let j = 0; j < decoded.length; j += 1) {
      const unit = decoded.charCodeAt(j);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = decoded.charCodeAt(j + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('unpaired high surrogate');
        j += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        fail('unpaired low surrogate');
      }
    }
    return decoded;
  };
  const value = (): Json => {
    skipWs();
    const c = text.charAt(i);
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    for (const [word, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return literal;
      }
    }
    const raw = token(NUMBER);
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) fail('number with a fraction or an exponent');
    const n = Number(raw);
    if (Math.abs(n) > MAX_SAFE) fail('integer beyond 2^53-1');
    return n;
  };
  const object = (): JsonObject => {
    i += 1;
    const out: JsonObject = {};
    skipWs();
    if (text.charAt(i) === '}') {
      i += 1;
      return out;
    }
    for (;;) {
      skipWs();
      if (text.charAt(i) !== '"') fail('expected member name');
      const name = string();
      if (Object.prototype.hasOwnProperty.call(out, name)) fail(`duplicate member "${name}"`);
      skipWs();
      if (text.charAt(i) !== ':') fail('expected ":"');
      i += 1;
      Object.defineProperty(out, name, {
        value: value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipWs();
      const next = text.charAt(i);
      i += 1;
      if (next === '}') return out;
      if (next !== ',') fail('expected "," or "}"');
    }
  };
  const array = (): Json[] => {
    i += 1;
    const out: Json[] = [];
    skipWs();
    if (text.charAt(i) === ']') {
      i += 1;
      return out;
    }
    for (;;) {
      out.push(value());
      skipWs();
      const next = text.charAt(i);
      i += 1;
      if (next === ']') return out;
      if (next !== ',') fail('expected "," or "]"');
    }
  };
  const result = value();
  skipWs();
  if (i !== text.length) fail('trailing data');
  return result;
}

export const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ------------------------------------------------------------- Ed25519 strict

export const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
export const ED25519_P = 2n ** 255n - 19n;
export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/**
 * Encodings of the eight small-order points of edwards25519 (plus the
 * non-canonical encodings of 0 and 1), compared with the sign bit masked, as
 * libsodium's ge25519_has_small_order does. ed25519-dalek verify_strict rejects
 * these for A and R; OpenSSL does not, hence the explicit check.
 */
export const SMALL_ORDER_ENCODINGS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));

export function isSmallOrder(point: Buffer): boolean {
  return SMALL_ORDER_ENCODINGS.some((bad) => {
    for (let j = 0; j < 31; j += 1) if (point[j] !== bad[j]) return false;
    return ((point[31] ?? 0) & 0x7f) === bad[31];
  });
}

export function littleEndian(bytes: Buffer): bigint {
  let n = 0n;
  for (let j = bytes.length - 1; j >= 0; j -= 1) n = (n << 8n) | BigInt(bytes[j] ?? 0);
  return n;
}

/** RFC 8032 5.1.3: an encoding whose y (sign bit cleared) is not below p is non-canonical. */
export function isCanonicalPoint(point: Buffer): boolean {
  const y = Buffer.from(point);
  y[31] = (y[31] ?? 0) & 0x7f;
  return littleEndian(y) < ED25519_P;
}

export function verifyStrict(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const r = signature.subarray(0, 32);
  if (littleEndian(signature.subarray(32)) >= ED25519_L) return false;
  if (isSmallOrder(publicKey) || isSmallOrder(r)) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

export interface DerivedKey {
  seed: Buffer;
  raw: Buffer;
  pem: string;
  spkiBase64: string;
}

export function deriveTestKey(seedLabel: string): DerivedKey {
  const seed = createHash('sha256').update(seedLabel, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    seed,
    raw: Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)),
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    spkiBase64: spki.toString('base64'),
  };
}

export function pae(payloadType: string, body: Buffer): Buffer {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'),
    type,
    Buffer.from(` ${body.length} `, 'utf8'),
    body,
  ]);
}

// --------------------------------------------------------------- contract load

export const statementsFile = readJson(join(CONTRACT, 'statements.json'));
export const boardsFile = readJson(join(CONTRACT, 'boards.json'));
export const namingFile = readJson(join(CONTRACT, 'artifact-naming.json'));
export const unitFile = readJson(join(CONTRACT, 'unit-directives.json'));
export const mutableFile = readJson(join(CONTRACT, 'mutable-state.json'));
export const deliveryFile = readJson(join(CONTRACT, 'delivery.json'));
export const channelsFile = readJson(join(CONTRACT, 'channels.json'));
export const lifecycleFile = readJson(join(CONTRACT, 'lifecycle.json'));
export const keyringFile = readJson(join(CONTRACT, 'test-keys', 'keyring.json'));
export const indexFile = readJson(join(FIXTURES, 'index.json'));

export const STATEMENTS = asObject(statementsFile['statements'], 'statements');
export const VERIFICATION_ORDER = strings(
  statementsFile['verification_order'],
  'verification_order',
);
export const REVERIFICATION = asObject(statementsFile['reverification'], 'reverification');
export const REVERIFIED = new Set(strings(REVERIFICATION['applies_to'], 'applies_to'));
export const PURPOSES = asObject(statementsFile['purposes'], 'purposes');
export const BOARDS = objects(boardsFile['boards'], 'boards');
export const PENDING_FAMILIES = objects(
  boardsFile['pending_board_families'],
  'pending_board_families',
);
export const BOARD_BY_PROFILE = new Map(
  BOARDS.map((row) => [asString(row['board_profile'], 'board'), row]),
);
export const EVALUATION_TIME = asString(indexFile['evaluation_time'], 'evaluation_time');
export const CONTEXTS = asObject(indexFile['device_contexts'], 'device_contexts');

export const ST_RELEASE = 'suderra.edge-release.v1';
export const ST_PROV = 'suderra.edge-provisioning.v1';
export const ST_RECEIPT = 'suderra.edge-activation-receipt.v1';
export const ST_TA = 'suderra.trust-anchors.v1';
export const ST_LIFE = 'suderra.device-lifecycle.v1';
export const ST_SITE = 'suderra.site-config.v1';
export const ST_RBAC = 'suderra.rbac-manifest.v1';
export const ST_EDGE_UPDATE = 'suderra.edge-update.v1';
export const ST_OS_UPDATE = 'suderra.os-update.v1';
export const ST_NETPOL = 'suderra.site-netpolicy.v1';

export function spec(type: string): JsonObject {
  return asObject(STATEMENTS[type], type);
}

/** verification_order + checks of the type and, recursively, of its nested types. */
export function allowedReasons(type: string, mode: string): Set<string> {
  const out = new Set<string>(VERIFICATION_ORDER);
  const visit = (t: string): void => {
    strings(spec(t)['checks'], 'checks').forEach((r) => out.add(r));
    strings(spec(t)['nested'], 'nested').forEach(visit);
  };
  visit(type);
  if (mode === 'reverify') {
    strings(REVERIFICATION['skipped_checks'], 'skipped').forEach((r) => out.delete(r));
    strings(REVERIFICATION['added_checks'], 'added').forEach((r) => out.add(r));
  }
  return out;
}

export function bundleOnly(purpose: string): boolean {
  return sameSet(strings(asObject(PURPOSES[purpose], purpose)['anchored_in'], 'anchored_in'), [
    'trust-anchors-bundle',
  ]);
}

export interface KeyEntry {
  purpose: string;
  epoch: number;
  raw: Buffer;
}

/** Keys the fixtures' simulated device pins in its OS image. */
export const OS_PINS = new Map<string, KeyEntry>(
  objects(keyringFile['keys'], 'keys')
    .filter((key) => key['fixture_anchor'] === 'os-image')
    .map((key) => [
      asString(key['keyid'], 'keyid'),
      {
        purpose: asString(key['purpose'], 'purpose'),
        epoch: asNumber(key['epoch'], 'epoch'),
        raw: Buffer.from(asString(key['public_key'], 'public_key'), 'base64'),
      },
    ]),
);

export const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
export const SCHEMA_FILES = listFiles(join(CONTRACT, 'schemas'));
for (const path of SCHEMA_FILES) ajv.addSchema(readJson(path));

export function validator(schemaRel: string): ValidateFunction {
  const name = schemaRel.replace(/^schemas\//, '').replace(/\.schema\.json$/, '');
  const fn = ajv.getSchema(`${SCHEMA_ID_PREFIX}${name}`);
  if (fn === undefined) throw new Error(`schema ${schemaRel} is not registered`);
  return fn;
}

/**
 * MAJOR.MINOR.PATCH as an integer tuple; the OS versions of the contract have no other form. The
 * components are BigInts so that the comparison is exact whatever a component's size: the schema
 * bounds them at nine digits, which no verifier's integer overflows, and this does not rely on it.
 */
export function versionTuple(text: string): [bigint, bigint, bigint] {
  const [major, minor, patch] = text.split('.').map((part) => BigInt(part));
  return [major ?? 0n, minor ?? 0n, patch ?? 0n];
}

/** Negative, zero or positive as a is below, equal to or above b. */
export function compareVersions(a: string, b: string): number {
  const left = versionTuple(a);
  const right = versionTuple(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0n;
    const r = right[i] ?? 0n;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a key store may admit the 32 bytes as a public key: the canonical encoding of a point
 * that is not small-order (statements.json dsse.signature_algorithm). verify_strict does not check
 * the canonicality of A itself, so the contract closes it here, at admission.
 */
export function isAdmissibleKey(raw: Buffer): boolean {
  return raw.length === 32 && isCanonicalPoint(raw) && !isSmallOrder(raw);
}

/** True when the CIDR's host bits are zero; a CIDR that does not parse has none to check. */
export function cidrHostBitsZero(cidr: string): boolean {
  const [address, length] = cidr.split('/');
  const octets = (address ?? '').split('.').map(Number);
  const prefix = Number(length);
  if (octets.length !== 4 || !Number.isInteger(prefix)) return true;
  const value = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const hostBits = 32 - prefix;
  return value % 2 ** hostBits === 0;
}

function allDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Constraints JSON Schema cannot state, which a verifier reports as
 * schema-invalid (rbac-manifest.schema.json register_range,
 * os-update.schema.json rollback_floor, site-netpolicy.schema.json host bits,
 * port ranges and uniqueness).
 */
export function extraSchemaValid(type: string, payload: JsonObject): boolean {
  if (type === ST_OS_UPDATE) {
    return (
      compareVersions(
        asString(payload['rollback_floor'], 'rollback_floor'),
        asString(payload['version'], 'version'),
      ) <= 0
    );
  }
  if (type === ST_NETPOL) {
    const rules = objects(payload['ot_rules'], 'ot_rules');
    if (!allDistinct(rules.map((rule) => asString(rule['id'], 'id')))) return false;
    for (const rule of rules) {
      if (!cidrHostBitsZero(asString(rule['dst'], 'dst'))) return false;
      for (const range of objects(rule['ports'], 'ports')) {
        if (asNumber(range['from'], 'from') > asNumber(range['to'], 'to')) return false;
      }
    }
    const matches = objects(payload['interfaces'], 'interfaces').map((entry) =>
      asString(entry['mac'] ?? entry['pci_path'], 'interface match'),
    );
    const sources = objects(payload['time_sources'], 'time_sources');
    return (
      allDistinct(matches) &&
      allDistinct(sources.map((source) => asString(source['id'], 'id'))) &&
      allDistinct(sources.map((source) => asString(source['host'], 'host')))
    );
  }
  if (type !== ST_RBAC) return true;
  for (const role of objects(payload['roles'], 'roles')) {
    for (const permission of asArray(role['permissions'], 'permissions')) {
      if (permission === null || typeof permission !== 'object' || Array.isArray(permission))
        continue;
      const modbus = permission['ModbusWrite'];
      if (modbus === undefined) continue;
      const range = asObject(asObject(modbus, 'ModbusWrite')['register_range'], 'register_range');
      if (asNumber(range['start'], 'start') > asNumber(range['end'], 'end')) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------- reference verifier

export interface Inputs {
  release?: Buffer;
  trustAnchors?: Buffer;
  siteConfig?: Buffer;
  rbac?: Buffer;
  siteFiles?: Map<string, Buffer>;
  requestNonce?: string;
}

export interface Identity {
  tenant: string | null;
  device: string | null;
}

export interface Options {
  mode: 'accept' | 'reverify';
  verifier: 'os-root' | 'agent';
  /** Evaluate every check that can be evaluated instead of stopping at the first. */
  allChecks: boolean;
  /** Identity a first provisioning binds, for the statements it delivers. */
  identity?: Identity;
  /** Anchors of an already verified bundle, for bundle-anchored purposes. */
  bundleKeys?: Map<string, KeyEntry>;
}

export interface Verdict {
  reasons: string[];
  payload?: JsonObject;
  payloadBytes?: Buffer;
}

export function decodedPayload(envelopeBytes: Buffer): Buffer {
  const envelope = asObject(JSON.parse(envelopeBytes.toString('utf8')) as Json, 'envelope');
  return Buffer.from(asString(envelope['payload'], 'payload'), 'base64');
}

export function bundleKeysOf(payload: JsonObject): Map<string, KeyEntry> {
  const out = new Map<string, KeyEntry>();
  for (const anchor of objects(payload['anchors'], 'anchors')) {
    if (anchor['algorithm'] !== 'ed25519') continue;
    const purpose = asString(anchor['purpose'], 'purpose');
    if (!bundleOnly(purpose)) continue;
    out.set(asString(anchor['keyid'], 'keyid'), {
      purpose,
      epoch: asNumber(anchor['epoch'], 'epoch'),
      raw: Buffer.from(asString(anchor['public_key'], 'public_key'), 'base64'),
    });
  }
  return out;
}

export function envelopeUsable(envelope: JsonObject): boolean {
  const signatures = envelope['signatures'];
  if (typeof envelope['payloadType'] !== 'string' || typeof envelope['payload'] !== 'string') {
    return false;
  }
  if (!Array.isArray(signatures) || signatures.length === 0) return false;
  const first = signatures[0];
  return (
    first !== null &&
    typeof first === 'object' &&
    !Array.isArray(first) &&
    typeof first['keyid'] === 'string' &&
    typeof first['sig'] === 'string'
  );
}

export function verifyStatement(
  envelopeBytes: Buffer,
  type: string,
  ctx: JsonObject | null,
  inputs: Inputs,
  opts: Options,
): Verdict {
  const statement = spec(type);
  const scope = asObject(statement['verified_by'], 'verified_by')[opts.verifier];
  if (scope === undefined) throw new Error(`${opts.verifier} does not verify ${type}`);
  const omitted = new Set(strings(asObject(scope, 'scope')['omits'], 'omits'));
  const reasons = new Set<string>();
  const fail = (reason: string): void => {
    if (!omitted.has(reason)) reasons.add(reason);
  };
  /** Records an envelope-stage failure; true when the verifier stops there. */
  const halts = (reason: string): boolean => {
    fail(reason);
    return !opts.allChecks && !omitted.has(reason);
  };
  const stop = (): Verdict => ({ reasons: sorted(reasons) });

  let envelope: JsonObject;
  try {
    envelope = asObject(parseStrictJson(envelopeBytes.toString('utf8')), 'envelope');
  } catch {
    fail('envelope-invalid');
    return stop();
  }
  if (!validator('schemas/dsse-envelope.schema.json')(envelope)) {
    fail('envelope-invalid');
    if (!opts.allChecks || !envelopeUsable(envelope)) return stop();
  }
  const payloadType = asString(envelope['payloadType'], 'payloadType');
  if (payloadType !== asString(statement['payload_type'], 'payload_type')) {
    fail('payload-type-mismatch');
    return stop();
  }

  // Bundle-anchored purposes resolve against a bundle that verifies first.
  let bundleKeys = opts.bundleKeys;
  const signingPurpose = asString(statement['signing_purpose'], 'signing_purpose');
  if (bundleKeys === undefined && bundleOnly(signingPurpose)) {
    if (inputs.trustAnchors === undefined) throw new Error(`${type} needs a trust-anchors input`);
    const bundle = verifyStatement(
      inputs.trustAnchors,
      ST_TA,
      ctx,
      {},
      { ...opts, bundleKeys: undefined },
    );
    bundle.reasons.forEach((reason) => reasons.add(reason));
    if (bundle.payload === undefined || bundle.reasons.length > 0) return stop();
    bundleKeys = bundleKeysOf(bundle.payload);
  }

  const signature = asObject(asArray(envelope['signatures'], 'signatures')[0], 'signature');
  const keyid = asString(signature['keyid'], 'keyid');
  const key = OS_PINS.get(keyid) ?? bundleKeys?.get(keyid);
  if (key === undefined) {
    fail('key-unknown');
    return stop();
  }
  if (key.purpose !== signingPurpose && halts('key-purpose-mismatch')) return stop();
  const ratchet = ctx === null ? undefined : asObject(ctx['ratchet'], 'ratchet')[key.purpose];
  if (typeof ratchet === 'number' && key.epoch < ratchet && halts('key-epoch-below-ratchet'))
    return stop();
  const payloadBytes = Buffer.from(asString(envelope['payload'], 'payload'), 'base64');
  const sig = Buffer.from(asString(signature['sig'], 'sig'), 'base64');
  if (!verifyStrict(key.raw, pae(payloadType, payloadBytes), sig) && halts('signature-invalid'))
    return stop();

  let payload: JsonObject;
  try {
    payload = asObject(parseStrictJson(UTF8.decode(payloadBytes)), 'payload');
  } catch {
    fail('payload-json-invalid');
    if (!opts.allChecks) return stop();
    try {
      payload = asObject(JSON.parse(payloadBytes.toString('utf8')) as Json, 'payload');
    } catch {
      return stop();
    }
  }
  const schemaValid =
    validator(asString(statement['schema'], 'schema'))(payload) && extraSchemaValid(type, payload);
  if (!schemaValid && halts('schema-invalid')) return stop();

  // ------------------------------------------------------------ semantic checks
  const check = (body: () => void): void => {
    if (!opts.allChecks) {
      body();
      return;
    }
    try {
      body();
    } catch {
      // A check whose fields the schema-invalid payload lacks cannot be evaluated.
    }
  };
  const digest = sha256(payloadBytes);
  const boundTenant =
    (ctx?.['tenant_id'] as string | null | undefined) ?? opts.identity?.tenant ?? null;
  const boundDevice =
    (ctx?.['device_id'] as string | null | undefined) ?? opts.identity?.device ?? null;
  const accepted =
    ctx === null ? undefined : (asObject(ctx['accepted'], 'accepted')[type] as Json | undefined);

  let reVerify = opts.mode === 'reverify';
  if (reVerify && !REVERIFIED.has(type)) throw new Error(`${type} is never re-verified`);
  if (reVerify) {
    check(() => {
      if (
        accepted === undefined ||
        digestOf(asObject(accepted, 'accepted')['statement_digest']) !== digest
      ) {
        fail('installed-digest-mismatch');
      }
    });
  } else if (statement['sequence'] !== null && accepted !== undefined) {
    check(() => {
      const seqSpec = asObject(statement['sequence'], 'sequence');
      const last = asObject(accepted, 'accepted');
      const value = asNumber(payload[asString(seqSpec['field'], 'field')], 'sequence value');
      const lastSeq = asNumber(last['seq'], 'seq');
      if (value < lastSeq) fail('sequence-replay');
      if (value === lastSeq) {
        if (
          seqSpec['equal_seq'] === 'identical-only' &&
          digestOf(last['statement_digest']) === digest
        ) {
          reVerify = true; // an identical re-presentation is a re-verification
        } else {
          fail('sequence-replay');
        }
      }
    });
  }
  if (!reVerify && statement['payload_type'] !== undefined && 'not_before' in payload) {
    check(() => {
      if (EVALUATION_TIME < asString(payload['not_before'], 'not_before')) fail('not-yet-valid');
      if (EVALUATION_TIME >= asString(payload['expires_at'], 'expires_at')) fail('expired');
    });
  }
  if (statement['device_bound'] === true) {
    if (ctx === null) throw new Error(`${type} needs a device context`);
    check(() => {
      if (!deepEqual(payload['device_binding'], ctx['device_binding']))
        fail('device-binding-mismatch');
      if (boundDevice !== null && payload['device_id'] !== boundDevice) fail('device-id-mismatch');
    });
  }
  if (statement['tenant_bound'] === true && type !== ST_TA) {
    check(() => {
      if (boundTenant !== null && payload['tenant_id'] !== boundTenant) fail('tenant-mismatch');
    });
  }
  const boardCheck = (board: Json | undefined, arch: Json | undefined): void => {
    if (ctx === null) return;
    if (board !== ctx['board_profile'] || arch !== ctx['arch']) fail('board-mismatch');
  };
  const nested = (
    bytes: Buffer | undefined,
    nestedType: string,
    what: string,
    extra: Partial<Options> = {},
  ): Verdict => {
    if (bytes === undefined) throw new Error(`${type} needs a ${what} input`);
    const verdict = verifyStatement(bytes, nestedType, ctx, inputs, {
      ...opts,
      bundleKeys,
      ...extra,
    });
    verdict.reasons.forEach((reason) => reasons.add(reason));
    return verdict;
  };

  switch (type) {
    case ST_RELEASE: {
      check(() => {
        const board = asString(payload['board_profile'], 'board_profile');
        const row = BOARD_BY_PROFILE.get(board);
        const naming = asObject(namingFile['suderra_os_channel'], 'suderra_os_channel');
        const artifact = asObject(payload['artifact'], 'artifact');
        const expectedName = asString(naming['artifact'], 'artifact')
          .replace('{version}', asString(payload['version'], 'version'))
          .replace('{board_profile}', board)
          .replace('{arch}', asString(payload['arch'], 'arch'));
        if (
          row === undefined ||
          payload['arch'] !== row['arch'] ||
          payload['agent_profile'] !== row['agent_profile'] ||
          !sameSet(
            strings(payload['cargo_features'], 'features'),
            strings(row['cargo_features'], 'f'),
          ) ||
          artifact['name'] !== expectedName
        ) {
          fail('release-profile-mismatch');
        }
      });
      if (ctx !== null) {
        check(() => boardCheck(payload['board_profile'], payload['arch']));
        check(() => {
          const osRelease = asObject(ctx['os_release'], 'os_release');
          if (
            compareVersions(
              asString(osRelease['VERSION_ID'], 'VERSION_ID'),
              asString(payload['min_os_version'], 'min_os_version'),
            ) < 0
          ) {
            fail('os-version-too-old');
          }
          const [min, max] = asString(osRelease['SUDERRA_AGENT_ABI'], 'abi').split('-').map(Number);
          const abi = asNumber(payload['agent_abi'], 'agent_abi');
          if (abi < (min ?? 0) || abi > (max ?? -1)) fail('agent-abi-unsupported');
          const enabled = new Set(
            strings(ctx['kernel_config'], 'kernel_config').map((l) => l.split('=')[0]),
          );
          if (
            strings(payload['required_kernel_config'], 'kernel').some(
              (symbol) => !enabled.has(symbol),
            )
          ) {
            fail('kernel-config-missing');
          }
        });
      }
      break;
    }
    case ST_PROV: {
      check(() => {
        if (asNumber(payload['key_epoch'], 'key_epoch') !== key.epoch) fail('key-epoch-mismatch');
        if (payload['nonce'] !== inputs.requestNonce) fail('nonce-mismatch');
        boardCheck(payload['board'], payload['arch']);
        if (
          ctx !== null &&
          asNumber(payload['security_version'], 'sv') <
            asNumber(ctx['security_version_floor'], 'floor')
        ) {
          fail('rollback-below-floor');
        }
      });
      const identity: Identity = {
        tenant: boundTenant ?? (payload['tenant_id'] as string | null),
        device: boundDevice ?? (payload['device_id'] as string | null),
      };
      const release = nested(inputs.release, ST_RELEASE, 'release statement', { identity });
      check(() => {
        if (
          digestOf(asObject(payload['release_statement'], 'rs')['digest']) !==
          sha256(decodedPayload(inputs.release ?? Buffer.from('')))
        ) {
          fail('release-digest-mismatch');
        }
        const r = release.payload;
        if (
          r !== undefined &&
          (payload['version'] !== r['version'] ||
            payload['board'] !== r['board_profile'] ||
            payload['arch'] !== r['arch'] ||
            payload['security_version'] !== r['security_version'] ||
            payload['agent_profile'] !== r['agent_profile'])
        ) {
          fail('release-mismatch');
        }
      });
      const bundle = nested(inputs.trustAnchors, ST_TA, 'trust-anchors', {
        identity,
        bundleKeys: undefined,
      });
      check(() => {
        const ref = asObject(payload['trust_anchors'], 'trust_anchors');
        const delivered = decodedPayload(inputs.trustAnchors ?? Buffer.from(''));
        const seq = asObject(JSON.parse(delivered.toString('utf8')) as Json, 'bundle')[
          'bundle_seq'
        ];
        if (digestOf(ref['digest']) !== sha256(delivered) || ref['bundle_seq'] !== seq) {
          fail('trust-anchors-digest-mismatch');
        }
      });
      check(() => {
        const ref = asObject(payload['site_config'], 'site_config');
        const delivered = decodedPayload(inputs.siteConfig ?? Buffer.from(''));
        const seq = asObject(JSON.parse(delivered.toString('utf8')) as Json, 'site')['update_seq'];
        if (digestOf(ref['digest']) !== sha256(delivered) || ref['update_seq'] !== seq) {
          fail('site-config-digest-mismatch');
        }
      });
      // The site config and its RBAC manifest verify only against a verified bundle.
      if (bundle.payload !== undefined && bundle.reasons.length === 0) {
        nested(inputs.siteConfig, ST_SITE, 'site config', {
          identity,
          bundleKeys: bundleKeysOf(bundle.payload),
        });
      }
      break;
    }
    case ST_RECEIPT: {
      check(() => {
        const installed = ctx === null ? null : ctx['installed_manifest'];
        const named = digestOf(payload['manifest_digest']);
        if (
          typeof installed !== 'string' ||
          named !== sha256(decodedPayload(readFileSync(join(FIXTURES, installed))))
        ) {
          fail('manifest-digest-mismatch');
        }
      });
      break;
    }
    case ST_TA: {
      check(() => {
        if (
          boundTenant !== null &&
          !strings(payload['tenant_scope'], 'scope').includes(boundTenant)
        ) {
          fail('tenant-scope-mismatch');
        }
      });
      check(() => {
        const seen = new Set<string>();
        for (const anchor of objects(payload['anchors'], 'anchors')) {
          if (anchor['algorithm'] !== 'ed25519') continue;
          const purpose = asString(anchor['purpose'], 'purpose');
          const epoch = asNumber(anchor['epoch'], 'epoch');
          const raw = Buffer.from(asString(anchor['public_key'], 'public_key'), 'base64');
          const slot = `${purpose}/${epoch}`;
          if (sha256(raw) !== anchor['keyid'] || seen.has(slot) || !isAdmissibleKey(raw)) {
            fail('anchor-invalid');
          }
          seen.add(slot);
          if (!bundleOnly(purpose)) {
            const pinned = OS_PINS.get(asString(anchor['keyid'], 'keyid'));
            if (pinned === undefined || pinned.purpose !== purpose || pinned.epoch !== epoch) {
              fail('anchor-not-os-pinned');
            }
          }
        }
      });
      break;
    }
    case ST_LIFE:
      break;
    case ST_EDGE_UPDATE: {
      check(() => {
        boardCheck(payload['board'], payload['arch']);
        if (
          ctx !== null &&
          asNumber(payload['security_version'], 'sv') <
            asNumber(ctx['security_version_floor'], 'floor')
        ) {
          fail('rollback-below-floor');
        }
      });
      const release = nested(inputs.release, ST_RELEASE, 'release statement');
      check(() => {
        if (
          digestOf(asObject(payload['release_statement'], 'rs')['digest']) !==
          sha256(decodedPayload(inputs.release ?? Buffer.from('')))
        ) {
          fail('release-digest-mismatch');
        }
        const r = release.payload;
        if (
          r !== undefined &&
          (payload['version'] !== r['version'] ||
            payload['board'] !== r['board_profile'] ||
            payload['arch'] !== r['arch'] ||
            payload['security_version'] !== r['security_version'] ||
            payload['agent_profile'] !== r['agent_profile'])
        ) {
          fail('release-mismatch');
        }
      });
      break;
    }
    case ST_OS_UPDATE: {
      check(() => {
        if (ctx === null) return;
        const osRelease = asObject(ctx['os_release'], 'os_release');
        if (payload['compatible'] !== ctx['os_compatible']) fail('compatible-mismatch');
        if (
          compareVersions(
            asString(osRelease['VERSION_ID'], 'VERSION_ID'),
            asString(payload['min_current_version'], 'min_current_version'),
          ) < 0
        ) {
          fail('os-version-too-old');
        }
        if (
          compareVersions(
            asString(payload['version'], 'version'),
            asString(ctx['os_rollback_floor'], 'os_rollback_floor'),
          ) < 0
        ) {
          fail('rollback-below-floor');
        }
        const installed = ctx['installed_agent_abi'];
        if (installed !== null && installed !== undefined) {
          const [min, max] = asString(payload['supported_agent_abi'], 'abi').split('-').map(Number);
          const abi = asNumber(installed, 'installed_agent_abi');
          if (abi < (min ?? 0) || abi > (max ?? -1)) fail('agent-abi-unsupported');
        }
      });
      break;
    }
    case ST_NETPOL: {
      check(() => {
        // The roles of a policy that is not well-formed (an interface value listed twice) are
        // undefined. The check depends on the interfaces present, which can change after
        // installation, so a re-verification skips it (statements.json reverification).
        if (ctx === null || !schemaValid || reVerify) return;
        const profile = asString(ctx['board_profile'], 'board_profile');
        const board = BOARD_BY_PROFILE.get(profile);
        if (board === undefined) throw new Error(`board ${profile} is not in boards.json`);
        const defaultRole = asString(board['default_interface_role'], 'default_interface_role');
        const entries = objects(payload['interfaces'], 'interfaces');
        let wan = 0;
        for (const nic of objects(ctx['network_interfaces'], 'network_interfaces')) {
          const matches = entries.filter(
            (entry) =>
              entry['mac'] === nic['mac'] ||
              (entry['pci_path'] !== undefined && entry['pci_path'] === nic['pci_path']),
          );
          if (matches.length > 1) fail('interface-mapping-invalid');
          const role = matches.length === 1 ? asString(matches[0]?.['role'], 'role') : defaultRole;
          if (role === 'wan') wan += 1;
        }
        if (wan === 0) fail('interface-mapping-invalid');
      });
      break;
    }
    case ST_SITE: {
      check(() => {
        const named = asObject(payload['files'], 'files');
        const delivered = inputs.siteFiles ?? new Map<string, Buffer>();
        const ok =
          sameSet(Object.keys(named), [...delivered.keys()]) &&
          Object.entries(named).every(([path, ref]) => {
            const bytes = delivered.get(path);
            const entry = asObject(ref, path);
            return (
              bytes !== undefined &&
              digestOf(entry['digest']) === sha256(bytes) &&
              entry['size_bytes'] === bytes.length
            );
          });
        if (!ok) fail('site-file-digest-mismatch');
      });
      nested(inputs.rbac, ST_RBAC, 'RBAC manifest');
      check(() => {
        const ref = asObject(payload['rbac_manifest'], 'rbac_manifest');
        const delivered = decodedPayload(inputs.rbac ?? Buffer.from(''));
        const version = asObject(JSON.parse(delivered.toString('utf8')) as Json, 'rbac')[
          'policy_version'
        ];
        if (digestOf(ref['digest']) !== sha256(delivered) || ref['policy_version'] !== version) {
          fail('rbac-manifest-digest-mismatch');
        }
      });
      break;
    }
    case ST_RBAC: {
      check(() => {
        for (const actor of objects(payload['actors'], 'actors')) {
          const raw = Buffer.from(asString(actor['public_key'], 'public_key'), 'base64');
          const anchored = bundleKeys?.get(asString(actor['keyid'], 'keyid'));
          if (
            sha256(raw) !== actor['keyid'] ||
            anchored === undefined ||
            anchored.purpose !== 'command' ||
            !anchored.raw.equals(raw)
          ) {
            fail('actor-key-not-anchored');
          }
        }
      });
      break;
    }
    default:
      throw new Error(`no statement checks for ${type}`);
  }
  return { reasons: sorted(reasons), payload, payloadBytes };
}

export function contextOf(name: Json | undefined): JsonObject | null {
  return name === null || name === undefined
    ? null
    : asObject(CONTEXTS[asString(name, 'ctx')], String(name));
}

export function inputsOf(value: Json | undefined): Inputs {
  const inputs = asObject(value, 'inputs');
  const file = (name: string): Buffer | undefined =>
    inputs[name] === undefined
      ? undefined
      : readFileSync(join(FIXTURES, asString(inputs[name], name)));
  const files = inputs['site_files'];
  // A site bundle (update channel) stands in for the RBAC manifest and the site files.
  const bundle =
    inputs['site_bundle'] === undefined
      ? undefined
      : readJson(join(FIXTURES, asString(inputs['site_bundle'], 'site_bundle')));
  return {
    release: file('release_statement'),
    trustAnchors: file('trust_anchors'),
    siteConfig: file('site_config'),
    rbac:
      bundle === undefined
        ? file('rbac_manifest')
        : Buffer.from(JSON.stringify(bundle['rbac_manifest']), 'utf8'),
    siteFiles:
      bundle !== undefined
        ? new Map(
            Object.entries(asObject(bundle['site_files'], 'site_files')).map(([path, b64]) => [
              path,
              Buffer.from(asString(b64, path), 'base64'),
            ]),
          )
        : files === undefined
          ? undefined
          : new Map(
              Object.entries(asObject(files, 'site_files')).map(([path, rel]) => [
                path,
                readFileSync(join(FIXTURES, asString(rel, path))),
              ]),
            ),
    requestNonce:
      inputs['request_nonce'] === undefined
        ? undefined
        : asString(inputs['request_nonce'], 'nonce'),
  };
}

export function runEntry(entry: JsonObject, allChecks: boolean): string[] {
  return verifyStatement(
    readFileSync(join(FIXTURES, asString(entry['path'], 'path'))),
    asString(entry['statement_type'], 'statement_type'),
    contextOf(entry['device_context']),
    inputsOf(entry['inputs']),
    {
      mode: asString(entry['mode'], 'mode') as Options['mode'],
      verifier: asString(entry['verifier'], 'verifier') as Options['verifier'],
      allChecks,
    },
  ).reasons;
}

export function verifyDelivery(entry: JsonObject, allChecks: boolean): string[] {
  const document = readJson(join(FIXTURES, asString(entry['path'], 'path')));
  const request = readJson(join(FIXTURES, asString(entry['request'], 'request')));
  return verifyDeliveryDocument(
    document,
    asString(request['nonce'], 'nonce'),
    contextOf(entry['device_context']),
    allChecks,
  );
}

/** Verifies a delivery document as root does, for the request nonce it answers. */
export function verifyDeliveryDocument(
  document: JsonObject,
  requestNonce: string,
  ctx: JsonObject | null,
  allChecks: boolean,
): string[] {
  if (!validator('schemas/edge-provisioning-delivery.schema.json')(document))
    return ['schema-invalid'];
  const member = (name: string): Buffer => Buffer.from(JSON.stringify(document[name]), 'utf8');
  return verifyStatement(
    member('manifest'),
    ST_PROV,
    ctx,
    {
      release: member('release_statement'),
      trustAnchors: member('trust_anchors'),
      siteConfig: member('site_config'),
      rbac: member('rbac_manifest'),
      siteFiles: new Map(
        Object.entries(asObject(document['site_files'], 'site_files')).map(([path, b64]) => [
          path,
          Buffer.from(asString(b64, path), 'base64'),
        ]),
      ),
      requestNonce,
    },
    { mode: 'accept', verifier: 'os-root', allChecks },
  ).reasons;
}

// ------------------------------------------------- gates and settlement (channels.json)

const UPDATE_CHANNEL_SPEC = asObject(channelsFile['update_channel'], 'update_channel');
const MAINTENANCE_GATE = asObject(
  asObject(UPDATE_CHANNEL_SPEC['maintenance'], 'maintenance')['blockers'],
  'blockers',
);
const SETTLEMENT = asObject(UPDATE_CHANNEL_SPEC['settlement'], 'settlement');
const CLOCK_SPEC = asObject(channelsFile['time'], 'time');
const HEALTH_SCHEMA = readJson(join(CONTRACT, 'schemas', 'agent-health.schema.json'));
const HEALTH_PROPERTIES = asObject(HEALTH_SCHEMA['properties'], 'properties');
const HEALTH_UPDATED_AT = new RegExp(
  asString(asObject(HEALTH_PROPERTIES['updated_at'], 'updated_at')['pattern'], 'pattern'),
);
const HEALTH_BLOCKERS = strings(
  asObject(asObject(HEALTH_PROPERTIES['update_blockers'], 'update_blockers')['items'], 'items')[
    'enum'
  ],
  'enum',
);
const HEALTH_MAX_BYTES = 65536;

/** Milliseconds of an RFC 3339 UTC instant (fractional seconds beyond a millisecond are cut). */
function instantMs(text: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|\+00:00)$/.exec(text);
  if (match === null) throw new Error(`not an RFC 3339 UTC instant: ${text}`);
  return Date.parse(`${match[1] ?? ''}${(match[2] ?? '').slice(0, 4)}Z`);
}

function readDocument(descriptor: JsonObject): JsonObject | null {
  if (descriptor['kind'] !== 'document') return null;
  try {
    return asObject(
      parseStrictJson(
        UTF8.decode(readFileSync(join(FIXTURES, asString(descriptor['path'], 'path')))),
      ),
      'document',
    );
  } catch {
    return null;
  }
}

/** What root's update worker reads of the agent health view: null when it is unavailable. */
export function healthBlockers(descriptor: JsonObject, now: string): string[] | null {
  // A view larger than 64 KiB is unavailable, whatever it holds: root reads at most that much.
  if (
    descriptor['size_bytes'] !== undefined &&
    asNumber(descriptor['size_bytes'], 'size') > HEALTH_MAX_BYTES
  )
    return null;
  const view = readDocument(descriptor);
  if (view === null) return null;
  const blockers = view['update_blockers'];
  const updated = view['updated_at'];
  if (
    view['schema'] !== 'suderra.agent-health.v1' ||
    !Array.isArray(blockers) ||
    !blockers.every((b) => typeof b === 'string' && HEALTH_BLOCKERS.includes(b)) ||
    new Set(blockers).size !== blockers.length ||
    typeof updated !== 'string' ||
    !HEALTH_UPDATED_AT.test(updated)
  ) {
    return null;
  }
  const limitMs =
    asNumber(asObject(MAINTENANCE_GATE['health_view'], 'health_view')['max_age_seconds'], 'age') *
    1000;
  if (Math.abs(instantMs(now) - instantMs(updated)) > limitMs) return null;
  return blockers as string[];
}

/**
 * Root's maintenance gate for an edge-update, an os-update or a site-config
 * (channels.json update_channel.maintenance.blockers).
 */
export function maintenanceVerdict(
  statementType: string,
  agentUnitState: string,
  view: JsonObject,
  now: string,
  blockersOverride: boolean,
): 'proceed' | 'maintenance-blocked' {
  const unit = asObject(MAINTENANCE_GATE['agent_unit'], 'agent_unit');
  if (!strings(unit['blocking_active_states'], 'states').includes(agentUnitState)) return 'proceed';
  const override = asObject(MAINTENANCE_GATE['override'], 'override');
  if (blockersOverride && strings(override['applies_to'], 'applies_to').includes(statementType))
    return 'proceed';
  const blockers = healthBlockers(view, now);
  return blockers === null || blockers.length > 0 ? 'maintenance-blocked' : 'proceed';
}

/** The state a reader takes from the time-state document it finds (channels.json time.stale_rule). */
export function clockState(descriptor: JsonObject, now: string): string {
  const document = readDocument(descriptor);
  if (document === null || !validator('schemas/time-state.schema.json')(document))
    return 'unsynced';
  const limitMs = asNumber(CLOCK_SPEC['max_age_seconds'], 'max_age_seconds') * 1000;
  if (
    Math.abs(instantMs(now) - instantMs(asString(document['updated_at'], 'updated_at'))) > limitMs
  )
    return 'unsynced';
  return asString(document['state'], 'state');
}

/** Whether the clock meets a consumer's requirement (channels.json time.consumers). */
export function clockSufficient(consumer: string, descriptor: JsonObject, now: string): boolean {
  const entry = asObject(asObject(CLOCK_SPEC['consumers'], 'consumers')[consumer], consumer);
  return strings(entry['sufficient'], 'sufficient').includes(clockState(descriptor, now));
}

export function reasonClassOf(reason: string): string {
  const classes = asObject(SETTLEMENT['reason_classes'], 'reason_classes');
  const found = Object.entries(classes).filter(([, list]) =>
    strings(list, 'list').includes(reason),
  );
  if (found.length !== 1) throw new Error(`${reason} is in ${found.length} reason classes`);
  return found[0]?.[0] ?? '';
}

function namesStatement(result: JsonObject, digest: string): boolean {
  const subject = result['subject'];
  if (subject === undefined) return false;
  const named = asObject(asObject(subject, 'subject')['statement_digest'], 'digest')['sha256'];
  return named === digest;
}

/** Whether the agent removes a spool entry (channels.json update_channel.spool.agent_is_only_writer). */
export function agentPrunes(
  entry: { name: string; age_seconds: number },
  results: JsonObject[],
  maxAgeSeconds: number,
): boolean {
  const digest = entry.name.replace(/\.dsse$/, '');
  return (
    results.some((result) => namesStatement(result, digest)) || entry.age_seconds > maxAgeSeconds
  );
}

/** What the cloud does about a statement it owes, given the results it has seen. */
export function cloudSettlement(statement: JsonObject, results: JsonObject[], now: string): string {
  const digest = asString(statement['digest'], 'digest');
  const mine = results
    .filter((r) => r['kind'] === statement['result_kind'] && namesStatement(r, digest))
    .sort((a, b) => asNumber(a['seq'], 'seq') - asNumber(b['seq'], 'seq'));
  const last = mine[mine.length - 1];
  if (last === undefined) {
    return instantMs(now) >= instantMs(asString(statement['expires_at'], 'expires_at'))
      ? 'lapsed'
      : 'wait';
  }
  if (last['outcome'] === 'ok') return 'done';
  const cls = reasonClassOf(asString(last['reason'], 'reason'));
  return cls === 'retryable' ? 'reissue' : cls;
}
