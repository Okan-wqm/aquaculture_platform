/**
 * INVARIANT: the Suderra edge contract (contracts/suderra-edge/v1, ADR-048 DEC-25)
 * is intact, self-consistent and exactly as strict as its golden fixtures say.
 *
 * WHY THIS EXISTS. Suderra OS, the edge agent and the cloud each kept their own
 * copy of the manifest shape, the board names and the agent unit, and nothing
 * compared them: the cloud rendered an unsigned flat manifest the OS verifier
 * could not parse (SENSOR-HIGH-204), the release tarball held a binary name no
 * installer looked for (SENSOR-MEDIUM-224), five board vocabularies disagreed
 * (EI-018) and three unit copies drifted until the effective one granted
 * /dev/watchdog (EI-042). The contract is now one versioned directory that all
 * three components are tested against, and this spec is its drift gate:
 *
 *   1. SHA256SUMS covers every file and every digest matches (Suderra-OS vendors
 *      the directory and pins the digest of this file).
 *   2. Every schema compiles and every contract file validates against its own.
 *   3. The vocabularies agree: the schema board enum, boards.json, the cloud
 *      DeviceModel and DeviceLifecycleState enums, the agent's Permission enum,
 *      the generic release slugs, the result reason table, the unit's writable
 *      paths and the mutable-state table.
 *   4. Every TEST-ONLY key is re-derived from its published seed label, and no
 *      key material of it appears anywhere in this repository outside the
 *      contract directory (no signer config, no pinned key).
 *   5. A reference verifier (DSSE PAE, Ed25519 with verify_strict semantics,
 *      strict JSON, schema, statement checks, nested statements, sequences,
 *      re-verification, per-verifier check sets) reaches exactly the verdict and
 *      the reason each fixture is labelled with, also when it evaluates every
 *      check instead of stopping at the first (each negative carries one
 *      defect); every (statement, reason) pair has a negative fixture; the
 *      golden deliveries verify end to end; the reference unit checker gives
 *      each unit its labelled violations.
 *
 * tools/generate.py --check proves the fixtures are exactly what the generator
 * writes; it runs in CI as `npm run test:suderra-edge-fixtures`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
  X509Certificate,
} from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT_REL = 'contracts/suderra-edge';
const CONTRACT = join(REPO_ROOT, CONTRACT_REL, 'v1');
const FIXTURES = join(CONTRACT, 'fixtures');
const SCHEMA_ID_PREFIX = 'urn:suderra:edge-contract:v1:schema:';
const SEED_PREFIX = 'suderra-edge-contract:v1:TEST-ONLY:';
const THIS_SPEC = 'tests/invariants/suderra-edge-contracts.spec.ts';

// ---------------------------------------------------------------- file helpers

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

function contractRel(path: string): string {
  return relative(CONTRACT, path).split('\\').join('/');
}

function readJson(path: string): JsonObject {
  return asObject(parseStrictJson(readFileSync(path, 'utf8')), path);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function asObject(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value === undefined) {
    throw new Error(`${what} is not an object`);
  }
  return value;
}

function asArray(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

function asString(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

function asNumber(value: Json | undefined, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} is not a number`);
  return value;
}

function strings(value: Json | undefined, what: string): string[] {
  return asArray(value, what).map((item, i) => asString(item, `${what}[${i}]`));
}

function objects(value: Json | undefined, what: string): JsonObject[] {
  return asArray(value, what).map((item, i) => asObject(item, `${what}[${i}]`));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sorted(items: Iterable<string>): string[] {
  return [...items].sort();
}

function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

function digestOf(value: Json | undefined): string | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const hex = value['sha256'];
  return typeof hex === 'string' ? hex : undefined;
}

// ------------------------------------------------------------ strict JSON parse

const MAX_SAFE = 9007199254740991;

/**
 * RFC 8259 parser with the statements.json dsse.json rules: duplicate member
 * names, numbers other than safe integers, and unpaired surrogate escapes are
 * errors. JSON.parse accepts all three, which is the parser differential the
 * duplicate-member, fractional-number and lone-surrogate fixtures exploit.
 */
function parseStrictJson(text: string): Json {
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
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
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

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ------------------------------------------------------------- Ed25519 strict

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const ED25519_P = 2n ** 255n - 19n;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/**
 * Encodings of the eight small-order points of edwards25519 (plus the
 * non-canonical encodings of 0 and 1), compared with the sign bit masked, as
 * libsodium's ge25519_has_small_order does. ed25519-dalek verify_strict rejects
 * these for A and R; OpenSSL does not, hence the explicit check.
 */
const SMALL_ORDER_ENCODINGS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));

function isSmallOrder(point: Buffer): boolean {
  return SMALL_ORDER_ENCODINGS.some((bad) => {
    for (let j = 0; j < 31; j += 1) if (point[j] !== bad[j]) return false;
    return ((point[31] ?? 0) & 0x7f) === bad[31];
  });
}

function littleEndian(bytes: Buffer): bigint {
  let n = 0n;
  for (let j = bytes.length - 1; j >= 0; j -= 1) n = (n << 8n) | BigInt(bytes[j] ?? 0);
  return n;
}

/** RFC 8032 5.1.3: an encoding whose y (sign bit cleared) is not below p is non-canonical. */
function isCanonicalPoint(point: Buffer): boolean {
  const y = Buffer.from(point);
  y[31] = (y[31] ?? 0) & 0x7f;
  return littleEndian(y) < ED25519_P;
}

function verifyStrict(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const r = signature.subarray(0, 32);
  if (littleEndian(signature.subarray(32)) >= ED25519_L) return false;
  if (!isCanonicalPoint(publicKey) || !isCanonicalPoint(r)) return false;
  if (isSmallOrder(publicKey) || isSmallOrder(r)) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

interface DerivedKey {
  seed: Buffer;
  raw: Buffer;
  pem: string;
  spkiBase64: string;
}

function deriveTestKey(seedLabel: string): DerivedKey {
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

function pae(payloadType: string, body: Buffer): Buffer {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'),
    type,
    Buffer.from(` ${body.length} `, 'utf8'),
    body,
  ]);
}

// --------------------------------------------------------------- contract load

const statementsFile = readJson(join(CONTRACT, 'statements.json'));
const boardsFile = readJson(join(CONTRACT, 'boards.json'));
const namingFile = readJson(join(CONTRACT, 'artifact-naming.json'));
const unitFile = readJson(join(CONTRACT, 'unit-directives.json'));
const mutableFile = readJson(join(CONTRACT, 'mutable-state.json'));
const deliveryFile = readJson(join(CONTRACT, 'delivery.json'));
const lifecycleFile = readJson(join(CONTRACT, 'lifecycle.json'));
const keyringFile = readJson(join(CONTRACT, 'test-keys', 'keyring.json'));
const indexFile = readJson(join(FIXTURES, 'index.json'));

const STATEMENTS = asObject(statementsFile['statements'], 'statements');
const VERIFICATION_ORDER = strings(statementsFile['verification_order'], 'verification_order');
const REVERIFICATION = asObject(statementsFile['reverification'], 'reverification');
const REVERIFIED = new Set(strings(REVERIFICATION['applies_to'], 'applies_to'));
const PURPOSES = asObject(statementsFile['purposes'], 'purposes');
const BOARDS = objects(boardsFile['boards'], 'boards');
const PENDING_FAMILIES = objects(boardsFile['pending_board_families'], 'pending_board_families');
const BOARD_BY_PROFILE = new Map(
  BOARDS.map((row) => [asString(row['board_profile'], 'board'), row]),
);
const EVALUATION_TIME = asString(indexFile['evaluation_time'], 'evaluation_time');
const CONTEXTS = asObject(indexFile['device_contexts'], 'device_contexts');

const ST_RELEASE = 'suderra.edge-release.v1';
const ST_PROV = 'suderra.edge-provisioning.v1';
const ST_RECEIPT = 'suderra.edge-activation-receipt.v1';
const ST_TA = 'suderra.trust-anchors.v1';
const ST_LIFE = 'suderra.device-lifecycle.v1';
const ST_SITE = 'suderra.site-config.v1';
const ST_RBAC = 'suderra.rbac-manifest.v1';

function spec(type: string): JsonObject {
  return asObject(STATEMENTS[type], type);
}

/** verification_order + checks of the type and, recursively, of its nested types. */
function allowedReasons(type: string, mode: string): Set<string> {
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

function bundleOnly(purpose: string): boolean {
  return sameSet(strings(asObject(PURPOSES[purpose], purpose)['anchored_in'], 'anchored_in'), [
    'trust-anchors-bundle',
  ]);
}

interface KeyEntry {
  purpose: string;
  epoch: number;
  raw: Buffer;
}

/** Keys the fixtures' simulated device pins in its OS image. */
const OS_PINS = new Map<string, KeyEntry>(
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

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const SCHEMA_FILES = listFiles(join(CONTRACT, 'schemas'));
for (const path of SCHEMA_FILES) ajv.addSchema(readJson(path));

function validator(schemaRel: string): ValidateFunction {
  const name = schemaRel.replace(/^schemas\//, '').replace(/\.schema\.json$/, '');
  const fn = ajv.getSchema(`${SCHEMA_ID_PREFIX}${name}`);
  if (fn === undefined) throw new Error(`schema ${schemaRel} is not registered`);
  return fn;
}

/**
 * Constraints JSON Schema cannot state, which a verifier reports as
 * schema-invalid (rbac-manifest.schema.json register_range).
 */
function extraSchemaValid(type: string, payload: JsonObject): boolean {
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

interface Inputs {
  release?: Buffer;
  trustAnchors?: Buffer;
  siteConfig?: Buffer;
  rbac?: Buffer;
  siteFiles?: Map<string, Buffer>;
  requestNonce?: string;
}

interface Identity {
  tenant: string | null;
  device: string | null;
}

interface Options {
  mode: 'accept' | 'reverify';
  verifier: 'os-root' | 'agent';
  /** Evaluate every check that can be evaluated instead of stopping at the first. */
  allChecks: boolean;
  /** Identity a first provisioning binds, for the statements it delivers. */
  identity?: Identity;
  /** Anchors of an already verified bundle, for bundle-anchored purposes. */
  bundleKeys?: Map<string, KeyEntry>;
}

interface Verdict {
  reasons: string[];
  payload?: JsonObject;
  payloadBytes?: Buffer;
}

function decodedPayload(envelopeBytes: Buffer): Buffer {
  const envelope = asObject(JSON.parse(envelopeBytes.toString('utf8')) as Json, 'envelope');
  return Buffer.from(asString(envelope['payload'], 'payload'), 'base64');
}

function bundleKeysOf(payload: JsonObject): Map<string, KeyEntry> {
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

function envelopeUsable(envelope: JsonObject): boolean {
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

function verifyStatement(
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
          const version = (s: string): number[] => s.split('.').map(Number);
          const have = version(asString(osRelease['VERSION_ID'], 'VERSION_ID'));
          const need = version(asString(payload['min_os_version'], 'min_os_version'));
          const older = need.findIndex((n, k) => n !== (have[k] ?? 0));
          if (older >= 0 && (have[older] ?? 0) < (need[older] ?? 0)) fail('os-version-too-old');
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
          if (sha256(raw) !== anchor['keyid'] || seen.has(slot)) fail('anchor-invalid');
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

function contextOf(name: Json | undefined): JsonObject | null {
  return name === null || name === undefined
    ? null
    : asObject(CONTEXTS[asString(name, 'ctx')], String(name));
}

function inputsOf(value: Json | undefined): Inputs {
  const inputs = asObject(value, 'inputs');
  const file = (name: string): Buffer | undefined =>
    inputs[name] === undefined
      ? undefined
      : readFileSync(join(FIXTURES, asString(inputs[name], name)));
  const files = inputs['site_files'];
  return {
    release: file('release_statement'),
    trustAnchors: file('trust_anchors'),
    siteConfig: file('site_config'),
    rbac: file('rbac_manifest'),
    siteFiles:
      files === undefined
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

function runEntry(entry: JsonObject, allChecks: boolean): string[] {
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

function verifyDelivery(entry: JsonObject, allChecks: boolean): string[] {
  const document = readJson(join(FIXTURES, asString(entry['path'], 'path')));
  if (!validator('schemas/edge-provisioning-delivery.schema.json')(document))
    return ['schema-invalid'];
  const request = readJson(join(FIXTURES, asString(entry['request'], 'request')));
  const member = (name: string): Buffer => Buffer.from(JSON.stringify(document[name]), 'utf8');
  return verifyStatement(
    member('manifest'),
    ST_PROV,
    contextOf(entry['device_context']),
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
      requestNonce: asString(request['nonce'], 'nonce'),
    },
    { mode: 'accept', verifier: 'os-root', allChecks },
  ).reasons;
}

// ---------------------------------------------------------- reference unit check

interface ParsedUnit {
  sections: Map<string, Map<string, string[]>>;
  resets: Set<string>;
}

const PARSING = asObject(unitFile['parsing'], 'parsing');
const LIST_KEYS = new Set(strings(PARSING['list_keys'], 'list_keys'));
const ORDERED_KEYS = new Set(strings(PARSING['ordered_keys'], 'ordered_keys'));
const EMPTY_VALUE_KEYS = new Set(strings(PARSING['empty_value_keys'], 'empty_value_keys'));

function parseUnit(text: string): ParsedUnit {
  const sections = new Map<string, Map<string, string[]>>();
  const resets = new Set<string>();
  let current: Map<string, string[]> | undefined;
  let section = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? '';
      current = sections.get(section) ?? new Map<string, string[]>();
      sections.set(section, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current === undefined || eq <= 0) throw new Error(`unparseable unit line: ${line}`);
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value === '') {
      // systemd: an empty assignment resets everything accumulated for the key.
      current.set(name, []);
      if (!EMPTY_VALUE_KEYS.has(name)) resets.add(`${section}.${name}`);
      continue;
    }
    const values = current.get(name) ?? [];
    if (LIST_KEYS.has(name)) values.push(...value.split(/\s+/).filter((v) => v !== ''));
    else values.push(value);
    current.set(name, values);
  }
  return { sections, resets };
}

function sectionKeys(source: Json | undefined, section: string): string[] {
  if (source === undefined || source === null) return [];
  const block = asObject(source, 'section block')[section];
  if (block === undefined) return [];
  return Array.isArray(block) ? strings(block, section) : Object.keys(asObject(block, section));
}

function sectionValues(source: Json | undefined, section: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (source === undefined || source === null) return out;
  const block = asObject(source, 'section block')[section];
  if (block === undefined) return out;
  for (const [name, values] of Object.entries(asObject(block, section))) {
    out.set(name, strings(values, name));
  }
  return out;
}

function checkUnit(
  profile: string,
  unitText: string,
  dropinText: string | null,
  board: string | null,
): string[] {
  const violations = new Set<string>();
  const profileSpec = asObject(asObject(unitFile['profiles'], 'profiles')[profile], profile);
  const forbidden = objects(unitFile['forbidden'], 'forbidden').filter(
    (rule) =>
      rule['profiles'] === undefined || strings(rule['profiles'], 'profiles').includes(profile),
  );
  const keyLevelForbidden = new Set(
    forbidden
      .filter((rule) => rule['value_pattern'] === undefined)
      .map((rule) => `${rule['section']}.${rule['key']}`),
  );
  const applyForbidden = (section: string, name: string, values: string[]): void => {
    for (const rule of forbidden) {
      if (rule['section'] !== section || rule['key'] !== name) continue;
      const pattern = rule['value_pattern'];
      if (
        pattern === undefined ||
        values.some((v) => new RegExp(asString(pattern, 'pattern')).test(v))
      ) {
        violations.add(`forbidden:${section}.${name}`);
      }
    }
  };

  const unit = parseUnit(unitText);
  const guarded = new Set<string>();
  for (const section of ['Unit', 'Service', 'Install']) {
    const actual = unit.sections.get(section) ?? new Map<string, string[]>();
    const exact = new Map([
      ...sectionValues(unitFile['exact'], section),
      ...sectionValues(profileSpec['exact'], section),
    ]);
    const required = sectionValues(unitFile['required'], section);
    const present = sectionKeys(unitFile['present'], section);
    [...exact.keys(), ...required.keys(), ...present].forEach((name) =>
      guarded.add(`${section}.${name}`),
    );
    const allowed = new Set([
      ...exact.keys(),
      ...required.keys(),
      ...present,
      ...sectionKeys(unitFile['allowed'], section),
    ]);
    for (const [name, values] of actual) {
      if (keyLevelForbidden.has(`${section}.${name}`) || allowed.has(name))
        applyForbidden(section, name, values);
      else violations.add(`unknown:${section}.${name}`);
    }
    for (const [name, expected] of exact) {
      const have = actual.get(name) ?? [];
      const same = ORDERED_KEYS.has(name) ? sameSequence(have, expected) : sameSet(have, expected);
      if (!same) violations.add(`exact:${section}.${name}`);
    }
    for (const [name, expected] of required) {
      const have = new Set(actual.get(name) ?? []);
      if (!expected.every((v) => have.has(v))) violations.add(`required:${section}.${name}`);
    }
    for (const name of present) {
      if (!actual.has(name)) violations.add(`present:${section}.${name}`);
    }
  }
  for (const reset of unit.resets) if (guarded.has(reset)) violations.add(`reset:${reset}`);
  if ([...unit.sections.keys()].some((s) => !['Unit', 'Service', 'Install'].includes(s))) {
    violations.add('unknown:Unit.Section');
  }

  if (profile === 'suderra-os') {
    if (board === null || dropinText === null)
      throw new Error('suderra-os units need a board drop-in');
    const boards = asObject(
      asObject(profileSpec['board_dropins'], 'board_dropins')['boards'],
      'boards',
    );
    const expected = asObject(boards[board], board);
    const dropin = parseUnit(dropinText);
    for (const [section, keys] of dropin.sections) {
      for (const [name, values] of keys) {
        applyForbidden(section, name, values);
        const want = expected[name];
        if (section !== 'Service' || want === undefined || !sameSet(values, strings(want, name))) {
          violations.add(`dropin:${section}.${name}`);
        }
      }
    }
    for (const reset of dropin.resets) violations.add(`reset:${reset}`);
    for (const name of Object.keys(expected)) {
      if (!dropin.sections.get('Service')?.has(name)) violations.add(`dropin:Service.${name}`);
    }
  }
  return sorted(violations);
}

// ------------------------------------------------------------------- sources

function enumValues(file: string, enumName: string): string[] {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const body = new RegExp(`export enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/=\s*'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '');
}

/** Variant names of the agent's Permission enum and its two-person-integrity subset. */
function agentPermissions(): { all: string[]; twoPerson: string[] } {
  const source = readFileSync(join(REPO_ROOT, 'sens-api-gateway/src/authz/permission.rs'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  let body = /pub enum Permission \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  for (let previous = ''; previous !== body; ) {
    previous = body;
    body = body.replace(/\{[^{}]*\}/g, '');
  }
  const all = body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => /^([A-Z][A-Za-z0-9]*)$/.exec(part)?.[1] ?? `UNPARSED(${part})`);
  const fn =
    /fn requires_two_person_integrity\(&self\) -> bool \{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ??
    '';
  const twoPerson = [...fn.matchAll(/Self::([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1] ?? '');
  return { all, twoPerson };
}

function schemaPermissions(): string[] {
  const schema = readJson(join(CONTRACT, 'schemas', 'rbac-manifest.schema.json'));
  const permission = asObject(asObject(schema['$defs'], '$defs')['permission'], 'permission');
  const out: string[] = [];
  for (const branch of objects(permission['oneOf'], 'oneOf')) {
    if (branch['enum'] !== undefined) out.push(...strings(branch['enum'], 'enum'));
    else out.push(...strings(branch['required'], 'required'));
  }
  return out;
}

// ------------------------------------------------------------------------ specs

const statementEntries = objects(indexFile['statements'], 'statements');
const deliveryEntries = objects(indexFile['deliveries'], 'deliveries');

describe('suderra-edge contract v1 — integrity', () => {
  it('SHA256SUMS lists every file of the contract with a matching digest', () => {
    const lines = readFileSync(join(CONTRACT, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
    const listed = new Map<string, string>();
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/.exec(line);
      expect(match).not.toBeNull();
      listed.set(match?.[2] ?? '', match?.[1] ?? '');
    }
    const onDisk = listFiles(CONTRACT)
      .map(contractRel)
      .filter((rel) => rel !== 'SHA256SUMS');
    expect([...listed.keys()]).toEqual([...listed.keys()].sort());
    expect([...listed.keys()].sort()).toEqual(onDisk.sort());
    const drifted = onDisk.filter(
      (rel) => sha256(readFileSync(join(CONTRACT, rel))) !== listed.get(rel),
    );
    expect(drifted).toEqual([]);
  });

  it('git stores the contract bytes verbatim (no end-of-line conversion)', () => {
    const attributes = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'check-attr',
        'text',
        '--',
        `${CONTRACT_REL}/v1/SHA256SUMS`,
        `${CONTRACT_REL}/v1/statements.json`,
      ],
      { encoding: 'utf8' },
    );
    expect(
      attributes
        .trim()
        .split('\n')
        .map((line) => line.split(': ').pop()),
    ).toEqual(['unset', 'unset']);
  });

  it('no contract file matches a .gitignore rule, so every file SHA256SUMS lists is committed', () => {
    const files = listFiles(CONTRACT).map((path) => `${CONTRACT_REL}/v1/${contractRel(path)}`);
    const result = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '--no-index', '--stdin'], {
      input: files.join('\n'),
      encoding: 'utf8',
    });
    expect(result.status === 0 || result.status === 1).toBe(true);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([]);
  });

  it('VERSION is semver and its major matches the v1 directory', () => {
    const version = readFileSync(join(CONTRACT, 'VERSION'), 'utf8');
    expect(version).toMatch(/^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n$/);
  });

  it('every schema is 2020-12, named by its file, and every contract file validates', () => {
    for (const path of SCHEMA_FILES) {
      const schema = readJson(path);
      const name = contractRel(path)
        .replace(/^schemas\//, '')
        .replace(/\.schema\.json$/, '');
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['$id']).toBe(`${SCHEMA_ID_PREFIX}${name}`);
    }
    const documents: Array<[string, JsonObject]> = [
      ['schemas/statements.schema.json', statementsFile],
      ['schemas/boards.schema.json', boardsFile],
      ['schemas/artifact-naming.schema.json', namingFile],
      ['schemas/unit-directives.schema.json', unitFile],
      ['schemas/mutable-state.schema.json', mutableFile],
      ['schemas/delivery.schema.json', deliveryFile],
      ['schemas/lifecycle.schema.json', lifecycleFile],
      ['schemas/keyring.schema.json', keyringFile],
      ['schemas/fixture-index.schema.json', indexFile],
    ];
    for (const [schema, document] of documents) {
      const validate = validator(schema);
      expect({ schema, valid: validate(document), errors: validate.errors ?? [] }).toEqual({
        schema,
        valid: true,
        errors: [],
      });
    }
  });
});

describe('suderra-edge contract v1 — one vocabulary', () => {
  it('the statement registry is closed: payload types, purposes, reasons, nesting and verifier scopes', () => {
    const reasons = Object.keys(asObject(statementsFile['rejection_reasons'], 'rejection_reasons'));
    expect(VERIFICATION_ORDER.filter((r) => !reasons.includes(r))).toEqual([]);
    for (const [type, value] of Object.entries(STATEMENTS)) {
      const statement = asObject(value, type);
      const [, kind, version] = /^suderra\.([a-z0-9-]+)\.(v[0-9]+)$/.exec(type) ?? [];
      expect(statement['payload_type']).toBe(`application/vnd.suderra.${kind}.${version}+json`);
      expect(Object.keys(PURPOSES)).toContain(statement['signing_purpose']);
      expect(strings(statement['checks'], 'checks').filter((r) => !reasons.includes(r))).toEqual(
        [],
      );
      expect(
        strings(statement['nested'], 'nested').filter((t) => STATEMENTS[t] === undefined),
      ).toEqual([]);
      const own = allowedReasons(type, 'accept');
      for (const [verifier, scope] of Object.entries(
        asObject(statement['verified_by'], 'verified_by'),
      )) {
        const omits = strings(asObject(scope, verifier)['omits'], 'omits');
        expect({ type, verifier, foreign: omits.filter((r) => !own.has(r)) }).toEqual({
          type,
          verifier,
          foreign: [],
        });
      }
      const schema = readJson(join(CONTRACT, asString(statement['schema'], 'schema')));
      expect(
        asObject(asObject(schema['properties'], 'properties')['_type'], '_type')['const'],
      ).toBe(type);
    }
    for (const type of REVERIFIED) expect(STATEMENTS[type]).toBeDefined();
    [
      ...strings(REVERIFICATION['skipped_checks'], 's'),
      ...strings(REVERIFICATION['added_checks'], 'a'),
    ].forEach((r) => expect(reasons).toContain(r));
    for (const reason of Object.keys(
      asObject(asObject(statementsFile['compatibility'], 'c')['rules'], 'rules'),
    )) {
      expect(strings(spec(ST_RELEASE)['checks'], 'checks')).toContain(reason);
    }
  });

  it('the board enum, boards.json and the pending x86 family agree, and no board can carry tpm (DEC-21)', () => {
    const common = readJson(join(CONTRACT, 'schemas', 'common.schema.json'));
    const defs = asObject(common['$defs'], '$defs');
    expect(sorted(BOARD_BY_PROFILE.keys())).toEqual(
      sorted(strings(asObject(defs['board_profile'], 'b')['enum'], 'enum')),
    );
    expect(BOARD_BY_PROFILE.size).toBe(BOARDS.length);
    const features = strings(asObject(defs['cargo_feature'], 'cargo_feature')['enum'], 'enum');
    expect(features).not.toContain('tpm');
    const tpmDevice = objects(unitFile['forbidden'], 'forbidden').some(
      (rule) => rule['key'] === 'DeviceAllow' && String(rule['value_pattern']).includes('/dev/tpm'),
    );
    expect(tpmDevice).toBe(true);
    for (const row of [...BOARDS, ...PENDING_FAMILIES]) {
      const arch = asString(row['arch'], 'arch');
      expect(asString(row['rust_target'], 'rust_target').startsWith(`${arch}-`)).toBe(true);
      const rowFeatures = strings(row['cargo_features'], 'features');
      expect(rowFeatures).toEqual([...rowFeatures].sort());
      expect(rowFeatures).toContain('suderra-os');
    }
    for (const row of BOARDS) {
      expect(row['rauc_compatible']).toBe(`suderra-os-${asString(row['board_profile'], 'b')}`);
    }
    for (const family of PENDING_FAMILIES) {
      const pattern = new RegExp(asString(family['board_profile_pattern'], 'pattern'));
      expect([...BOARD_BY_PROFILE.keys()].filter((board) => pattern.test(board))).toEqual([]);
      const sample = asString(family['board_profile_template'], 'template').replace(
        '<model>',
        'model1',
      );
      expect(pattern.test(sample)).toBe(true);
      expect(asObject(family['cloud_provisioning'], 'gate')['allowed']).toBe(false);
    }
  });

  it('build-matrix images are classified once; the live matrix is checked by the vendored copy', () => {
    const images = [
      ...[...BOARDS, ...PENDING_FAMILIES].flatMap((row) => objects(row['os_images'], 'os_images')),
      ...objects(boardsFile['excluded_os_images'], 'excluded'),
    ].map(
      (o) =>
        `${asString(o['defconfig'], 'defconfig')} ${asString(o['build_target'], 'build_target')}`,
    );
    expect(new Set(images).size).toBe(images.length);
    expect(new Set(images.map((i) => i.split(' ')[0])).size).toBe(images.length);
    const vendorTest = readFileSync(
      join(REPO_ROOT, 'scripts/edge/vendor-contracts-to-suderra-os.sh'),
      'utf8',
    );
    expect(vendorTest).toContain('contracts-vendor-digest-test.sh');
  });

  it('USB payload families map onto boards', () => {
    const families = asObject(
      asObject(boardsFile['usb_payload_board_families'], 'usb')['families'],
      'families',
    );
    for (const [family, value] of Object.entries(families)) {
      const boards = strings(asObject(value, family)['boards'], 'boards');
      expect({ family, unknown: boards.filter((b) => !BOARD_BY_PROFILE.has(b)) }).toEqual({
        family,
        unknown: [],
      });
    }
  });

  it('every cloud DeviceModel maps to exactly one board or family or is explicitly unmapped', () => {
    const models = enumValues(
      'apps/sensor-service/src/edge-device/entities/edge-device.entity.ts',
      'DeviceModel',
    );
    expect(models.length).toBeGreaterThan(0);
    const mapped = [...BOARDS, ...PENDING_FAMILIES].flatMap((row) =>
      strings(row['cloud_device_models'], 'models'),
    );
    const unmapped = objects(boardsFile['unmapped_device_models'], 'unmapped').map((item) =>
      asString(item['device_model'], 'device_model'),
    );
    expect(new Set([...mapped, ...unmapped]).size).toBe(mapped.length + unmapped.length);
    expect(sorted([...mapped, ...unmapped])).toEqual(sorted(models));
  });

  it('the lifecycle states map one to one onto the cloud DeviceLifecycleState', () => {
    const common = readJson(join(CONTRACT, 'schemas', 'common.schema.json'));
    const osStates = strings(
      asObject(asObject(common['$defs'], 'd')['lifecycle_state'], 'l')['enum'],
      'enum',
    );
    expect(sorted(Object.keys(asObject(lifecycleFile['states'], 'states')))).toEqual(
      sorted(osStates),
    );
    const mapping = asObject(lifecycleFile['cloud_device_lifecycle'], 'cloud');
    const osToCloud = asObject(mapping['os_to_cloud'], 'os_to_cloud');
    expect(sorted(Object.keys(osToCloud))).toEqual(sorted(osStates));
    const cloud = enumValues(
      'apps/sensor-service/src/edge-device/entities/edge-device.entity.ts',
      'DeviceLifecycleState',
    );
    const covered = [
      ...Object.values(osToCloud).map((v) => asString(v, 'cloud state')),
      ...objects(mapping['cloud_only'], 'cloud_only').map((c) => asString(c['state'], 'state')),
    ];
    expect(new Set(covered).size).toBe(covered.length);
    expect(sorted(covered)).toEqual(sorted(cloud));
    for (const transition of objects(lifecycleFile['transitions'], 'transitions')) {
      if (transition['statement_type'] !== undefined) {
        expect(STATEMENTS[asString(transition['statement_type'], 'type')]).toBeDefined();
      }
    }
  });

  it('the RBAC permission vocabulary is the agent Permission enum minus its two-person-integrity set (DEC-9.4)', () => {
    const { all, twoPerson } = agentPermissions();
    expect(all.filter((name) => name.startsWith('UNPARSED'))).toEqual([]);
    expect(twoPerson.length).toBeGreaterThan(0);
    expect(twoPerson.filter((name) => !all.includes(name))).toEqual([]);
    expect(sorted(schemaPermissions())).toEqual(
      sorted(all.filter((name) => !twoPerson.includes(name))),
    );
  });

  it('result reasons per kind are the codes of the statements that kind verifies plus its operational codes', () => {
    const doc = asObject(
      asObject(statementsFile['unsigned_documents'], 'u')['suderra.result.v1'],
      'result',
    );
    const byKind = asObject(doc['reasons_by_kind'], 'reasons_by_kind');
    const operational = Object.keys(asObject(doc['operational_reasons'], 'operational_reasons'));
    const schema = readJson(join(CONTRACT, 'schemas', 'result.schema.json'));
    const kinds = strings(
      asObject(asObject(schema['properties'], 'p')['kind'], 'kind')['enum'],
      'enum',
    );
    expect(sorted(Object.keys(byKind))).toEqual(sorted(kinds));
    const fromSchema = new Map(
      objects(schema['allOf'], 'allOf').map((branch) => [
        asString(
          asObject(asObject(asObject(branch['if'], 'if')['properties'], 'p')['kind'], 'k')['const'],
          'kind',
        ),
        strings(
          asObject(asObject(asObject(branch['then'], 'then')['properties'], 'p')['reason'], 'r')[
            'enum'
          ],
          'enum',
        ),
      ]),
    );
    for (const [kind, value] of Object.entries(byKind)) {
      const entry = asObject(value, kind);
      const expected = new Set<string>();
      for (const type of strings(entry['statements'], 'statements')) {
        allowedReasons(type, entry['reverification'] === true ? 'reverify' : 'accept').forEach(
          (r) => {
            if (
              strings(spec(type)['checks'], 'c').includes(r) ||
              VERIFICATION_ORDER.includes(r) ||
              r === 'installed-digest-mismatch'
            ) {
              expected.add(r);
            }
          },
        );
      }
      for (const code of strings(entry['operational'], 'operational')) {
        expect(operational).toContain(code);
        expected.add(code);
      }
      expect({ kind, reasons: sorted(fromSchema.get(kind) ?? []) }).toEqual({
        kind,
        reasons: sorted(expected),
      });
    }
  });

  it('the frozen generic-Linux release slugs and inner binary name are still published (DEC-28)', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/edge-agent-release.yml'),
      'utf8',
    );
    const generic = asObject(namingFile['generic_channel'], 'generic_channel');
    const published = new Set(
      [...workflow.matchAll(/-\s*target:\s*(\S+)\s*\n\s*target_slug:\s*(\S+)/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    );
    for (const slug of objects(generic['slugs'], 'slugs')) {
      expect(published).toContain(
        `${asString(slug['rust_target'], 'rust_target')} ${asString(slug['slug'], 'slug')}`,
      );
    }
    expect(/ARCHIVE_BINARY_NAME:\s*(\S+)/.exec(workflow)?.[1]).toBe(generic['binary_name']);
  });

  it('the agent unit writes exactly the agent-owned rows of the mutable-state table', () => {
    const entries = objects(mutableFile['entries'], 'entries');
    const paths = entries.map((e) => asString(e['path'], 'path'));
    expect(new Set(paths).size).toBe(paths.length);
    const byAccess = (access: string): string[] =>
      entries.filter((e) => e['agent_access'] === access).map((e) => asString(e['path'], 'path'));
    const profile = asObject(
      asObject(unitFile['profiles'], 'profiles')['suderra-os'],
      'suderra-os',
    );
    const service = sectionValues(profile['exact'], 'Service');
    expect(sorted(service.get('ReadWritePaths') ?? [])).toEqual(sorted(byAccess('read-write')));
    expect(sorted(service.get('ReadOnlyPaths') ?? [])).toEqual(sorted(byAccess('read-only-bind')));
    for (const entry of entries.filter((e) => e['writer'] === 'agent'))
      expect(entry['owner']).toBe('suderra');
    const dropins = asObject(
      asObject(profile['board_dropins'], 'board_dropins')['boards'],
      'boards',
    );
    expect(sorted(Object.keys(dropins))).toEqual(sorted(BOARD_BY_PROFILE.keys()));
    const hooks = asObject(unitFile['hooks'], 'hooks');
    expect(service.get('ExecReload')).toEqual(
      strings(asObject(hooks['reload'], 'reload')['sequence'], 'sequence'),
    );
    expect(service.get('ExecStartPre')).toEqual([
      `+${asString(asObject(hooks['verify_current'], 'v')['command'], 'c')}`,
    ]);
  });

  it('delivery.json names the request and delivery schemas and their document types', () => {
    const network = asObject(deliveryFile['network'], 'network');
    const request = validator(
      asString(asObject(network['request'], 'request')['query_schema'], 'q'),
    );
    const response = validator(asString(asObject(network['response'], 'response')['schema'], 's'));
    expect(request).toBeDefined();
    const schema = readJson(join(CONTRACT, 'schemas', 'edge-provisioning-delivery.schema.json'));
    expect(asObject(asObject(schema['properties'], 'p')['_type'], '_type')['const']).toBe(
      deliveryFile['delivery_type'],
    );
    expect(response).toBeDefined();
  });
});

describe('suderra-edge contract v1 — TEST-ONLY keys', () => {
  const allKeys = [
    ...objects(keyringFile['keys'], 'keys'),
    ...objects(keyringFile['unanchored_keys'], 'unanchored_keys'),
  ];

  it('every key and the MQTT CA are re-derived from their published TEST-ONLY seed labels', () => {
    expect(keyringFile['test_only']).toBe(true);
    const keyFiles = new Set<string>();
    for (const key of allKeys) {
      const label = asString(key['seed_label'], 'seed_label');
      expect(label.startsWith(SEED_PREFIX)).toBe(true);
      const derived = deriveTestKey(label);
      expect(asString(key['public_key'], 'public_key')).toBe(derived.raw.toString('base64'));
      expect(key['keyid']).toBe(sha256(derived.raw));
      if (key['path'] === undefined) continue;
      const purpose = asString(key['purpose'], 'purpose');
      expect(label).toBe(`${SEED_PREFIX}${purpose}:${asNumber(key['epoch'], 'epoch')}`);
      const path = asString(key['path'], 'path');
      keyFiles.add(path);
      const file = readFileSync(join(CONTRACT, path), 'utf8');
      expect(file.startsWith('TEST-ONLY public key')).toBe(true);
      expect(file.endsWith(derived.pem)).toBe(true);
      const anchoredIn = strings(
        asObject(PURPOSES[purpose], purpose)['anchored_in'],
        'anchored_in',
      );
      expect(key['fixture_anchor']).toBe(
        anchoredIn.includes('os-image') ? 'os-image' : 'trust-anchors-bundle',
      );
    }
    const onDisk = listFiles(join(CONTRACT, 'test-keys')).map(contractRel);
    expect(onDisk.sort()).toEqual([...keyFiles, 'test-keys/keyring.json'].sort());
    // Flat TEST-ONLY names, never the OS pin layout <purpose>/<epoch>.pub.
    const unmarked = onDisk.filter(
      (rel) =>
        rel !== 'test-keys/keyring.json' &&
        !/^test-keys\/[a-z0-9-]+-[0-9]+\.TEST-ONLY\.pub$/.test(rel),
    );
    expect(unmarked).toEqual([]);

    for (const ca of objects(keyringFile['mqtt_ca'], 'mqtt_ca')) {
      const pem = asString(ca['certificate'], 'certificate');
      expect(ca['certificate_sha256']).toBe(sha256(pem));
      const cert = new X509Certificate(pem);
      const derived = deriveTestKey(asString(ca['seed_label'], 'seed_label'));
      const spki = cert.publicKey.export({ format: 'der', type: 'spki' });
      expect(Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length))).toEqual(derived.raw);
      expect(cert.ca).toBe(true);
      expect(cert.subject).toContain('TEST-ONLY');
      expect(cert.verify(cert.publicKey)).toBe(true);
    }
  });

  it('no TEST-ONLY key material appears in this repository outside the contract directory', () => {
    const needles = new Set<string>();
    for (const key of allKeys) {
      const derived = deriveTestKey(asString(key['seed_label'], 'seed_label'));
      needles.add(asString(key['seed_label'], 'seed_label'));
      needles.add(asString(key['keyid'], 'keyid'));
      needles.add(derived.raw.toString('base64'));
      needles.add(derived.raw.toString('hex'));
      needles.add(derived.spkiBase64);
      needles.add(derived.seed.toString('hex'));
      needles.add(derived.seed.toString('base64'));
    }
    for (const ca of objects(keyringFile['mqtt_ca'], 'mqtt_ca')) {
      const derived = deriveTestKey(asString(ca['seed_label'], 'seed_label'));
      needles.add(asString(ca['certificate_sha256'], 'sha'));
      needles.add(derived.raw.toString('base64'));
      needles.add(derived.seed.toString('hex'));
      const body = asString(ca['certificate'], 'certificate').split('\n')[1] ?? '';
      needles.add(body);
    }
    const args = ['-C', REPO_ROOT, 'grep', '-l', '-F'];
    for (const needle of needles) args.push('-e', needle);
    args.push('--', '.', `:(exclude)${CONTRACT_REL}`, `:(exclude)${THIS_SPEC}`);
    const result = spawnSync('git', args, { encoding: 'utf8' });
    expect(result.status === 0 || result.status === 1).toBe(true);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([]);
  });
});

describe('suderra-edge contract v1 — golden fixtures', () => {
  it('the index is TEST-ONLY and references every fixture file, each one existing', () => {
    expect(indexFile['test_only']).toBe(true);
    const referenced = new Set<string>([
      'index.json',
      asString(indexFile['pae_vectors'], 'pae_vectors'),
      asString(indexFile['signature_vectors'], 'signature_vectors'),
    ]);
    for (const entry of statementEntries) {
      referenced.add(asString(entry['path'], 'path'));
      const inputs = asObject(entry['inputs'], 'inputs');
      for (const [name, value] of Object.entries(inputs)) {
        if (name === 'site_files')
          Object.values(asObject(value, name)).forEach((v) => referenced.add(asString(v, 'file')));
        else if (name !== 'request_nonce') referenced.add(asString(value, name));
      }
    }
    for (const entry of deliveryEntries) {
      referenced.add(asString(entry['path'], 'path'));
      referenced.add(asString(entry['request'], 'request'));
    }
    for (const entry of objects(indexFile['documents'], 'documents'))
      referenced.add(asString(entry['path'], 'path'));
    for (const unit of objects(indexFile['units'], 'units')) {
      referenced.add(asString(unit['unit'], 'unit'));
      if (typeof unit['dropin'] === 'string') referenced.add(unit['dropin']);
    }
    for (const ctx of Object.values(CONTEXTS)) {
      const installed = asObject(ctx, 'ctx')['installed_manifest'];
      if (typeof installed === 'string') referenced.add(installed);
    }
    const onDisk = listFiles(FIXTURES).map((path) =>
      relative(FIXTURES, path).split('\\').join('/'),
    );
    expect(onDisk.sort()).toEqual([...referenced].sort());
  });

  it('PAE vectors match DSSE v1 byte for byte', () => {
    const file = readJson(join(FIXTURES, asString(indexFile['pae_vectors'], 'pae_vectors')));
    for (const vector of objects(file['vectors'], 'vectors')) {
      const body = Buffer.from(asString(vector['payload'], 'payload'), 'base64');
      expect(pae(asString(vector['payload_type'], 'payload_type'), body).toString('hex')).toBe(
        vector['pae_hex'],
      );
    }
    expect(pae('http://example.com/HelloWorld', Buffer.from('hello world')).toString('utf8')).toBe(
      'DSSEv1 29 http://example.com/HelloWorld 11 hello world',
    );
  });

  it('signature vectors pin verify_strict semantics, including small-order R and non-canonical A and R', () => {
    const file = readJson(
      join(FIXTURES, asString(indexFile['signature_vectors'], 'signature_vectors')),
    );
    const ids: string[] = [];
    for (const vector of objects(file['vectors'], 'vectors')) {
      ids.push(asString(vector['id'], 'id'));
      const outcome = verifyStrict(
        Buffer.from(asString(vector['public_key_hex'], 'pk'), 'hex'),
        Buffer.from(asString(vector['message_hex'], 'msg'), 'hex'),
        Buffer.from(asString(vector['signature_hex'], 'sig'), 'hex'),
      );
      expect({ id: vector['id'], outcome }).toEqual({
        id: vector['id'],
        outcome: vector['verify_strict'],
      });
    }
    expect(ids).toEqual(
      expect.arrayContaining(['small-order-r', 'non-canonical-r', 'non-canonical-a']),
    );
  });

  it.each(
    statementEntries.map((e) => [
      asString(e['path'], 'path'),
      `${asString(e['statement_type'], 't')} ${asString(e['device_context'] ?? 'none', 'ctx')} ${asString(e['verifier'], 'v')} ${asString(e['mode'], 'm')}`,
      e,
    ]),
  )('%s at %s reaches its labelled verdict, and carries one defect', (_path, _site, entry) => {
    const expected = entry['expect'] === 'accept' ? [] : [asString(entry['reason'], 'reason')];
    expect(runEntry(entry, false)).toEqual(expected);
    expect(runEntry(entry, true)).toEqual(expected);
    if (entry['expect'] === 'reject') {
      const allowed = allowedReasons(
        asString(entry['statement_type'], 't'),
        asString(entry['mode'], 'm'),
      );
      expect(allowed.has(asString(entry['reason'], 'reason'))).toBe(true);
    }
  });

  it('every (statement, reason) pair has a one-defect negative fixture, and every re-verified type both outcomes', () => {
    const missing: string[] = [];
    for (const type of Object.keys(STATEMENTS)) {
      const of = statementEntries.filter(
        (e) =>
          e['statement_type'] === type && e['verifier'] === 'os-root' && e['mode'] === 'accept',
      );
      if (!of.some((e) => e['expect'] === 'accept')) missing.push(`${type} accept`);
      const have = new Set(
        of.filter((e) => e['expect'] === 'reject').map((e) => asString(e['reason'], 'reason')),
      );
      for (const reason of [...VERIFICATION_ORDER, ...strings(spec(type)['checks'], 'checks')]) {
        if (!have.has(reason)) missing.push(`${type} ${reason}`);
      }
    }
    for (const type of REVERIFIED) {
      const of = statementEntries.filter(
        (e) => e['statement_type'] === type && e['mode'] === 'reverify',
      );
      if (!of.some((e) => e['expect'] === 'accept')) missing.push(`${type} reverify accept`);
      if (!of.some((e) => e['reason'] === 'installed-digest-mismatch'))
        missing.push(`${type} installed-digest-mismatch`);
    }
    expect(missing).toEqual([]);
  });

  it.each(deliveryEntries.map((e) => [asString(e['path'], 'path'), e]))(
    'delivery %s verifies end to end as labelled',
    (_path, entry) => {
      const expected = entry['expect'] === 'accept' ? [] : [asString(entry['reason'], 'reason')];
      expect(verifyDelivery(entry, false)).toEqual(expected);
      expect(verifyDelivery(entry, true)).toEqual(expected);
    },
  );

  it('result and request documents validate or fail exactly as labelled', () => {
    for (const entry of objects(indexFile['documents'], 'documents')) {
      const path = asString(entry['path'], 'path');
      const type = asString(entry['document_type'], 'document_type');
      const schema =
        type === 'suderra.result.v1'
          ? 'schemas/result.schema.json'
          : 'schemas/edge-provisioning-request.schema.json';
      let reasons: string[] = [];
      try {
        const document = asObject(
          parseStrictJson(UTF8.decode(readFileSync(join(FIXTURES, path)))),
          path,
        );
        if (!validator(schema)(document)) reasons = ['schema-invalid'];
      } catch {
        reasons = ['payload-json-invalid'];
      }
      const expected = entry['expect'] === 'accept' ? [] : [asString(entry['reason'], 'reason')];
      expect({ path, reasons }).toEqual({ path, reasons: expected });
    }
  });

  it('golden units satisfy the directive allowlist, and each broken unit fails for exactly its labelled rules', () => {
    for (const entry of objects(indexFile['units'], 'units')) {
      const dropin =
        typeof entry['dropin'] === 'string'
          ? readFileSync(join(FIXTURES, entry['dropin']), 'utf8')
          : null;
      const violations = checkUnit(
        asString(entry['profile'], 'profile'),
        readFileSync(join(FIXTURES, asString(entry['unit'], 'unit')), 'utf8'),
        dropin,
        entry['board_profile'] === null ? null : asString(entry['board_profile'], 'board'),
      );
      const expected =
        entry['expect'] === 'accept' ? [] : sorted(strings(entry['violations'], 'violations'));
      expect({ unit: entry['unit'], dropin: entry['dropin'], violations }).toEqual({
        unit: entry['unit'],
        dropin: entry['dropin'],
        violations: expected,
      });
    }
  });

  it('the key-unknown fixtures are signed by the published unanchored key, which no key file holds', () => {
    const unpinned = sha256(deriveTestKey(`${SEED_PREFIX}unpinned:1`).raw);
    expect(objects(keyringFile['unanchored_keys'], 'u').map((k) => k['keyid'])).toContain(unpinned);
    const envelope = readJson(join(FIXTURES, 'edge-provisioning/invalid/unknown-keyid.dsse.json'));
    const signature = asObject(asArray(envelope['signatures'], 'signatures')[0], 'signature');
    expect(signature['keyid']).toBe(unpinned);
    expect(existsSync(join(CONTRACT, 'test-keys', 'unpinned-1.TEST-ONLY.pub'))).toBe(false);
  });
});
