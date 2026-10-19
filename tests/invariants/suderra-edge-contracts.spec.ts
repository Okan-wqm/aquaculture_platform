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
 *      DeviceModel enum, the Suderra-OS build-matrix rows, the generic release
 *      slugs, the unit's writable paths and the mutable-state table.
 *   4. Every TEST-ONLY key is re-derived from its published seed label, so no
 *      fixture can be signed by a key anyone holds privately.
 *   5. A reference verifier (DSSE PAE, Ed25519 with verify_strict semantics,
 *      strict JSON, schema, statement checks) reaches exactly the verdict and
 *      the reason each fixture is labelled with; the reference unit checker
 *      does the same for the golden units.
 *
 * Regenerate fixtures with `python3 -B contracts/suderra-edge/v1/tools/generate.py`
 * and vendor with `scripts/edge/vendor-contracts-to-suderra-os.sh`.
 */
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
const CONTRACT = join(REPO_ROOT, 'contracts', 'suderra-edge', 'v1');
const FIXTURES = join(CONTRACT, 'fixtures');
const SCHEMA_ID_PREFIX = 'urn:suderra:edge-contract:v1:schema:';
const SEED_PREFIX = 'suderra-edge-contract:v1:TEST-ONLY:';

/**
 * Suderra-OS ci/build-matrix.yml rows as of Suderra-OS 28ca959. The vendored
 * copy's contracts-vendor-digest-test.sh checks boards.json against the live
 * matrix in Suderra-OS; this snapshot keeps the source side honest.
 */
const SUDERRA_OS_BUILD_MATRIX: ReadonlyArray<readonly [string, string]> = [
  ['suderra_qemu_x86_64_defconfig', 'qemu-x86_64'],
  ['suderra_x86_64_defconfig', 'x86_64'],
  ['suderra_qemu_x86_64_prod_ab_defconfig', 'qemu-x86_64-prod-ab'],
  ['suderra_aarch64_defconfig', 'generic-aarch64-template'],
  ['suderra_aarch64_rpi4_defconfig', 'rpi4'],
  ['suderra_aarch64_rpi4_usb_installer_defconfig', 'pi-cm4-revpi-usb-installer'],
  ['suderra_aarch64_revpi4_defconfig', 'revpi4'],
  ['suderra_aarch64_rpi4_prod_ab_defconfig', 'rpi4-prod-ab'],
  ['suderra_aarch64_revpi4_prod_ab_defconfig', 'revpi4-prod-ab'],
];

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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
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

function deepEqual(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ------------------------------------------------------------ strict JSON parse

/**
 * RFC 8259 parser that rejects duplicate member names. JSON.parse keeps the last
 * duplicate silently, which is precisely the parser differential the
 * duplicate-member fixture exploits.
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
  const value = (): Json => {
    skipWs();
    const c = text.charAt(i);
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return JSON.parse(token(STRING)) as string;
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
    return Number(token(NUMBER));
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
      const name = JSON.parse(token(STRING)) as string;
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

// ------------------------------------------------------------- Ed25519 strict

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
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

function verifyStrict(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (littleEndian(signature.subarray(32)) >= ED25519_L) return false;
  if (isSmallOrder(publicKey) || isSmallOrder(signature.subarray(0, 32))) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

function deriveTestKey(seedLabel: string): { raw: Buffer; pem: string } {
  const seed = createHash('sha256').update(seedLabel, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    raw: Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)),
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
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
const keyringFile = readJson(join(CONTRACT, 'test-keys', 'keyring.json'));
const indexFile = readJson(join(FIXTURES, 'index.json'));

const STATEMENTS = asObject(statementsFile['statements'], 'statements');
const BOARDS = asArray(boardsFile['boards'], 'boards').map((row) => asObject(row, 'board'));
const BOARD_BY_PROFILE = new Map(
  BOARDS.map((row) => [asString(row['board_profile'], 'board'), row]),
);
const EVALUATION_TIME = asString(indexFile['evaluation_time'], 'evaluation_time');
const CONTEXTS = asObject(indexFile['device_contexts'], 'device_contexts');

interface PinnedKey {
  purpose: string;
  epoch: number;
  raw: Buffer;
  osPinned: boolean;
}

const PINNED = new Map<string, PinnedKey>(
  asArray(keyringFile['keys'], 'keys').map((entry) => {
    const key = asObject(entry, 'key');
    return [
      asString(key['keyid'], 'keyid'),
      {
        purpose: asString(key['purpose'], 'purpose'),
        epoch: asNumber(key['epoch'], 'epoch'),
        raw: Buffer.from(asString(key['public_key'], 'public_key'), 'base64'),
        osPinned: key['os_pinned'] === true,
      },
    ];
  }),
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

// ---------------------------------------------------------- reference verifier

interface Verdict {
  stage: 'envelope' | 'semantic';
  reasons: string[];
  payload?: JsonObject;
  payloadBytes?: Buffer;
}

interface Inputs {
  release_statement?: string;
  config_payload?: string;
  trust_anchors?: string;
  request_nonce?: string;
}

function toInputs(value: Json | undefined): Inputs {
  const inputs = asObject(value, 'inputs');
  const field = (name: string): string | undefined =>
    inputs[name] === undefined ? undefined : asString(inputs[name], name);
  return {
    release_statement: field('release_statement'),
    config_payload: field('config_payload'),
    trust_anchors: field('trust_anchors'),
    request_nonce: field('request_nonce'),
  };
}

function readEnvelopeBytes(rel: string): Buffer {
  return readFileSync(join(FIXTURES, rel));
}

function payloadDigest(rel: string): string {
  const envelope = asObject(parseStrictJson(readEnvelopeBytes(rel).toString('utf8')), rel);
  return sha256(Buffer.from(asString(envelope['payload'], 'payload'), 'base64'));
}

function rejectAt(reason: string): Verdict {
  return { stage: 'envelope', reasons: [reason] };
}

function verifyStatement(
  envelopeBytes: Buffer,
  statementType: string,
  contextName: string | null,
  inputs: Inputs,
  tenantForScope?: string,
): Verdict {
  const spec = asObject(STATEMENTS[statementType], statementType);
  const context = contextName === null ? null : asObject(CONTEXTS[contextName], contextName);

  let envelope: JsonObject;
  try {
    envelope = asObject(parseStrictJson(envelopeBytes.toString('utf8')), 'envelope');
  } catch {
    return rejectAt('envelope-invalid');
  }
  if (!validator('schemas/dsse-envelope.schema.json')(envelope))
    return rejectAt('envelope-invalid');
  const payloadType = asString(envelope['payloadType'], 'payloadType');
  if (payloadType !== asString(spec['payload_type'], 'payload_type')) {
    return rejectAt('payload-type-mismatch');
  }
  const signature = asObject(asArray(envelope['signatures'], 'signatures')[0], 'signature');
  const key = PINNED.get(asString(signature['keyid'], 'keyid'));
  if (key === undefined) return rejectAt('key-unknown');
  if (key.purpose !== asString(spec['signing_purpose'], 'signing_purpose')) {
    return rejectAt('key-purpose-mismatch');
  }
  const ratchet =
    context === null ? undefined : asObject(context['ratchet'], 'ratchet')[key.purpose];
  if (typeof ratchet === 'number' && key.epoch < ratchet)
    return rejectAt('key-epoch-below-ratchet');
  const payloadBytes = Buffer.from(asString(envelope['payload'], 'payload'), 'base64');
  const sig = Buffer.from(asString(signature['sig'], 'sig'), 'base64');
  if (!verifyStrict(key.raw, pae(payloadType, payloadBytes), sig))
    return rejectAt('signature-invalid');

  let payload: JsonObject;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payloadBytes);
    payload = asObject(parseStrictJson(text), 'payload');
  } catch {
    return rejectAt('payload-json-invalid');
  }
  if (!validator(asString(spec['schema'], 'schema'))(payload)) return rejectAt('schema-invalid');

  const reasons = new Set<string>();
  const now = EVALUATION_TIME;
  const window = (): void => {
    if (now < asString(payload['not_before'], 'not_before')) reasons.add('not-yet-valid');
    if (now >= asString(payload['expires_at'], 'expires_at')) reasons.add('expired');
  };
  const deviceBound = (): void => {
    if (context === null) throw new Error(`${statementType} needs a device context`);
    if (!deepEqual(payload['device_binding'] as Json, context['device_binding'] as Json)) {
      reasons.add('device-binding-mismatch');
    }
    if (context['device_id'] !== null && payload['device_id'] !== context['device_id']) {
      reasons.add('device-id-mismatch');
    }
    if (context['tenant_id'] !== null && payload['tenant_id'] !== context['tenant_id']) {
      reasons.add('tenant-mismatch');
    }
  };
  const sequence = (field: string): void => {
    if (context === null) return;
    const last = asObject(context['sequences'], 'sequences')[statementType];
    if (typeof last === 'number' && asNumber(payload[field], field) <= last) {
      reasons.add('sequence-replay');
    }
  };
  const boardCheck = (board: string, arch: string): void => {
    if (context === null) return;
    if (board !== context['board_profile']) reasons.add('board-mismatch');
    if (arch !== context['arch']) reasons.add('arch-mismatch');
  };

  switch (statementType) {
    case 'suderra.edge-release.v1': {
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
        reasons.add('release-profile-mismatch');
      }
      boardCheck(board, asString(payload['arch'], 'arch'));
      break;
    }
    case 'suderra.edge-provisioning.v2': {
      if (asNumber(payload['key_epoch'], 'key_epoch') !== key.epoch)
        reasons.add('key-epoch-mismatch');
      window();
      deviceBound();
      if (payload['nonce'] !== inputs.request_nonce) reasons.add('nonce-mismatch');
      boardCheck(asString(payload['board'], 'board'), asString(payload['arch'], 'arch'));
      if (
        context !== null &&
        asNumber(payload['security_version'], 'sv') <
          asNumber(context['security_version_floor'], 'floor')
      ) {
        reasons.add('rollback-below-floor');
      }
      sequence('update_seq');

      const releaseRel = asString(inputs.release_statement, 'inputs.release_statement');
      const release = verifyStatement(
        readEnvelopeBytes(releaseRel),
        'suderra.edge-release.v1',
        contextName,
        {},
      );
      if (release.payload === undefined || release.payloadBytes === undefined) {
        throw new Error(
          `release input ${releaseRel} does not verify: ${release.reasons.join(',')}`,
        );
      }
      release.reasons.forEach((reason) => reasons.add(reason));
      const releaseRef = asObject(payload['release_statement'], 'release_statement');
      if (asObject(releaseRef['digest'], 'digest')['sha256'] !== sha256(release.payloadBytes)) {
        reasons.add('release-digest-mismatch');
      }
      const r = release.payload;
      if (
        payload['version'] !== r['version'] ||
        payload['board'] !== r['board_profile'] ||
        payload['arch'] !== r['arch'] ||
        payload['security_version'] !== r['security_version'] ||
        payload['agent_profile'] !== r['agent_profile']
      ) {
        reasons.add('release-mismatch');
      }

      const config = readFileSync(
        join(FIXTURES, asString(inputs.config_payload, 'inputs.config_payload')),
      );
      const configRef = asObject(payload['config_payload'], 'config_payload');
      if (
        asObject(configRef['digest'], 'digest')['sha256'] !== sha256(config) ||
        configRef['size_bytes'] !== config.length
      ) {
        reasons.add('config-digest-mismatch');
      }

      // The bundle must serve the device's tenant: the bound one, or on first
      // provisioning the one this manifest is about to bind (DEC-22).
      const taRel = asString(inputs.trust_anchors, 'inputs.trust_anchors');
      const bound = context === null ? null : context['tenant_id'];
      const tenant =
        typeof bound === 'string' ? bound : asString(payload['tenant_id'], 'tenant_id');
      const ta = verifyStatement(
        readEnvelopeBytes(taRel),
        'suderra.trust-anchors.v1',
        contextName,
        {},
        tenant,
      );
      if (ta.payload === undefined || ta.payloadBytes === undefined) {
        throw new Error(`trust-anchor input ${taRel} does not verify: ${ta.reasons.join(',')}`);
      }
      ta.reasons.forEach((reason) => reasons.add(reason));
      const taRef = asObject(payload['trust_anchors'], 'trust_anchors');
      if (
        asObject(taRef['digest'], 'digest')['sha256'] !== sha256(ta.payloadBytes) ||
        taRef['bundle_seq'] !== ta.payload['bundle_seq']
      ) {
        reasons.add('trust-anchors-digest-mismatch');
      }
      break;
    }
    case 'suderra.edge-activation-receipt.v1': {
      window();
      deviceBound();
      const installed = context === null ? null : context['installed_manifest'];
      const manifestDigest = asObject(payload['manifest_digest'], 'manifest_digest')['sha256'];
      if (typeof installed !== 'string' || manifestDigest !== payloadDigest(installed)) {
        reasons.add('manifest-digest-mismatch');
      }
      break;
    }
    case 'suderra.trust-anchors.v1': {
      const tenant = tenantForScope ?? (context === null ? null : context['tenant_id']);
      if (
        typeof tenant === 'string' &&
        !strings(payload['tenant_scope'], 'scope').includes(tenant)
      ) {
        reasons.add('tenant-scope-mismatch');
      }
      sequence('bundle_seq');
      const seen = new Set<string>();
      for (const item of asArray(payload['anchors'], 'anchors')) {
        const anchor = asObject(item, 'anchor');
        if (anchor['algorithm'] !== 'ed25519') continue;
        const purpose = asString(anchor['purpose'], 'purpose');
        const epoch = asNumber(anchor['epoch'], 'epoch');
        const raw = Buffer.from(asString(anchor['public_key'], 'public_key'), 'base64');
        const slot = `${purpose}/${epoch}`;
        if (sha256(raw) !== anchor['keyid'] || seen.has(slot)) reasons.add('anchor-invalid');
        seen.add(slot);
        if (purpose === 'edge-release' || purpose === 'edge-provisioning') {
          const pinned = PINNED.get(asString(anchor['keyid'], 'keyid'));
          if (
            pinned === undefined ||
            !pinned.osPinned ||
            pinned.purpose !== purpose ||
            pinned.epoch !== epoch
          ) {
            reasons.add('anchor-not-os-pinned');
          }
        }
      }
      break;
    }
    case 'suderra.device-lifecycle.v1': {
      window();
      deviceBound();
      sequence('update_seq');
      break;
    }
    default:
      throw new Error(`no statement checks for ${statementType}`);
  }
  return { stage: 'semantic', reasons: [...reasons].sort(), payload, payloadBytes };
}

// ---------------------------------------------------------- reference unit check

type UnitMap = Map<string, Map<string, string[]>>;

const LIST_KEYS = new Set(
  strings(asObject(unitFile['parsing'], 'parsing')['list_keys'], 'list_keys'),
);

function parseUnit(text: string): UnitMap {
  const sections: UnitMap = new Map();
  let current: Map<string, string[]> | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header !== null) {
      const name = header[1] ?? '';
      current = sections.get(name) ?? new Map<string, string[]>();
      sections.set(name, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current === undefined || eq <= 0) throw new Error(`unparseable unit line: ${line}`);
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const values = current.get(name) ?? [];
    if (LIST_KEYS.has(name)) values.push(...value.split(/\s+/).filter((v) => v !== ''));
    else if (value !== '') values.push(value);
    current.set(name, values);
  }
  return sections;
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
  const forbidden = asArray(unitFile['forbidden'], 'forbidden')
    .map((rule) => asObject(rule, 'rule'))
    .filter(
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
  for (const section of ['Unit', 'Service', 'Install']) {
    const actual = unit.get(section) ?? new Map<string, string[]>();
    const exact = new Map([
      ...sectionValues(unitFile['exact'], section),
      ...sectionValues(profileSpec['exact'], section),
    ]);
    const required = sectionValues(unitFile['required'], section);
    const allowed = new Set([
      ...exact.keys(),
      ...required.keys(),
      ...sectionKeys(unitFile['present'], section),
      ...sectionKeys(unitFile['allowed'], section),
    ]);
    for (const [name, values] of actual) {
      if (keyLevelForbidden.has(`${section}.${name}`) || allowed.has(name))
        applyForbidden(section, name, values);
      else violations.add(`unknown:${section}.${name}`);
    }
    for (const [name, expected] of exact) {
      if (!sameSet(actual.get(name) ?? [], expected)) violations.add(`exact:${section}.${name}`);
    }
    for (const [name, expected] of required) {
      const have = new Set(actual.get(name) ?? []);
      if (!expected.every((v) => have.has(v))) violations.add(`required:${section}.${name}`);
    }
    for (const name of sectionKeys(unitFile['present'], section)) {
      if (!actual.has(name)) violations.add(`present:${section}.${name}`);
    }
  }
  if (unit.size > 0 && [...unit.keys()].some((s) => !['Unit', 'Service', 'Install'].includes(s))) {
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
    for (const [section, keys] of dropin) {
      for (const [name, values] of keys) {
        applyForbidden(section, name, values);
        const want = expected[name];
        if (section !== 'Service' || want === undefined || !sameSet(values, strings(want, name))) {
          violations.add(`dropin:${section}.${name}`);
        }
      }
    }
    for (const name of Object.keys(expected)) {
      if (!dropin.get('Service')?.has(name)) violations.add(`dropin:Service.${name}`);
    }
  }
  return [...violations].sort();
}

// ------------------------------------------------------------------------ specs

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
  it('the schema board enum, the statement registry and boards.json agree', () => {
    const common = readJson(join(CONTRACT, 'schemas', 'common.schema.json'));
    const defs = asObject(common['$defs'], '$defs');
    const enumBoards = strings(asObject(defs['board_profile'], 'board_profile')['enum'], 'enum');
    expect([...BOARD_BY_PROFILE.keys()].sort()).toEqual([...enumBoards].sort());
    expect(BOARD_BY_PROFILE.size).toBe(BOARDS.length);
    for (const row of BOARDS) {
      const arch = asString(row['arch'], 'arch');
      expect(asString(row['rust_target'], 'rust_target').startsWith(`${arch}-`)).toBe(true);
      expect(strings(row['cargo_features'], 'features')).toEqual(
        [...strings(row['cargo_features'], 'f')].sort(),
      );
      expect(strings(row['cargo_features'], 'features')).toContain('suderra-os');
    }
    const reasons = Object.keys(asObject(statementsFile['rejection_reasons'], 'rejection_reasons'));
    const purposes = Object.keys(asObject(statementsFile['purposes'], 'purposes'));
    expect(
      strings(statementsFile['verification_order'], 'order').filter((r) => !reasons.includes(r)),
    ).toEqual([]);
    for (const [type, value] of Object.entries(STATEMENTS)) {
      const spec = asObject(value, type);
      const [, kind, version] = /^suderra\.([a-z0-9-]+)\.(v[0-9]+)$/.exec(type) ?? [];
      expect(spec['payload_type']).toBe(`application/vnd.suderra.${kind}.${version}+json`);
      expect(purposes).toContain(spec['signing_purpose']);
      expect(strings(spec['checks'], 'checks').filter((r) => !reasons.includes(r))).toEqual([]);
      const schema = readJson(join(CONTRACT, asString(spec['schema'], 'schema')));
      const props = asObject(schema['properties'], 'properties');
      expect(asObject(props['_type'], '_type')['const']).toBe(type);
    }
  });

  it('every Suderra-OS build-matrix row is a board image or an excluded image, exactly once', () => {
    const mapped = BOARDS.flatMap((row) =>
      asArray(row['os_images'], 'os_images').map((image) => {
        const o = asObject(image, 'os_image');
        return `${asString(o['defconfig'], 'defconfig')} ${asString(o['build_target'], 'target')}`;
      }),
    );
    const excluded = asArray(boardsFile['excluded_os_images'], 'excluded').map((image) => {
      const o = asObject(image, 'excluded');
      return `${asString(o['defconfig'], 'defconfig')} ${asString(o['build_target'], 'target')}`;
    });
    const all = [...mapped, ...excluded];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(SUDERRA_OS_BUILD_MATRIX.map(([d, t]) => `${d} ${t}`).sort());
  });

  it('every cloud DeviceModel maps to exactly one board or is explicitly unmapped', () => {
    const entity = readFileSync(
      join(REPO_ROOT, 'apps/sensor-service/src/edge-device/entities/edge-device.entity.ts'),
      'utf8',
    );
    const body = /export enum DeviceModel \{([\s\S]*?)\n\}/.exec(entity)?.[1] ?? '';
    const models = [...body.matchAll(/=\s*'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '');
    expect(models.length).toBeGreaterThan(0);
    const mapped = BOARDS.flatMap((row) => strings(row['cloud_device_models'], 'models'));
    const unmapped = asArray(boardsFile['unmapped_device_models'], 'unmapped').map((item) =>
      asString(asObject(item, 'unmapped')['device_model'], 'device_model'),
    );
    expect(new Set(mapped).size).toBe(mapped.length);
    expect([...mapped, ...unmapped].sort()).toEqual([...models].sort());
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
    for (const item of asArray(generic['slugs'], 'slugs')) {
      const slug = asObject(item, 'slug');
      expect(published).toContain(
        `${asString(slug['rust_target'], 'rust_target')} ${asString(slug['slug'], 'slug')}`,
      );
    }
    expect(/ARCHIVE_BINARY_NAME:\s*(\S+)/.exec(workflow)?.[1]).toBe(generic['binary_name']);
  });

  it('the agent unit writes exactly the agent-owned rows of the mutable-state table', () => {
    const entries = asArray(mutableFile['entries'], 'entries').map((e) => asObject(e, 'entry'));
    const paths = entries.map((e) => asString(e['path'], 'path'));
    expect(new Set(paths).size).toBe(paths.length);
    const byAccess = (access: string): string[] =>
      entries.filter((e) => e['agent_access'] === access).map((e) => asString(e['path'], 'path'));
    const profile = asObject(
      asObject(unitFile['profiles'], 'profiles')['suderra-os'],
      'suderra-os',
    );
    const service = sectionValues(profile['exact'], 'Service');
    expect([...(service.get('ReadWritePaths') ?? [])].sort()).toEqual(
      byAccess('read-write').sort(),
    );
    expect([...(service.get('ReadOnlyPaths') ?? [])].sort()).toEqual(
      byAccess('read-only-bind').sort(),
    );
    for (const entry of entries.filter((e) => e['writer'] === 'agent')) {
      expect(entry['owner']).toBe('suderra');
    }
    const dropins = asObject(
      asObject(profile['board_dropins'], 'board_dropins')['boards'],
      'boards',
    );
    expect(Object.keys(dropins).sort()).toEqual([...BOARD_BY_PROFILE.keys()].sort());
  });
});

describe('suderra-edge contract v1 — TEST-ONLY keys', () => {
  it('every key and the MQTT CA are re-derived from their published TEST-ONLY seed labels', () => {
    expect(keyringFile['test_only']).toBe(true);
    const purposes = asObject(statementsFile['purposes'], 'purposes');
    const keyFiles = new Set<string>();
    for (const entry of asArray(keyringFile['keys'], 'keys')) {
      const key = asObject(entry, 'key');
      const label = asString(key['seed_label'], 'seed_label');
      const purpose = asString(key['purpose'], 'purpose');
      expect(label).toBe(`${SEED_PREFIX}${purpose}:${asNumber(key['epoch'], 'epoch')}`);
      const derived = deriveTestKey(label);
      expect(asString(key['public_key'], 'public_key')).toBe(derived.raw.toString('base64'));
      expect(key['keyid']).toBe(sha256(derived.raw));
      const path = asString(key['path'], 'path');
      keyFiles.add(path);
      expect(readFileSync(join(CONTRACT, path), 'utf8')).toBe(derived.pem);
      const anchoredIn = strings(
        asObject(purposes[purpose], purpose)['anchored_in'],
        'anchored_in',
      );
      expect(key['os_pinned']).toBe(anchoredIn.includes('os-image'));
    }
    const onDisk = listFiles(join(CONTRACT, 'test-keys')).map(contractRel);
    expect(onDisk.sort()).toEqual([...keyFiles, 'test-keys/keyring.json'].sort());

    for (const entry of asArray(keyringFile['mqtt_ca'], 'mqtt_ca')) {
      const ca = asObject(entry, 'mqtt_ca');
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
});

describe('suderra-edge contract v1 — golden fixtures', () => {
  const statementEntries = asArray(indexFile['statements'], 'statements').map((e) =>
    asObject(e, 'entry'),
  );

  it('the index is TEST-ONLY and references every fixture file, each one existing', () => {
    expect(indexFile['test_only']).toBe(true);
    const referenced = new Set<string>([
      'index.json',
      asString(indexFile['pae_vectors'], 'pae_vectors'),
      asString(indexFile['signature_vectors'], 'signature_vectors'),
    ]);
    for (const entry of statementEntries) {
      referenced.add(asString(entry['path'], 'path'));
      for (const value of Object.values(asObject(entry['inputs'], 'inputs'))) {
        if (typeof value === 'string' && value.includes('/')) referenced.add(value);
      }
    }
    for (const entry of asArray(indexFile['documents'], 'documents')) {
      referenced.add(asString(asObject(entry, 'doc')['path'], 'path'));
    }
    for (const entry of asArray(indexFile['units'], 'units')) {
      const unit = asObject(entry, 'unit');
      referenced.add(asString(unit['unit'], 'unit'));
      if (typeof unit['dropin'] === 'string') referenced.add(unit['dropin']);
    }
    const onDisk = listFiles(FIXTURES).map((path) =>
      relative(FIXTURES, path).split('\\').join('/'),
    );
    expect(onDisk.sort()).toEqual([...referenced].sort());
  });

  it('PAE vectors match DSSE v1 byte for byte', () => {
    const file = readJson(join(FIXTURES, asString(indexFile['pae_vectors'], 'pae_vectors')));
    for (const item of asArray(file['vectors'], 'vectors')) {
      const vector = asObject(item, 'vector');
      const body = Buffer.from(asString(vector['payload'], 'payload'), 'base64');
      expect(pae(asString(vector['payload_type'], 'payload_type'), body).toString('hex')).toBe(
        vector['pae_hex'],
      );
    }
    const helloWorld = pae('http://example.com/HelloWorld', Buffer.from('hello world'));
    expect(helloWorld.toString('utf8')).toBe(
      'DSSEv1 29 http://example.com/HelloWorld 11 hello world',
    );
  });

  it('signature vectors pin verify_strict semantics', () => {
    const file = readJson(
      join(FIXTURES, asString(indexFile['signature_vectors'], 'signature_vectors')),
    );
    for (const item of asArray(file['vectors'], 'vectors')) {
      const vector = asObject(item, 'vector');
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
  });

  it.each(
    statementEntries.map((e) => [
      asString(e['path'], 'path'),
      asString(e['device_context'] ?? 'none', 'ctx'),
      e,
    ]),
  )('%s under %s reaches its labelled verdict', (path, _context, entry) => {
    const type = asString(entry['statement_type'], 'statement_type');
    const context =
      entry['device_context'] === null ? null : asString(entry['device_context'], 'ctx');
    const verdict = verifyStatement(
      readEnvelopeBytes(path),
      type,
      context,
      toInputs(entry['inputs']),
    );
    if (entry['expect'] === 'accept') {
      expect(verdict.reasons).toEqual([]);
    } else {
      expect(verdict.reasons).toEqual([entry['reason']]);
      const allowed = [
        ...strings(statementsFile['verification_order'], 'order'),
        ...strings(asObject(STATEMENTS[type], type)['checks'], 'checks'),
      ];
      expect(allowed).toContain(entry['reason']);
    }
  });

  it('every statement type has accepted and rejected fixtures, including the ADR-048 core negatives', () => {
    for (const type of Object.keys(STATEMENTS)) {
      const of = statementEntries.filter((e) => e['statement_type'] === type);
      expect(of.some((e) => e['expect'] === 'accept')).toBe(true);
      expect(of.some((e) => e['expect'] === 'reject')).toBe(true);
    }
    const provisioningReasons = statementEntries
      .filter((e) => e['statement_type'] === 'suderra.edge-provisioning.v2')
      .map((e) => e['reason']);
    for (const reason of [
      'signature-invalid',
      'device-binding-mismatch',
      'expired',
      'board-mismatch',
      'rollback-below-floor',
      'payload-type-mismatch',
    ]) {
      expect(provisioningReasons).toContain(reason);
    }
  });

  it('result documents validate or fail exactly as labelled', () => {
    const validate = validator('schemas/result.schema.json');
    for (const item of asArray(indexFile['documents'], 'documents')) {
      const entry = asObject(item, 'document');
      const document = readJson(join(FIXTURES, asString(entry['path'], 'path')));
      expect({ path: entry['path'], valid: validate(document) }).toEqual({
        path: entry['path'],
        valid: entry['expect'] === 'accept',
      });
    }
  });

  it('golden units satisfy the directive allowlist, and each broken unit fails for exactly its labelled rules', () => {
    for (const item of asArray(indexFile['units'], 'units')) {
      const entry = asObject(item, 'unit');
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
        entry['expect'] === 'accept' ? [] : [...strings(entry['violations'], 'violations')].sort();
      expect({ unit: entry['unit'], dropin: entry['dropin'], violations }).toEqual({
        unit: entry['unit'],
        dropin: entry['dropin'],
        violations: expected,
      });
    }
  });

  it('the key-unknown and unpinned-anchor fixtures use the published TEST-ONLY unpinned key', () => {
    const unpinned = sha256(deriveTestKey(`${SEED_PREFIX}unpinned:1`).raw);
    const envelope = readJson(join(FIXTURES, 'edge-provisioning/invalid/unknown-keyid.dsse.json'));
    const signature = asObject(asArray(envelope['signatures'], 'signatures')[0], 'signature');
    expect(signature['keyid']).toBe(unpinned);
    expect(existsSync(join(CONTRACT, 'test-keys', 'unpinned'))).toBe(false);
  });
});
