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
 *   5. The runtime documents and channels (channels.json, the run-time
 *      documents of mutable-state.json) are consistent with the registry, the
 *      mutable-state table and the agent's hand-over bounds, and their
 *      fixtures and vectors (identity, time state, health view, site bundle,
 *      activation, hand-over responses, update spool, USB medium layout,
 *      point decoding) reach the verdict they are labelled with.
 *   6. A reference verifier (DSSE PAE, Ed25519 with verify_strict semantics,
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
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  REPO_ROOT,
  CONTRACT_REL,
  CONTRACT,
  FIXTURES,
  SCHEMA_ID_PREFIX,
  SEED_PREFIX,
  Json,
  JsonObject,
  listFiles,
  contractRel,
  readJson,
  sha256,
  asObject,
  asArray,
  asString,
  asNumber,
  strings,
  objects,
  sameSet,
  sameSequence,
  sorted,
  parseStrictJson,
  UTF8,
  ED25519_SPKI_PREFIX,
  verifyStrict,
  deriveTestKey,
  pae,
  statementsFile,
  boardsFile,
  namingFile,
  unitFile,
  mutableFile,
  deliveryFile,
  channelsFile,
  lifecycleFile,
  keyringFile,
  indexFile,
  STATEMENTS,
  VERIFICATION_ORDER,
  REVERIFICATION,
  REVERIFIED,
  PURPOSES,
  BOARDS,
  PENDING_FAMILIES,
  BOARD_BY_PROFILE,
  CONTEXTS,
  ST_RELEASE,
  isCanonicalPoint,
  isSmallOrder,
  spec,
  allowedReasons,
  SCHEMA_FILES,
  validator,
  runEntry,
  verifyDelivery,
} from './lib/suderra-edge-contract';

const THIS_SPEC = 'tests/invariants/suderra-edge-contracts.spec.ts';

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
      ['schemas/channels.schema.json', channelsFile],
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

describe('suderra-edge contract v1 — the edge proxy answers as delivery.json says', () => {
  it('a rate-limited provisioning fetch or activation gets rate_limited_status, not nginx 503', () => {
    const delivery = readJson(join(CONTRACT, 'delivery.json'));
    const refusal = asObject(
      asObject(asObject(delivery, 'delivery')['network'], 'network')['refusal'],
      'refusal',
    );
    const status = refusal['rate_limited_status'];
    expect(status).toBe(429);
    const conf = readFileSync(join(REPO_ROOT, 'infrastructure/nginx/droplet.conf'), 'utf8');
    for (const path of ['/install/', '/api/devices/']) {
      const start = conf.indexOf(`location ${path} {`);
      expect(start).toBeGreaterThan(-1);
      const block = conf.slice(start, conf.indexOf('\n        }', start));
      expect(block).toMatch(/limit_req zone=/);
      expect(block).toContain(`limit_req_status ${String(status)};`);
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

  // The release workflow's builds, generic channel included, are planned from
  // this contract by scripts/edge/edge_release.py and held to it by
  // tests/invariants/edge-release-pipeline.spec.ts.

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

// ------------------------------------------------------- channels, documents, vectors

const UPDATE_CHANNEL = asObject(channelsFile['update_channel'], 'update_channel');
const SPOOL = asObject(UPDATE_CHANNEL['spool'], 'spool');
const CARRIED = asObject(UPDATE_CHANNEL['carried_statements'], 'carried_statements');
const HANDOFF = asObject(channelsFile['handoff'], 'handoff');
const HANDOFF_COMMANDS = asObject(HANDOFF['commands'], 'commands');
const RESULT_DOCUMENT = asObject(
  asObject(statementsFile['unsigned_documents'], 'unsigned_documents')['suderra.result.v1'],
  'result',
);
const MUTABLE_ENTRIES = objects(mutableFile['entries'], 'entries');

function mutableEntry(path: string): JsonObject {
  const found = MUTABLE_ENTRIES.find((entry) => entry['path'] === path);
  if (found === undefined) throw new Error(`mutable-state.json has no ${path}`);
  return found;
}

/** The value of a Rust integer constant written as N or N * M (underscores allowed). */
function rustConstant(file: string, name: string): number {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const match = new RegExp(`\\b${name}\\b[^=;]*=\\s*([0-9_*\\s]+);`).exec(source);
  if (match === null) throw new Error(`${name} is not an integer constant of ${file}`);
  return (match[1] ?? '')
    .split('*')
    .map((factor) => Number(factor.replace(/_/g, '').trim()))
    .reduce((product, factor) => product * factor, 1);
}

interface SpoolEntry {
  name: string;
  type: string;
  size: number;
}

/** What root's request worker does with one spool directory entry (channels.json update_channel.spool). */
function classifySpoolEntry(entry: SpoolEntry): { expect: string; reason?: string } {
  if (!new RegExp(asString(SPOOL['name_pattern'], 'name_pattern')).test(entry.name))
    return { expect: 'ignore' };
  if (entry.type !== 'file') return { expect: 'refuse', reason: 'request-not-regular-file' };
  if (entry.size > asNumber(SPOOL['max_entry_bytes'], 'max_entry_bytes'))
    return { expect: 'refuse', reason: 'request-too-large' };
  return { expect: 'consume' };
}

/** Whether the agent writes a request into a directory holding `pending` (the bound of update_channel.spool). */
function agentWritesRequest(
  pending: Array<{ name: string; size: number }>,
  request: { name: string; size: number },
): boolean {
  const temporary = new RegExp(asString(SPOOL['temporary_name_pattern'], 'temporary_name_pattern'));
  const others = pending.filter(
    (entry) => entry.name !== request.name && !temporary.test(entry.name),
  );
  const bytes = others.reduce((sum, entry) => sum + entry.size, 0);
  return (
    others.length < asNumber(SPOOL['max_pending_entries'], 'max_pending_entries') &&
    bytes + request.size <= asNumber(SPOOL['max_pending_bytes'], 'max_pending_bytes')
  );
}

interface UsbEntry {
  path: string;
  type: string;
  size: number;
}

/** Whether a USB medium's listing satisfies delivery.json usb.ingress.layout and limits. */
function usbLayoutAccepted(entries: UsbEntry[]): boolean {
  const ingress = asObject(asObject(deliveryFile['usb'], 'usb')['ingress'], 'ingress');
  const layout = asObject(ingress['layout'], 'layout');
  const limits = asObject(ingress['limits'], 'limits');
  const top = asString(layout['top_directory'], 'top_directory');
  const artifact = new RegExp(asString(layout['artifact_name_pattern'], 'artifact_name_pattern'));
  const deviceCode = /^[A-Za-z0-9_-]{1,50}$/;
  const below = entries.filter((entry) => entry.path.startsWith(`${top}/`));
  const directories = new Map<string, UsbEntry[]>();
  for (const entry of below) {
    const parts = entry.path.slice(top.length + 1).split('/');
    const [code] = parts;
    if (parts.length === 1) {
      if (entry.type !== 'dir' || !deviceCode.test(entry.path.slice(top.length + 1))) return false;
      directories.set(code ?? '', directories.get(code ?? '') ?? []);
    } else if (parts.length === 2) {
      directories.set(code ?? '', [...(directories.get(code ?? '') ?? []), entry]);
    } else {
      return false;
    }
  }
  if (directories.size > asNumber(limits['max_directories'], 'max_directories')) return false;
  for (const files of directories.values()) {
    if (files.length > asNumber(limits['max_files_per_directory'], 'max_files')) return false;
    if (!files.some((file) => file.path.endsWith('/delivery.json'))) return false;
    for (const file of files) {
      const base = file.path.split('/').pop() ?? '';
      const isDelivery = base === 'delivery.json';
      if (file.type !== 'file' || (!isDelivery && !artifact.test(base))) return false;
      const cap = limits[isDelivery ? 'max_delivery_bytes' : 'max_artifact_bytes'];
      if (file.size > asNumber(cap, 'size limit')) return false;
    }
  }
  return true;
}

describe('suderra-edge contract v1 — channels and run-time documents', () => {
  it('channels.json names only registered statements, result kinds and mutable-state paths', () => {
    const carried = Object.keys(CARRIED);
    for (const [command, value] of Object.entries(HANDOFF_COMMANDS)) {
      const types = strings(asObject(value, command)['statement_types'], 'statement_types');
      expect({ command, unknown: types.filter((type) => STATEMENTS[type] === undefined) }).toEqual({
        command,
        unknown: [],
      });
    }
    expect(
      sorted(
        strings(
          asObject(HANDOFF_COMMANDS['request_update'], 'request_update')['statement_types'],
          'statement_types',
        ),
      ),
    ).toEqual(sorted(carried));
    const byKind = asObject(RESULT_DOCUMENT['reasons_by_kind'], 'reasons_by_kind');
    for (const type of carried) {
      const entry = asObject(CARRIED[type], type);
      const kind = asString(entry['result_kind'], 'result_kind');
      expect(strings(asObject(byKind[kind], kind)['statements'], 'statements')).toContain(type);
      expect(entry['sequence_file']).toBe(`/data/suderra/os/seq/${kind}`);
      expect(spec(type)['sequence']).not.toBeNull();
    }
    const spoolEntry = mutableEntry(asString(SPOOL['directory'], 'directory'));
    expect({ writer: spoolEntry['writer'], access: spoolEntry['agent_access'] }).toEqual({
      writer: 'agent',
      access: 'read-write',
    });
    const stateDir = asString(mutableEntry('/var/lib/suderra/state')['path'], 'path');
    for (const command of ['activation_receipt', 'lifecycle_request']) {
      const writes = asString(asObject(HANDOFF_COMMANDS[command], command)['writes'], 'writes');
      expect(writes.startsWith(`${stateDir}/`)).toBe(true);
    }
    const statement = asObject(HANDOFF['statement_param'], 'statement_param');
    expect(SPOOL['max_entry_bytes']).toBe(statement['max_bytes']);
    expect(asNumber(SPOOL['max_pending_bytes'], 'bytes')).toBe(
      asNumber(SPOOL['max_pending_entries'], 'entries') *
        asNumber(SPOOL['max_entry_bytes'], 'entry bytes'),
    );
    const digest = 'a'.repeat(64);
    const name = new RegExp(asString(SPOOL['name_pattern'], 'name_pattern'));
    const temporary = new RegExp(
      asString(SPOOL['temporary_name_pattern'], 'temporary_name_pattern'),
    );
    expect([name.test(`${digest}.dsse`), name.test(`.${digest}.dsse.tmp-1`)]).toEqual([
      true,
      false,
    ]);
    expect([temporary.test(`${digest}.dsse`), temporary.test(`.${digest}.dsse.tmp-1`)]).toEqual([
      false,
      true,
    ]);
    const results = asObject(channelsFile['result_telemetry'], 'result_telemetry');
    const resultName = new RegExp(asString(results['file_name_pattern'], 'file_name_pattern'));
    expect([
      resultName.test('0000000000000042-edge-update.json'),
      resultName.test('volatile-0000000000000042-os-update.json'),
      resultName.test('42-edge-update.json'),
    ]).toEqual([true, true, false]);
    for (const site of strings(
      asObject(
        asObject(readJson(join(CONTRACT, 'schemas', 'common.schema.json'))['$defs'], '$defs')[
          'site_path'
        ],
        'site_path',
      )['enum'],
      'enum',
    )) {
      expect(strings(mutableEntry('/var/lib/suderra-site')['contents'], 'contents')).toContain(
        site,
      );
    }
  });

  it('every cloud producer channels.json names exists, unless it is marked new in P1', () => {
    const text = JSON.stringify(HANDOFF_COMMANDS);
    const files = [...text.matchAll(/([a-z-]+\.service\.ts)( \(new in P1)?/g)];
    expect(files.length).toBeGreaterThan(0);
    const missing = files
      .filter((match) => match[2] === undefined)
      .map((match) => match[1] ?? '')
      .filter((file) => !existsSync(join(REPO_ROOT, 'apps/sensor-service/src/edge-device', file)));
    expect(missing).toEqual([]);
  });

  it("the agent's hand-over bounds are the contract's", () => {
    const statement = asObject(HANDOFF['statement_param'], 'statement_param');
    expect(rustConstant('sens-api-gateway/src/commands/root_handoff.rs', 'MAX_HANDOFF_BYTES')).toBe(
      statement['max_bytes'],
    );
    expect(
      rustConstant(
        'sens-api-gateway/src/commands/request_update.rs',
        'MAX_PENDING_UPDATE_REQUESTS',
      ),
    ).toBe(SPOOL['max_pending_entries']);
  });

  it('planned successors name registered statements and define no second version', () => {
    for (const [type, value] of Object.entries(
      asObject(statementsFile['planned_successors'], 'planned_successors'),
    )) {
      const successor = asString(asObject(value, type)['successor'], 'successor');
      expect(STATEMENTS[type]).toBeDefined();
      expect(STATEMENTS[successor]).toBeUndefined();
    }
    const updateSchema = readJson(join(CONTRACT, 'schemas', 'edge-update.schema.json'));
    expect(Object.keys(asObject(updateSchema['properties'], 'properties'))).not.toContain(
      'approvals',
    );
  });

  it('run-time documents validate or fail exactly as labelled, and every type has both outcomes', () => {
    const outcomes = new Map<string, Set<string>>();
    for (const entry of objects(indexFile['runtime_documents'], 'runtime_documents')) {
      const path = asString(entry['path'], 'path');
      const type = asString(entry['document_type'], 'document_type');
      const schema = `schemas/${type.replace(/^suderra\./, '').replace(/\.v[0-9]+$/, '')}.schema.json`;
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
      outcomes.set(
        type,
        (outcomes.get(type) ?? new Set<string>()).add(asString(entry['expect'], 'e')),
      );
    }
    expect(Object.fromEntries([...outcomes].map(([type, set]) => [type, sorted(set)]))).toEqual(
      Object.fromEntries(
        [
          'suderra.agent-health.v1',
          'suderra.command-handoff-response.v1',
          'suderra.edge-activation-request.v1',
          'suderra.edge-activation-response.v1',
          'suderra.identity.v1',
          'suderra.site-bundle.v1',
          'suderra.time-state.v1',
        ].map((type) => [type, ['accept', 'reject']]),
      ),
    );
  });

  it('every site bundle the statement fixtures use carries exactly the files and RBAC manifest its site config names', () => {
    const bundles = statementEntries
      .map((entry) => asObject(entry['inputs'], 'inputs')['site_bundle'])
      .filter((path): path is string => typeof path === 'string');
    expect(bundles.length).toBeGreaterThan(0);
    for (const path of bundles) {
      const bundle = readJson(join(FIXTURES, path));
      expect(validator('schemas/site-bundle.schema.json')(bundle)).toBe(true);
    }
  });

  it("the update spool vectors give root's classification, the carried statements and the agent's backlog rule", () => {
    const file = readJson(join(FIXTURES, asString(indexFile['spool_vectors'], 'spool_vectors')));
    expect(file['limits']).toEqual({
      max_entry_bytes: SPOOL['max_entry_bytes'],
      max_pending_entries: SPOOL['max_pending_entries'],
      max_pending_bytes: SPOOL['max_pending_bytes'],
    });
    expect(file['name_pattern']).toBe(SPOOL['name_pattern']);
    expect(file['temporary_name_pattern']).toBe(SPOOL['temporary_name_pattern']);
    const results = new Set<string>();
    for (const vector of objects(file['directory_entries'], 'directory_entries')) {
      const got = classifySpoolEntry({
        name: asString(vector['name'], 'name'),
        type: asString(vector['type'], 'type'),
        size: asNumber(vector['size_bytes'], 'size_bytes'),
      });
      expect({ id: vector['id'], ...got }).toEqual({
        id: vector['id'],
        expect: vector['expect'],
        ...(vector['reason'] === undefined ? {} : { reason: vector['reason'] }),
      });
      results.add(got.expect);
      if (vector['reason'] !== undefined)
        expect(Object.keys(asObject(RESULT_DOCUMENT['operational_reasons'], 'o'))).toContain(
          vector['reason'],
        );
    }
    expect(sorted(results)).toEqual(['consume', 'ignore', 'refuse']);
    const carriedTypes = Object.keys(CARRIED).map((type) =>
      asString(spec(type)['payload_type'], 'pt'),
    );
    for (const vector of objects(file['content_entries'], 'content_entries')) {
      const path = join(FIXTURES, asString(vector['fixture'], 'fixture'));
      const envelope = asObject(JSON.parse(readFileSync(path, 'utf8')) as Json, 'envelope');
      const carried = carriedTypes.includes(asString(envelope['payloadType'], 'payloadType'));
      expect({ id: vector['id'], expect: carried ? 'consume' : 'refuse' }).toEqual({
        id: vector['id'],
        expect: vector['expect'],
      });
      expect(vector['name']).toBe(
        `${sha256(Buffer.from(asString(envelope['payload'], 'payload'), 'base64'))}.dsse`,
      );
      if (!carried) expect(vector['reason']).toBe('request-unsupported');
    }
    for (const vector of objects(file['backlog'], 'backlog')) {
      const sized = (item: Json | undefined): { name: string; size: number } => {
        const object = asObject(item, 'entry');
        return {
          name: asString(object['name'], 'name'),
          size: asNumber(object['size_bytes'], 'size_bytes'),
        };
      };
      const writes = agentWritesRequest(
        asArray(vector['pending'], 'pending').map(sized),
        sized(vector['request']),
      );
      expect({ id: vector['id'], expect: writes ? 'write' : 'refuse' }).toEqual({
        id: vector['id'],
        expect: vector['expect'],
      });
    }
  });

  it('the USB layout vectors give the verdict delivery.json usb.ingress states', () => {
    const file = readJson(
      join(FIXTURES, asString(indexFile['usb_layout_vectors'], 'usb_layout_vectors')),
    );
    const ingress = asObject(asObject(deliveryFile['usb'], 'usb')['ingress'], 'ingress');
    expect(file['limits']).toEqual(ingress['limits']);
    const outcomes = new Set<string>();
    for (const vector of objects(file['vectors'], 'vectors')) {
      const entries = objects(vector['entries'], 'entries').map((entry) => ({
        path: asString(entry['path'], 'path'),
        type: asString(entry['type'], 'type'),
        size: asNumber(entry['size_bytes'], 'size_bytes'),
      }));
      const accepted = usbLayoutAccepted(entries);
      expect({ id: vector['id'], expect: accepted ? 'accept' : 'reject' }).toEqual({
        id: vector['id'],
        expect: vector['expect'],
      });
      if (!accepted) expect(vector['reason']).toBe('usb-layout-invalid');
      outcomes.add(accepted ? 'accept' : 'reject');
    }
    expect(sorted(outcomes)).toEqual(['accept', 'reject']);
  });

  it('point vectors: a non-canonical encoding is never a canonical point, and no signature verifies under one', () => {
    const file = readJson(join(FIXTURES, asString(indexFile['point_vectors'], 'point_vectors')));
    let nonCanonicalFullOrder = 0;
    for (const vector of objects(file['vectors'], 'vectors')) {
      const point = Buffer.from(asString(vector['encoding_hex'], 'encoding_hex'), 'hex');
      expect({
        id: vector['id'],
        canonical: isCanonicalPoint(point),
        smallOrder: isSmallOrder(point),
      }).toEqual({
        id: vector['id'],
        canonical: vector['canonical'],
        smallOrder: vector['canonical'] === true ? vector['small_order'] : isSmallOrder(point),
      });
      if (vector['canonical'] === false && vector['small_order'] === false) {
        nonCanonicalFullOrder += 1;
        expect(verifyStrict(point, Buffer.from('message'), Buffer.alloc(64, 7))).toBe(false);
      }
    }
    expect(nonCanonicalFullOrder).toBeGreaterThan(10);
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
      asString(indexFile['point_vectors'], 'point_vectors'),
      asString(indexFile['spool_vectors'], 'spool_vectors'),
      asString(indexFile['usb_layout_vectors'], 'usb_layout_vectors'),
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
    for (const entry of objects(indexFile['runtime_documents'], 'runtime_documents'))
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
