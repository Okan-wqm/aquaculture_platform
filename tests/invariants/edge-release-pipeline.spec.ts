/**
 * Edge agent release pipeline invariant (ADR-048 DEC-3.8, DEC-8.5, DEC-20,
 * DEC-28; INFRA-CRITICAL-236, INFRA-HIGH-237, SENSOR-CRITICAL-202,
 * SENSOR-MEDIUM-224).
 *
 * `scripts/edge/edge_release.py` turns the cross-repo contract
 * (contracts/suderra-edge/v1) and the agent's release facts
 * (sens-api-gateway/release/edge-release.toml) into every build row of the
 * release and of the profile CI, packs the artifacts and produces the DSSE
 * `suderra.edge-release.v1` statements. This spec holds it to the contract
 * independently of the tool's own checks:
 *
 *   - the plan is exactly the contract: one Suderra OS row per buildable
 *     boards.json board with its features and names, the frozen generic
 *     channel's slugs and names;
 *   - the workflows build only planned rows, lint and test every feature set
 *     before packaging, use --locked everywhere, keep the release cache-free,
 *     and state the provenance and sign in a separate, minimal job
 *     (`sign-release-statement`, DEC-3) of the `edge-release` environment,
 *     whose protection is a declared operator check;
 *   - the tool's statements pass the contract schemas under Ajv, verify under
 *     Node's Ed25519 over the DSSE PAE, and name exactly the artifact bytes;
 *     its refusals carry the statements.json rejection reasons;
 *   - the publish gate: one case per check of `verify`/`sign` (and of the
 *     ELF, archive and validator checks behind them), each passing every
 *     other check, so a removed check lets its case through; its verifier
 *     agrees with the contract's verify_strict vectors.
 */
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import Ajv2020 from 'ajv/dist/2020';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT = join(REPO_ROOT, 'contracts', 'suderra-edge', 'v1');
const TOOL = join(REPO_ROOT, 'scripts', 'edge', 'edge_release.py');
const FACTS = join(REPO_ROOT, 'sens-api-gateway', 'release', 'edge-release.toml');
const CARGO_TOML = join(REPO_ROOT, 'sens-api-gateway', 'Cargo.toml');
const RELEASE_WF = '.github/workflows/edge-agent-release.yml';
const CI_EDGE_WF = '.github/workflows/ci-edge.yml';
const GATEWAY_WF = '.github/workflows/sens-api-gateway-ci.yml';
const STATEMENT_TYPE = 'suderra.edge-release.v1';
const SCHEMA_ID_PREFIX = 'urn:suderra:edge-contract:v1:schema:';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

function obj(value: Json | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`not an object: ${JSON.stringify(value)}`);
  }
  return value;
}

function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error(`not an array: ${JSON.stringify(value)}`);
  return value;
}

function str(value: Json | undefined): string {
  if (typeof value !== 'string') throw new Error(`not a string: ${JSON.stringify(value)}`);
  return value;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const boards = list(readJson(join(CONTRACT, 'boards.json'))['boards']).map(obj);
const naming = readJson(join(CONTRACT, 'artifact-naming.json'));
const osNaming = obj(naming['suderra_os_channel']);
const genericNaming = obj(naming['generic_channel']);
const statementEntry = obj(
  obj(readJson(join(CONTRACT, 'statements.json'))['statements'])[STATEMENT_TYPE],
);
const keyring = readJson(join(CONTRACT, 'test-keys', 'keyring.json'));
const facts = parseToml(readFileSync(FACTS, 'utf8')) as {
  suderra_os: {
    crate_required_features: string[];
    crate_required_features_tracked_by?: string;
    max_glibc: string;
    unbuildable?: Record<string, { blocked_by: string; reason: string }>;
    required_kernel_config: Record<string, string[]>;
  };
  generic_channel: { cargo_features: string[]; max_glibc: string };
  runtime: Record<string, { interpreter: string; needed: string[] }>;
};
const cargo = parseToml(readFileSync(CARGO_TOML, 'utf8')) as {
  package: { version: string };
  features: Record<string, string[]>;
  bin: { name: string }[];
};
const VERSION = cargo.package.version;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
for (const name of readdirSync(join(CONTRACT, 'schemas')).filter((n) =>
  n.endsWith('.schema.json'),
)) {
  ajv.addSchema(readJson(join(CONTRACT, 'schemas', name)));
}
function schemaErrors(name: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${SCHEMA_ID_PREFIX}${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return validate(value)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

interface ToolRun {
  status: number | null;
  stdout: string;
  stderr: string;
  reason: string | undefined;
}

function tool(args: string[], env: Record<string, string> = {}): ToolRun {
  const result = spawnSync('python3', ['-I', TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reason: /edge_release: error \[([a-z-]+)\]/.exec(result.stderr)?.[1],
  };
}

function ok(run: ToolRun): string {
  if (run.status !== 0) throw new Error(`edge_release.py failed (${run.status}): ${run.stderr}`);
  return run.stdout;
}

interface Row {
  channel: string;
  id: string;
  arch: string;
  rust_target: string;
  features: string;
  artifact: string;
  base: string;
  binary_name: string;
  statement: string;
  cargo_bin: string;
}

const plan = JSON.parse(ok(tool(['plan']))) as {
  version: string;
  build: { include: Row[] };
  test: { include: { features: string; used_by: string }[] };
};
const osRows = plan.build.include.filter((r) => r.channel === 'suderra-os');
const genericRows = plan.build.include.filter((r) => r.channel === 'generic');

// ------------------------------------------------------------- minimal ELF

const ELF_MACHINE: Record<string, number> = { x86_64: 62, aarch64: 183, armv7: 40 };

/** One ELF VERNEED record: the library and the symbol versions needed from it. */
interface VersionNeed {
  file: string;
  versions: string[];
}

/**
 * A minimal dynamically linked ELF executable: PT_INTERP, PT_LOAD, PT_DYNAMIC,
 * with DT_NEEDED entries and an optional DT_VERNEED table.
 */
function elf(
  arch: string,
  interpreter: string,
  needed: string[],
  versionNeeds: VersionNeed[] = [],
): Buffer {
  const is64 = arch !== 'armv7';
  const machine = ELF_MACHINE[arch];
  if (machine === undefined) throw new Error(`no ELF machine for ${arch}`);
  const [ehsize, phentsize] = is64 ? [64, 56] : [52, 32];
  const phnum = 3;
  const interp = Buffer.from(`${interpreter}\0`);
  const strings = [
    ...new Set([...needed, ...versionNeeds.flatMap((v) => [v.file, ...v.versions])]),
  ];
  const strOffset = new Map<string, number>();
  let strLen = 1;
  for (const name of strings) {
    strOffset.set(name, strLen);
    strLen += Buffer.byteLength(name) + 1;
  }
  const strtab = Buffer.concat([Buffer.from('\0'), ...strings.map((n) => Buffer.from(`${n}\0`))]);
  const at = (name: string): number => {
    const off = strOffset.get(name);
    if (off === undefined) throw new Error(`no string ${name}`);
    return off;
  };
  // Elf32/Elf64_Verneed and _Vernaux share one 16-byte layout each.
  const verneed = Buffer.alloc(versionNeeds.reduce((n, v) => n + 16 + 16 * v.versions.length, 0));
  let vat = 0;
  versionNeeds.forEach((v, i) => {
    const size = 16 + 16 * v.versions.length;
    verneed.writeUInt16LE(1, vat);
    verneed.writeUInt16LE(v.versions.length, vat + 2);
    verneed.writeUInt32LE(at(v.file), vat + 4);
    verneed.writeUInt32LE(16, vat + 8);
    verneed.writeUInt32LE(i === versionNeeds.length - 1 ? 0 : size, vat + 12);
    v.versions.forEach((version, j) => {
      const aux = vat + 16 + 16 * j;
      verneed.writeUInt32LE(0, aux);
      verneed.writeUInt32LE(at(version), aux + 8);
      verneed.writeUInt32LE(j === v.versions.length - 1 ? 0 : 16, aux + 12);
    });
    vat += size;
  });
  const interpOff = ehsize + phnum * phentsize;
  const strtabOff = interpOff + interp.length;
  let verneedOff = strtabOff + strtab.length;
  verneedOff += (8 - (verneedOff % 8)) % 8;
  let dynOff = verneedOff + verneed.length;
  dynOff += (8 - (dynOff % 8)) % 8;
  const vbase = 0x400000;
  const entries: [number, number][] = needed.map((n) => [1, at(n)]);
  if (versionNeeds.length > 0) {
    entries.push([0x6ffffffe, vbase + verneedOff], [0x6fffffff, versionNeeds.length]);
  }
  entries.push([5, vbase + strtabOff], [10, strtab.length], [0, 0]);
  const dynSize = is64 ? 16 : 8;
  const total = dynOff + entries.length * dynSize;
  const out = Buffer.alloc(total);
  out.write('\x7fELF', 0, 'latin1');
  out[4] = is64 ? 2 : 1;
  out[5] = 1;
  out[6] = 1;
  out.writeUInt16LE(3, 16); // ET_DYN
  out.writeUInt16LE(machine, 18);
  out.writeUInt32LE(1, 20);
  const ph = (
    i: number,
    type: number,
    flags: number,
    offset: number,
    filesz: number,
    align: number,
  ): void => {
    const base = ehsize + i * phentsize;
    if (is64) {
      out.writeUInt32LE(type, base);
      out.writeUInt32LE(flags, base + 4);
      out.writeBigUInt64LE(BigInt(offset), base + 8);
      out.writeBigUInt64LE(BigInt(vbase + offset), base + 16);
      out.writeBigUInt64LE(BigInt(filesz), base + 32);
      out.writeBigUInt64LE(BigInt(filesz), base + 40);
      out.writeBigUInt64LE(BigInt(align), base + 48);
    } else {
      out.writeUInt32LE(type, base);
      out.writeUInt32LE(offset, base + 4);
      out.writeUInt32LE(vbase + offset, base + 8);
      out.writeUInt32LE(filesz, base + 16);
      out.writeUInt32LE(filesz, base + 20);
      out.writeUInt32LE(flags, base + 24);
      out.writeUInt32LE(align, base + 28);
    }
  };
  if (is64) {
    out.writeBigUInt64LE(BigInt(ehsize), 32); // e_phoff
    out.writeUInt16LE(ehsize, 52);
    out.writeUInt16LE(phentsize, 54);
    out.writeUInt16LE(phnum, 56);
  } else {
    out.writeUInt32LE(ehsize, 28); // e_phoff
    out.writeUInt32LE(0x5000400, 36); // EABI5, hard float
    out.writeUInt16LE(ehsize, 40);
    out.writeUInt16LE(phentsize, 42);
    out.writeUInt16LE(phnum, 44);
  }
  ph(0, 3, 4, interpOff, interp.length, 1);
  ph(1, 1, 5, 0, total, 0x1000);
  ph(2, 2, 6, dynOff, entries.length * dynSize, 8);
  interp.copy(out, interpOff);
  strtab.copy(out, strtabOff);
  verneed.copy(out, verneedOff);
  entries.forEach(([tag, val], i) => {
    const base = dynOff + i * dynSize;
    if (is64) {
      out.writeBigInt64LE(BigInt(tag), base);
      out.writeBigUInt64LE(BigInt(val), base + 8);
    } else {
      out.writeInt32LE(tag, base);
      out.writeUInt32LE(val, base + 4);
    }
  });
  return out;
}

/** The glibc symbol versions a real agent build needs (all below every channel's ceiling). */
const BASELINE_VERSION_NEEDS: VersionNeed[] = [
  { file: 'libc.so.6', versions: ['GLIBC_2.17', 'GLIBC_2.4'] },
  { file: 'libgcc_s.so.1', versions: ['GCC_3.0'] },
];

function releaseElf(
  row: Row,
  extraNeeded: string[] = [],
  versionNeeds: VersionNeed[] = BASELINE_VERSION_NEEDS,
  interpreter?: string,
): Buffer {
  const rt = facts.runtime[row.arch];
  if (rt === undefined) throw new Error(`no runtime for ${row.arch}`);
  return elf(
    row.arch,
    interpreter ?? rt.interpreter,
    ['libc.so.6', 'libgcc_s.so.1', ...extraNeeded],
    versionNeeds,
  );
}

/** Names of the members of a tar.gz archive (ustar headers). */
function tarMembers(archive: Buffer): { name: string; mode: number; type: string; uid: number }[] {
  const tar = gunzipSync(archive);
  const out = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number): string =>
      header
        .subarray(start, start + len)
        .toString('latin1')
        .replace(/\0.*$/s, '')
        .trim();
    const size = parseInt(field(124, 12), 8);
    out.push({
      name: field(0, 100),
      mode: parseInt(field(100, 8), 8),
      uid: parseInt(field(108, 8), 8),
      type: field(156, 1),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const GITHUB_ENV = {
  GITHUB_REPOSITORY: 'suderra/aquaculture_platform',
  GITHUB_WORKFLOW: 'Edge Agent Release',
  GITHUB_WORKFLOW_REF: `suderra/aquaculture_platform/.github/workflows/edge-agent-release.yml@refs/tags/agent-v${VERSION}`,
  GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  GITHUB_RUN_ID: '1',
  SOURCE_DATE_EPOCH: '1700000000',
};

function newKey(): { pem: string; keyid: string; raw: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyid: sha256(raw),
    raw,
  };
}

/** One release run of the tool over stand-in binaries of every planned row, in a fresh directory. */
function releaseRun(): {
  dir: string;
  art: string;
  payloads: string;
  statements: string;
  key: ReturnType<typeof newKey>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'edge-release-spec-'));
  const art = join(dir, 'dist');
  const payloads = join(dir, 'payloads');
  const statements = join(dir, 'statements');
  for (const row of plan.build.include) {
    const bin = join(dir, `${row.channel}-${row.id}.bin`);
    writeFileSync(bin, releaseElf(row));
    ok(
      tool(
        ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', art],
        GITHUB_ENV,
      ),
    );
  }
  ok(
    tool(
      ['provenance', '--artifacts', art, '--tag', `agent-v${VERSION}`, '--out-dir', art],
      GITHUB_ENV,
    ),
  );
  ok(tool(['statements', '--artifacts', art, '--out-dir', payloads, '--expect-version', VERSION]));
  const key = newKey();
  ok(
    tool(
      [
        'sign',
        '--artifacts',
        art,
        '--payloads',
        payloads,
        '--out-dir',
        statements,
        '--key-env',
        'EDGE_RELEASE_SIGNING_KEY',
        '--expect-keyid',
        key.keyid,
      ],
      { EDGE_RELEASE_SIGNING_KEY: key.pem },
    ),
  );
  return { dir, art, payloads, statements, key };
}

/** Copy of a directory's files into a new directory. */
function copyDir(from: string, to: string): string {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
  return to;
}

/** The deterministic payload form the tool writes: sorted keys, no whitespace. */
function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function dssePae(type: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ]);
}

/**
 * A statements directory where `row`'s envelope carries `payload(body)`,
 * validly signed with `pem`: the signature verifies, so only the release
 * checks behind it can refuse it.
 */
function resigned(
  statements: string,
  into: string,
  row: Row,
  pem: string,
  payload: (body: JsonObject) => Buffer,
  keyid?: string,
): string {
  copyDir(statements, into);
  const path = join(into, row.statement);
  const envelope = readJson(path);
  const body = JSON.parse(
    Buffer.from(str(envelope['payload']), 'base64').toString('utf8'),
  ) as JsonObject;
  const bytes = payload(body);
  const type = str(envelope['payloadType']);
  const sig = sign(null, dssePae(type, bytes), createPrivateKey(pem));
  const signature = obj(list(envelope['signatures'])[0]);
  envelope['payload'] = bytes.toString('base64');
  envelope['signatures'] = [
    { keyid: keyid ?? str(signature['keyid']), sig: sig.toString('base64') },
  ];
  writeFileSync(path, JSON.stringify(envelope));
  return into;
}

function readEnvelopePayload(statements: string, row: Row): string {
  const envelope = readJson(join(statements, row.statement));
  return Buffer.from(str(envelope['payload']), 'base64').toString('utf8');
}

// ------------------------------------------------------------------- tests

describe('edge release plan (contracts/suderra-edge/v1)', () => {
  it('plans the Cargo package version', () => {
    expect(plan.version).toBe(VERSION);
  });

  it('builds every boards.json board it can build, and names the reason for each it cannot', () => {
    const unbuildable = facts.suderra_os.unbuildable ?? {};
    const planned = osRows.map((r) => r.id).sort();
    const all = boards.map((b) => str(b['board_profile']));
    expect([...planned, ...Object.keys(unbuildable)].sort()).toEqual([...all].sort());
    for (const [board, entry] of Object.entries(unbuildable)) {
      const features = list(
        obj(boards.find((b) => b['board_profile'] === board))['cargo_features'],
      ).map(str);
      // An entry exists only while the crate lacks one of the board's features.
      expect({ board, missing: features.some((f) => !(f in cargo.features)) }).toEqual({
        board,
        missing: true,
      });
      expect(entry.blocked_by).toMatch(
        /^(EI-\d{3}|(EDGE|SENSOR|INFRA)-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3})$/,
      );
    }
  });

  it('gives each Suderra OS row its board, its exact features and the contract names', () => {
    for (const row of osRows) {
      const board = obj(boards.find((b) => b['board_profile'] === row.id));
      const boardFeatures = list(board['cargo_features']).map(str);
      expect(row.arch).toBe(board['arch']);
      expect(row.rust_target).toBe(board['rust_target']);
      expect(row.features.split(',').sort()).toEqual(
        [...new Set([...boardFeatures, ...facts.suderra_os.crate_required_features])].sort(),
      );
      const artifact = str(osNaming['artifact'])
        .replace('{version}', VERSION)
        .replace('{board_profile}', row.id)
        .replace('{arch}', row.arch);
      expect(row.artifact).toBe(artifact);
      expect(row.statement).toBe(str(osNaming['statement']).replace('{artifact}', artifact));
      expect(row.binary_name).toBe(osNaming['binary_name']);
      expect(row.cargo_bin).toBe(cargo.bin[0]?.name);
    }
    // INFRA-CRITICAL-236: the board that drives GPIO is released with gpio.
    const rpi = osRows.find((r) => r.id === 'rpi4-cm4');
    expect(rpi?.features.split(',')).toContain('gpio');
  });

  it('keeps the frozen generic-Linux channel exactly (DEC-28)', () => {
    const slugs = list(genericNaming['slugs']).map(obj);
    expect(genericRows.map((r) => `${r.id} ${r.rust_target}`).sort()).toEqual(
      slugs.map((s) => `${str(s['slug'])} ${str(s['rust_target'])}`).sort(),
    );
    for (const row of genericRows) {
      expect(row.artifact).toBe(
        str(genericNaming['artifact']).replace('{version}', VERSION).replace('{slug}', row.id),
      );
      expect(row.binary_name).toBe(genericNaming['binary_name']);
      expect(row.statement).toBe('');
      expect(row.features.split(',')).toEqual([...facts.generic_channel.cargo_features].sort());
    }
  });

  it('tests every feature set a release row builds', () => {
    expect(plan.test.include.map((t) => t.features).sort()).toEqual(
      [...new Set(plan.build.include.map((r) => r.features))].sort(),
    );
  });
});

describe('edge release workflows', () => {
  type Job = {
    needs?: string | string[];
    uses?: string;
    environment?: string;
    permissions?: Record<string, string>;
    strategy?: { matrix?: unknown };
    steps?: {
      uses?: string;
      run?: string;
      name?: string;
      env?: Record<string, string>;
      with?: Record<string, unknown>;
    }[];
  };
  type Workflow = {
    on: Record<string, unknown>;
    jobs: Record<string, Job>;
    concurrency?: { group?: string };
  };
  const load = (rel: string): { wf: Workflow; text: string } => {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    return { wf: yaml.load(text) as Workflow, text };
  };
  const release = load(RELEASE_WF);
  const ciEdge = load(CI_EDGE_WF);
  const gateway = load(GATEWAY_WF);
  const needs = (job: Job): string[] => (job.needs === undefined ? [] : [job.needs].flat());
  const runs = (wf: Workflow): string[] =>
    Object.values(wf.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''));

  it('releases only from agent-v* tags', () => {
    expect(Object.keys(release.wf.on)).toEqual(['push']);
    expect(release.wf.on['push']).toEqual({ tags: ['agent-v*'] });
  });

  it('builds exactly the planned rows, after both CIs passed on the tag commit', () => {
    const build = release.wf.jobs['build'];
    expect(build?.strategy?.matrix).toBe('${{ fromJSON(needs.plan.outputs.build_matrix) }}');
    expect(needs(build ?? {}).sort()).toEqual(
      [
        'gateway-ci',
        'plan',
        'profile-ci',
        'release-ref-contract',
        'sens-enterprise-validation',
      ].sort(),
    );
    expect(release.wf.jobs['gateway-ci']?.uses).toBe(`./${GATEWAY_WF}`);
    expect(release.wf.jobs['profile-ci']?.uses).toBe(`./${CI_EDGE_WF}`);
    expect(Object.keys(gateway.wf.on)).toContain('workflow_call');
    expect(Object.keys(ciEdge.wf.on)).toContain('workflow_call');
    // A called workflow whose concurrency group evaluates like the caller's
    // waits on, or cancels, the release that called it.
    expect(ciEdge.wf.concurrency?.group).not.toContain('github.workflow');
    expect(gateway.wf.concurrency?.group).not.toContain('github.workflow');
  });

  it('runs every cargo and cross build, test, check and install with --locked', () => {
    const commands = [release.wf, ciEdge.wf, gateway.wf]
      .flatMap(runs)
      .flatMap((r) => r.replace(/\\\n/g, ' ').split('\n'))
      .filter((l) => /\b(cargo|cross)\s+(build|test|check|install|clippy|doc|metadata)\b/.test(l));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((l) => !l.includes('--locked'))).toEqual([]);
  });

  it('builds the release from no cache (DEC-20)', () => {
    const cacheActions = Object.values(release.wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .filter(
        (s) =>
          /actions\/cache|rust-cache|sccache/.test(s.uses ?? '') || s.with?.['cache'] !== undefined,
      );
    expect(cacheActions).toEqual([]);
  });

  it('builds with exactly the planned features and packages through the ELF check', () => {
    for (const wf of [release.wf, ciEdge.wf]) {
      const text = runs(wf).join('\n');
      expect(text).toContain(
        'cross build --locked --release --target-dir "$CARGO_TARGET_DIR" --target "$RUST_TARGET" --no-default-features --features "$FEATURES"',
      );
      expect(text).toContain('scripts/edge/edge_release.py package');
    }
    const test = ciEdge.wf.jobs['profile-test'];
    expect(test?.strategy?.matrix).toBe('${{ fromJSON(needs.plan.outputs.test_matrix) }}');
    expect((test?.steps ?? []).map((s) => s.run ?? '').join('\n')).toContain(
      'cargo test --locked --all-targets --no-default-features --features "$FEATURES"',
    );
    expect(ciEdge.wf.jobs['profile-build']?.strategy?.matrix).toBe(
      '${{ fromJSON(needs.plan.outputs.build_matrix) }}',
    );
  });

  it('signs in a separate, minimal job of the protected edge-release environment', () => {
    // ADR-048 DEC-3 names the job.
    const sign = release.wf.jobs['sign-release-statement'];
    expect(sign?.environment).toBe('edge-release');
    expect(sign?.permissions).toEqual({ contents: 'read' });
    expect(needs(sign ?? {})).toContain('build');
    const uses = (sign?.steps ?? []).map((s) => s.uses).filter((u): u is string => u !== undefined);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/^actions\/(checkout|download-artifact|upload-artifact)@[0-9a-f]{40}( |$)/);
    }
    const signStep = (sign?.steps ?? []).find((s) =>
      (s.run ?? '').includes('edge_release.py sign'),
    );
    expect(signStep?.env).toEqual({
      EDGE_RELEASE_SIGNING_KEY: '${{ secrets.EDGE_RELEASE_SIGNING_KEY }}',
      EDGE_RELEASE_KEYID: '${{ vars.EDGE_RELEASE_KEYID }}',
    });
    expect(signStep?.run).toContain(
      '--key-env EDGE_RELEASE_SIGNING_KEY --expect-keyid "${EDGE_RELEASE_KEYID}"',
    );
    // The signing key reaches no other job.
    for (const [name, job] of Object.entries(release.wf.jobs)) {
      if (name === 'sign-release-statement') continue;
      expect({ name, key: JSON.stringify(job).includes('EDGE_RELEASE_SIGNING_KEY') }).toEqual({
        name,
        key: false,
      });
    }
  });

  it('declares the protection the signing environment needs as an operator check', () => {
    // GitHub creates a named environment on first use with no protection, so
    // the workflow cannot fail closed on it: the operator check is declared.
    const manifest = readJson(join(REPO_ROOT, '.github', 'provisioned-secrets.json'));
    const environment = obj(obj(manifest['environments'])['edge-release']);
    expect(environment['required_reviewers']).toBe(true);
    expect(environment['prevent_self_review']).toBe(true);
    expect(environment['deployment_policy']).toEqual({ type: 'tag', pattern: 'agent-v*' });
    const sign = release.wf.jobs['sign-release-statement'];
    const text = JSON.stringify(sign);
    const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const variables = [...text.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(list(environment['secrets']).map(str).sort()).toEqual([...new Set(secrets)].sort());
    expect(list(environment['variables']).map(str).sort()).toEqual([...new Set(variables)].sort());
    expect(list(environment['repository_level_forbidden']).map(str)).toEqual(
      expect.arrayContaining(secrets.filter((n): n is string => n !== undefined)),
    );
    // A secret of the environment is never declared as a repository secret.
    const declared = obj(manifest['secrets']);
    for (const name of secrets) {
      const scope = str(obj(declared[name ?? ''])['scope']);
      expect({ name, repository: scope === 'repository' }).toEqual({ name, repository: false });
      if (obj(declared[name ?? ''])['provisioned'] === true) {
        expect(scope).toBe('environment: edge-release');
      }
    }
  });

  it('states the provenance in the signing job from the downloaded bytes, never in a build job', () => {
    const runOf = (job: string): string =>
      (release.wf.jobs[job]?.steps ?? []).map((st) => st.run ?? '').join('\n');
    expect(runOf('build')).not.toContain('edge_release.py provenance');
    expect(JSON.stringify(release.wf.jobs['build'])).not.toContain('intoto');
    const steps = release.wf.jobs['sign-release-statement']?.steps ?? [];
    const provenanceAt = steps.findIndex((st) =>
      (st.run ?? '').includes('edge_release.py provenance'),
    );
    const statementsAt = steps.findIndex((st) =>
      (st.run ?? '').includes('edge_release.py statements'),
    );
    expect(provenanceAt).toBeGreaterThan(
      steps.findIndex((st) => (st.uses ?? '').startsWith('actions/download-artifact')),
    );
    expect(provenanceAt).toBeLessThan(statementsAt);
    const upload = steps.find((st) => st.with?.['name'] === 'release-provenance');
    expect(upload?.with?.['path']).toBe('dist/*.intoto.jsonl');
    const download = (release.wf.jobs['release']?.steps ?? []).find(
      (st) => st.with?.['name'] === 'release-provenance',
    );
    expect(download?.with?.['path']).toBe('artifacts');
  });

  it('lints every release feature set with the gateway clippy gate (INFRA-HIGH-237)', () => {
    const lintArgs = (wf: Workflow, job: string): string[] => {
      const run = (wf.jobs[job]?.steps ?? [])
        .map((st) => st.run ?? '')
        .find((r) => r.includes('cargo clippy'));
      if (run === undefined) throw new Error(`no cargo clippy in ${job}`);
      return run.split(' -- ')[1]?.trim().split(/\s+/) ?? [];
    };
    const clippy = ciEdge.wf.jobs['profile-clippy'];
    expect(clippy?.strategy?.matrix).toBe('${{ fromJSON(needs.plan.outputs.test_matrix) }}');
    expect((clippy?.steps ?? []).map((st) => st.run ?? '').join('\n')).toContain(
      'cargo clippy --locked --all-targets --no-default-features --features "$FEATURES" --',
    );
    expect(lintArgs(ciEdge.wf, 'profile-clippy')).toEqual(lintArgs(gateway.wf, 'clippy'));
    expect(lintArgs(ciEdge.wf, 'profile-clippy')).toEqual(
      expect.arrayContaining(['-D', 'clippy::correctness']),
    );
    expect(needs(ciEdge.wf.jobs['ci-edge-summary'] ?? {})).toContain('profile-clippy');
  });

  it('publishes only after every statement verified, and publishes the statements', () => {
    const publish = release.wf.jobs['release'];
    expect(needs(publish ?? {})).toContain('sign-release-statement');
    const steps = publish?.steps ?? [];
    const at = (pred: (s: (typeof steps)[number]) => boolean): number => steps.findIndex(pred);
    const verifyAt = at((s) => (s.run ?? '').includes('edge_release.py verify'));
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(verifyAt).toBeLessThan(at((s) => (s.run ?? '').includes('cosign sign-blob')));
    expect(verifyAt).toBeLessThan(
      at((s) => (s.uses ?? '').startsWith('softprops/action-gh-release')),
    );
    const gh = steps.find((s) => (s.uses ?? '').startsWith('softprops/action-gh-release'));
    expect(String(gh?.with?.['files'])).toContain('artifacts/*.release.dsse.json');
    // The body comes from the plan: every artifact, and each board not shipped.
    expect(gh?.with?.['body_path']).toBe('release-notes.md');
    expect(gh?.with?.['body']).toBeUndefined();
    const notesAt = at((s) => (s.run ?? '').includes('edge_release.py notes'));
    expect(notesAt).toBeGreaterThanOrEqual(0);
    expect(notesAt).toBeLessThan(
      at((s) => (s.uses ?? '').startsWith('softprops/action-gh-release')),
    );
  });

  it('keeps no workflow below sens-api-gateway (GitHub runs only the root .github)', () => {
    expect(existsSync(join(REPO_ROOT, 'sens-api-gateway', '.github'))).toBe(false);
  });
});

describe('edge release statements (scripts/edge/edge_release.py)', () => {
  let run: ReturnType<typeof releaseRun>;
  beforeAll(() => {
    run = releaseRun();
  });
  afterAll(() => {
    removeFixtureTree(run.dir);
  });

  it('packs exactly the contract member, root-owned and executable, reproducibly', () => {
    for (const row of osRows) {
      const archive = readFileSync(join(run.art, row.artifact));
      expect(tarMembers(archive)).toEqual([
        { name: row.binary_name, mode: 0o755, uid: 0, type: '0' },
      ]);
      const again = join(run.dir, 'again');
      const bin = join(run.dir, `${row.channel}-${row.id}.bin`);
      ok(
        tool(
          [
            'package',
            '--channel',
            row.channel,
            '--id',
            row.id,
            '--binary',
            bin,
            '--out-dir',
            again,
          ],
          GITHUB_ENV,
        ),
      );
      expect(sha256(readFileSync(join(again, row.artifact)))).toBe(sha256(archive));
    }
  });

  it('signs a statement per planned row that passes the contract and names exactly the artifact bytes', () => {
    const files = readdirSync(run.statements)
      .filter((n) => n.endsWith('.release.dsse.json'))
      .sort();
    expect(files).toEqual(osRows.map((r) => r.statement).sort());
    const publicKey = createPublicKey(readFileSync(join(run.statements, 'edge-release.pub')));
    for (const row of osRows) {
      const envelope = readJson(join(run.statements, row.statement));
      expect(schemaErrors('dsse-envelope', envelope)).toEqual([]);
      expect(envelope['payloadType']).toBe(statementEntry['payload_type']);
      const sig = obj(list(envelope['signatures'])[0]);
      expect(sig['keyid']).toBe(run.key.keyid);
      const payload = Buffer.from(str(envelope['payload']), 'base64');
      const type = str(envelope['payloadType']);
      const pae = Buffer.concat([
        Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
        payload,
      ]);
      expect(verify(null, pae, publicKey, Buffer.from(str(sig['sig']), 'base64'))).toBe(true);

      const body = JSON.parse(payload.toString('utf8')) as JsonObject;
      expect(schemaErrors('edge-release', body)).toEqual([]);
      const board = obj(boards.find((b) => b['board_profile'] === row.id));
      expect(body['board_profile']).toBe(row.id);
      expect(body['version']).toBe(VERSION);
      expect(body['arch']).toBe(board['arch']);
      expect(body['agent_profile']).toBe(board['agent_profile']);
      expect(body['cargo_features']).toEqual(list(board['cargo_features']).map(str).sort());
      expect(body['required_kernel_config']).toEqual(
        [...(facts.suderra_os.required_kernel_config[row.id] ?? [])].sort(),
      );
      const archive = readFileSync(join(run.art, row.artifact));
      const artifact = obj(body['artifact']);
      expect(artifact['name']).toBe(row.artifact);
      expect(artifact['size_bytes']).toBe(archive.length);
      expect(artifact['digest']).toEqual({ sha256: sha256(archive) });
      expect(artifact['binary_digest']).toEqual({
        sha256: sha256(readFileSync(join(run.dir, `${row.channel}-${row.id}.bin`))),
      });
      expect(obj(body['provenance'])['digest']).toEqual({
        sha256: sha256(readFileSync(join(run.art, `${row.base}.intoto.jsonl`))),
      });
    }
  });

  it('verifies the release it signed, and refuses tampered bytes with the contract reasons', () => {
    const verifyArgs = (statements: string, art: string): string[] => [
      'verify',
      '--artifacts',
      art,
      '--statements',
      statements,
      '--public-key',
      join(run.statements, 'edge-release.pub'),
      '--expect-keyid',
      run.key.keyid,
    ];
    ok(tool(verifyArgs(run.statements, run.art)));
    const row = osRows[0];
    if (row === undefined) throw new Error('no Suderra OS row planned');

    // Another archive under the planned name.
    const art = join(run.dir, 'tampered-art');
    mkdirSync(art);
    for (const name of readdirSync(run.art)) copyFileSync(join(run.art, name), join(art, name));
    const bin = join(run.dir, 'other.bin');
    writeFileSync(bin, releaseElf(row, ['libm.so.6']));
    ok(
      tool(
        ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', art],
        GITHUB_ENV,
      ),
    );
    expect(tool(verifyArgs(run.statements, art)).reason).toBe('artifact-digest-mismatch');

    // A payload changed after signing.
    const statements = join(run.dir, 'tampered-statements');
    mkdirSync(statements);
    for (const name of readdirSync(run.statements))
      copyFileSync(join(run.statements, name), join(statements, name));
    const envelope = readJson(join(statements, row.statement));
    const body = JSON.parse(
      Buffer.from(str(envelope['payload']), 'base64').toString('utf8'),
    ) as JsonObject;
    body['security_version'] = Number(body['security_version']) + 1;
    envelope['payload'] = Buffer.from(JSON.stringify(body)).toString('base64');
    writeFileSync(join(statements, row.statement), JSON.stringify(envelope));
    expect(tool(verifyArgs(statements, run.art)).reason).toBe('signature-invalid');

    // A statement verified against a key other than the expected one.
    const other = newKey();
    expect(
      tool([
        'verify',
        '--artifacts',
        run.art,
        '--statements',
        run.statements,
        '--public-key',
        join(run.statements, 'edge-release.pub'),
        '--expect-keyid',
        other.keyid,
      ]).reason,
    ).toBe('key-unknown');
  });

  it('refuses a signing key other than the expected one, and every TEST-ONLY contract key', () => {
    const out = join(run.dir, 'refused');
    const signWith = (pem: string, keyid: string): ToolRun =>
      tool(
        [
          'sign',
          '--artifacts',
          run.art,
          '--payloads',
          run.payloads,
          '--out-dir',
          out,
          '--key-env',
          'EDGE_RELEASE_SIGNING_KEY',
          '--expect-keyid',
          keyid,
        ],
        { EDGE_RELEASE_SIGNING_KEY: pem },
      );
    const other = newKey();
    const wrong = signWith(other.pem, run.key.keyid);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('is not the expected edge-release keyid');

    const testKey = obj(
      list(keyring['keys'])
        .map(obj)
        .find((k) => k['purpose'] === 'edge-release'),
    );
    const seed = createHash('sha256').update(str(testKey['seed_label'])).digest();
    const pem = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const refused = signWith(pem, str(testKey['keyid']));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('TEST-ONLY');
    expect(existsSync(join(out, osRows[0]?.statement ?? ''))).toBe(false);
  });

  it('refuses binaries for another machine or linking outside the OS runtime (DEC-8.5)', () => {
    const row = osRows.find((r) => r.arch === 'aarch64') ?? osRows[0];
    if (row === undefined) throw new Error('no Suderra OS row planned');
    const out = join(run.dir, 'refused-elf');
    const bin = join(run.dir, 'refused.bin');
    const other = Object.keys(ELF_MACHINE).find((a) => a !== row.arch && a !== 'armv7') ?? 'x86_64';
    writeFileSync(bin, elf(other, facts.runtime[other]?.interpreter ?? '', ['libc.so.6']));
    expect(
      tool(
        ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', out],
        GITHUB_ENV,
      ).reason,
    ).toBe('archive-invalid');
    writeFileSync(bin, releaseElf(row, ['libudev.so.1']));
    const linked = tool(
      ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', out],
      GITHUB_ENV,
    );
    expect(linked.reason).toBe('archive-invalid');
    expect(linked.stderr).toContain('libudev.so.1');
    writeFileSync(bin, Buffer.from('#!/bin/sh\n'));
    expect(
      tool(
        ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', out],
        GITHUB_ENV,
      ).reason,
    ).toBe('archive-invalid');
  });

  it('refuses an archive that does not hold exactly the contract member', () => {
    const row = osRows[0];
    if (row === undefined) throw new Error('no Suderra OS row planned');
    const art = join(run.dir, 'bad-archive');
    mkdirSync(art);
    for (const name of readdirSync(run.art)) copyFileSync(join(run.art, name), join(art, name));
    const staging = join(run.dir, 'staging');
    mkdirSync(staging);
    copyFileSync(join(run.dir, `${row.channel}-${row.id}.bin`), join(staging, 'edge-agent'));
    const tar = spawnSync('tar', ['-czf', join(art, row.artifact), '-C', staging, 'edge-agent']);
    expect(tar.status).toBe(0);
    const result = tool([
      'statements',
      '--artifacts',
      art,
      '--out-dir',
      join(run.dir, 'bad-payloads'),
    ]);
    expect(result.reason).toBe('archive-invalid');
    expect(result.stderr).toContain("['edge-agent']");
  });

  it('agrees with the contract fixtures on every check it makes without a key', () => {
    const index = list(readJson(join(CONTRACT, 'fixtures', 'index.json'))['statements']).map(obj);
    const keyFree = new Set([
      'envelope-invalid',
      'payload-type-mismatch',
      'payload-json-invalid',
      'schema-invalid',
      'release-profile-mismatch',
    ]);
    const cases = index.filter(
      (e) =>
        e['statement_type'] === STATEMENT_TYPE &&
        e['device_context'] === null &&
        e['mode'] === 'accept',
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      const path = join(CONTRACT, 'fixtures', str(entry['path']));
      const result = tool(['check-envelope', '--envelope', path]);
      const reason = entry['expect'] === 'accept' ? undefined : str(entry['reason']);
      if (reason === undefined || !keyFree.has(reason)) {
        expect({ fixture: entry['path'], status: result.status, stderr: result.stderr }).toEqual({
          fixture: entry['path'],
          status: 0,
          stderr: '',
        });
      } else {
        expect({ fixture: entry['path'], reason: result.reason }).toEqual({
          fixture: entry['path'],
          reason,
        });
      }
    }
  });
});

/**
 * The publish gate (`verify`, and `sign` before it lets a statement out): one
 * case per check, each a statement or artifact that passes every other check,
 * so removing that check lets the case through.
 */
describe('edge release publish gate (scripts/edge/edge_release.py verify and sign)', () => {
  let run: ReturnType<typeof releaseRun>;
  let row: Row;
  beforeAll(() => {
    run = releaseRun();
    const first = osRows[0];
    if (first === undefined) throw new Error('no Suderra OS row planned');
    row = first;
  });
  afterAll(() => {
    removeFixtureTree(run.dir);
  });
  const verifyArgs = (statements: string, art: string = run.art): string[] => [
    'verify',
    '--artifacts',
    art,
    '--statements',
    statements,
    '--public-key',
    join(run.statements, 'edge-release.pub'),
    '--expect-keyid',
    run.key.keyid,
  ];
  const canonicalPayload = (body: JsonObject): Buffer => Buffer.from(canonicalJson(body));
  let n = 0;
  const fresh = (label: string): string => join(run.dir, `${label}-${(n += 1)}`);

  it('verifies with the contract verify_strict semantics, not a cofactorless verifier', () => {
    const results = JSON.parse(ok(tool(['signature-vectors']))) as {
      id: string;
      expected: boolean;
      verified: boolean;
    }[];
    const vectors = list(
      readJson(join(CONTRACT, 'fixtures', 'dsse', 'signature-vectors.json'))['vectors'],
    ).map(obj);
    expect(results.map((r) => r.id)).toEqual(vectors.map((v) => str(v['id'])));
    expect(results.filter((r) => r.expected !== r.verified)).toEqual([]);
    // The vectors cover the cases OpenSSL and cofactorless verifiers accept.
    expect(results.map((r) => r.id)).toEqual(
      expect.arrayContaining(['small-order-public-key', 'small-order-r', 'non-canonical-a']),
    );
  });

  it('accepts a statement re-signed over its own bytes (the control for every case below)', () => {
    ok(
      tool(
        verifyArgs(resigned(run.statements, fresh('control'), row, run.key.pem, canonicalPayload)),
      ),
    );
  });

  it('refuses an envelope whose signature keyid is not the key it verifies under', () => {
    const statements = resigned(
      run.statements,
      fresh('keyid'),
      row,
      run.key.pem,
      canonicalPayload,
      newKey().keyid,
    );
    expect(tool(verifyArgs(statements)).reason).toBe('key-unknown');
  });

  it('refuses a validly signed statement that names another binary', () => {
    const statements = resigned(run.statements, fresh('binary'), row, run.key.pem, (body) => {
      obj(body['artifact'])['binary_digest'] = { sha256: 'f'.repeat(64) };
      return canonicalPayload(body);
    });
    expect(tool(verifyArgs(statements)).reason).toBe('binary-digest-mismatch');
  });

  it('refuses a validly signed statement that names other provenance', () => {
    const statements = resigned(run.statements, fresh('provenance'), row, run.key.pem, (body) => {
      obj(obj(body['provenance'])['digest'])['sha256'] = 'e'.repeat(64);
      return canonicalPayload(body);
    });
    const result = tool(verifyArgs(statements));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('names other provenance');
  });

  it('refuses a validly signed statement whose artifact name is not the contract name', () => {
    const statements = resigned(run.statements, fresh('name'), row, run.key.pem, (body) => {
      obj(body['artifact'])['name'] = `suderra-agent-os-0.0.1-${row.id}-${row.arch}.tar.gz`;
      return canonicalPayload(body);
    });
    expect(schemaErrors('edge-release', JSON.parse(readEnvelopePayload(statements, row)))).toEqual(
      [],
    );
    expect(tool(verifyArgs(statements)).reason).toBe('release-profile-mismatch');
  });

  it('leaves no statement field free: the payload must be byte for byte the release statement', () => {
    const cases: [string, (body: JsonObject) => Buffer][] = [
      [
        'security_version',
        (body) =>
          canonicalPayload({ ...body, security_version: Number(body['security_version']) - 1 }),
      ],
      [
        'required_kernel_config',
        (body) => canonicalPayload({ ...body, required_kernel_config: [] }),
      ],
      [
        'agent_abi',
        (body) => canonicalPayload({ ...body, agent_abi: Number(body['agent_abi']) + 1 }),
      ],
      // The same members, with JSON whitespace the canonical form has not.
      ['canonical form', (body) => Buffer.from(`\n${canonicalJson(body)}\n`)],
    ];
    for (const [field, payload] of cases) {
      const statements = resigned(run.statements, fresh('free'), row, run.key.pem, payload);
      expect(
        schemaErrors('edge-release', JSON.parse(readEnvelopePayload(statements, row))),
      ).toEqual([]);
      const result = tool(verifyArgs(statements));
      expect({ field, status: result.status }).toEqual({ field, status: 1 });
      expect(result.stderr).toContain('is not the statement this release makes');
      expect(result.stderr).toContain(field);
    }
  });

  it('refuses an archive of the signed size whose bytes differ', () => {
    const original = readFileSync(join(run.art, row.artifact));
    const bin = join(run.dir, `${row.channel}-${row.id}.bin`);
    let same: Buffer | undefined;
    for (let epoch = 1700000001; epoch < 1700000400 && same === undefined; epoch += 1) {
      const out = fresh('epoch');
      ok(
        tool(
          ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', out],
          { ...GITHUB_ENV, SOURCE_DATE_EPOCH: String(epoch) },
        ),
      );
      const candidate = readFileSync(join(out, row.artifact));
      if (candidate.length === original.length && !candidate.equals(original)) same = candidate;
    }
    if (same === undefined) throw new Error('no same-size archive with other bytes found');
    const art = copyDir(run.art, fresh('same-size'));
    writeFileSync(join(art, row.artifact), same);
    expect(tool(verifyArgs(run.statements, art)).reason).toBe('artifact-digest-mismatch');
  });

  it('refuses an archive member that is a symlink or not executable', () => {
    const bin = join(run.dir, `${row.channel}-${row.id}.bin`);
    const plain = fresh('plain');
    mkdirSync(plain);
    copyFileSync(bin, join(plain, row.binary_name));
    chmodSync(join(plain, row.binary_name), 0o644);
    const link = fresh('link');
    mkdirSync(link);
    copyFileSync(bin, join(link, 'target'));
    symlinkSync('target', join(link, row.binary_name));
    for (const staging of [plain, link]) {
      const art = copyDir(run.art, fresh('member'));
      const tar = spawnSync('tar', [
        '--owner=0',
        '--group=0',
        '-czf',
        join(art, row.artifact),
        '-C',
        staging,
        row.binary_name,
      ]);
      expect(tar.status).toBe(0);
      const result = tool(verifyArgs(run.statements, art));
      expect(result.reason).toBe('archive-invalid');
      expect(result.stderr).toContain('is not an executable regular file');
    }
  });

  it('signs nothing when a payload is not this release statement', () => {
    const payloads = copyDir(run.payloads, fresh('payloads'));
    const path = join(payloads, `${row.artifact}.release.payload.json`);
    const body = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    obj(body['artifact'])['binary_digest'] = { sha256: 'f'.repeat(64) };
    writeFileSync(path, canonicalJson(body));
    const out = fresh('signed');
    const result = tool(
      [
        'sign',
        '--artifacts',
        run.art,
        '--payloads',
        payloads,
        '--out-dir',
        out,
        '--key-env',
        'EDGE_RELEASE_SIGNING_KEY',
        '--expect-keyid',
        run.key.keyid,
      ],
      { EDGE_RELEASE_SIGNING_KEY: run.key.pem },
    );
    expect(result.reason).toBe('binary-digest-mismatch');
    expect(existsSync(out)).toBe(false);
  });

  it('verifies every signature it made before a statement leaves the signing job', () => {
    const real = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
    expect(real).not.toBe('');
    const fakebin = fresh('fakebin');
    mkdirSync(fakebin);
    // An OpenSSL whose Ed25519 signatures do not verify.
    writeFileSync(
      join(fakebin, 'openssl'),
      [
        '#!/bin/sh',
        'if [ "$1" = "pkeyutl" ] && [ "$2" = "-sign" ]; then',
        `  "${real}" "$@" | python3 -I -c 'import sys; d = bytearray(sys.stdin.buffer.read()); d[0] ^= 1; sys.stdout.buffer.write(bytes(d))'`,
        '  exit 0',
        'fi',
        `exec "${real}" "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(fakebin, 'openssl'), 0o755);
    const result = tool(
      [
        'sign',
        '--artifacts',
        run.art,
        '--payloads',
        run.payloads,
        '--out-dir',
        fresh('bad-signer'),
        '--key-env',
        'EDGE_RELEASE_SIGNING_KEY',
        '--expect-keyid',
        run.key.keyid,
      ],
      { EDGE_RELEASE_SIGNING_KEY: run.key.pem, PATH: `${fakebin}:${process.env['PATH'] ?? ''}` },
    );
    expect(result.reason).toBe('signature-invalid');
  });

  it('refuses a binary with the right machine but another program interpreter', () => {
    const out = fresh('interp');
    const bin = join(out, 'musl.bin');
    mkdirSync(out);
    writeFileSync(bin, releaseElf(row, [], BASELINE_VERSION_NEEDS, '/lib/ld-musl-x86_64.so.1'));
    const result = tool(
      ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', out],
      GITHUB_ENV,
    );
    expect(result.reason).toBe('archive-invalid');
    expect(result.stderr).toContain('program interpreter');
  });

  it("refuses a binary that needs a newer glibc than its channel's, or glibc's private ABI", () => {
    const next = (version: string): string => {
      const [major, minor] = version.split('.').map(Number);
      return `GLIBC_${major}.${(minor ?? 0) + 1}`;
    };
    const packageWith = (target: Row, needs: string[]): ToolRun => {
      const out = fresh('glibc');
      mkdirSync(out);
      const bin = join(out, 'glibc.bin');
      writeFileSync(bin, releaseElf(target, [], [{ file: 'libc.so.6', versions: needs }]));
      return tool(
        [
          'package',
          '--channel',
          target.channel,
          '--id',
          target.id,
          '--binary',
          bin,
          '--out-dir',
          out,
        ],
        GITHUB_ENV,
      );
    };
    const osCap = `GLIBC_${facts.suderra_os.max_glibc}`;
    ok(packageWith(row, ['GLIBC_2.17', osCap]));
    const tooNew = packageWith(row, ['GLIBC_2.17', next(facts.suderra_os.max_glibc)]);
    expect(tooNew.reason).toBe('archive-invalid');
    expect(tooNew.stderr).toContain(next(facts.suderra_os.max_glibc));
    const privateAbi = packageWith(row, ['GLIBC_PRIVATE']);
    expect(privateAbi.reason).toBe('archive-invalid');
    expect(privateAbi.stderr).toContain('GLIBC_PRIVATE');

    // The generic channel has its own, lower ceiling (DEC-28).
    const generic = genericRows.find((r) => r.arch === row.arch);
    if (generic === undefined) throw new Error(`no generic row for ${row.arch}`);
    const genericNext = next(facts.generic_channel.max_glibc);
    ok(packageWith(row, [genericNext]));
    const genericTooNew = packageWith(generic, [genericNext]);
    expect(genericTooNew.reason).toBe('archive-invalid');
    expect(genericTooNew.stderr).toContain(genericNext);
  });

  it('states in the release body what each channel ships and which boards it does not', () => {
    const out = join(fresh('notes'), 'release-notes.md');
    mkdirSync(join(out, '..'));
    ok(
      tool(
        ['notes', '--tag', `agent-v${VERSION}`, '--statement-keyid', run.key.keyid, '--out', out],
        GITHUB_ENV,
      ),
    );
    const text = readFileSync(out, 'utf8');
    for (const r of plan.build.include) expect(text).toContain(r.artifact);
    for (const r of osRows) expect(text).toContain(r.statement);
    for (const [board, entry] of Object.entries(facts.suderra_os.unbuildable ?? {})) {
      expect(text).toContain(`\`${board}\``);
      expect(text).toContain(entry.blocked_by);
    }
    expect(text).toContain(run.key.keyid);
  });
});

describe('edge release plan refusals', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'edge-release-plan-'));
  });
  afterAll(() => {
    removeFixtureTree(dir);
  });
  const factsText = readFileSync(FACTS, 'utf8');
  const cargoText = readFileSync(CARGO_TOML, 'utf8');
  const planWith = (factsBody: string, cargoBody: string = cargoText): ToolRun => {
    const f = join(dir, `facts-${sha256(factsBody + cargoBody).slice(0, 12)}.toml`);
    const c = join(dir, `cargo-${sha256(cargoBody).slice(0, 12)}.toml`);
    writeFileSync(f, factsBody);
    writeFileSync(c, cargoBody);
    return tool(['--facts', f, '--cargo-toml', c, 'plan']);
  };

  it('fails when an unbuildable board can be built, so the entry cannot outlive its reason', () => {
    const [board] = Object.keys(facts.suderra_os.unbuildable ?? {});
    if (board === undefined) return;
    const features = list(
      obj(boards.find((b) => b['board_profile'] === board))['cargo_features'],
    ).map(str);
    const missing = features.filter((f) => !(f in cargo.features));
    const withFeatures = cargoText.replace(
      /^\[features\]\n/m,
      `[features]\n${missing.map((f) => `${f} = []`).join('\n')}\n`,
    );
    const result = planWith(factsText, withFeatures);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('remove the entry');
  });

  it('fails when a board needs a cargo feature the crate lacks and no finding tracks it', () => {
    const withoutEntries = factsText.replace(/\n\[suderra_os\.unbuildable\.[^\]]+\][^[]*/g, '\n');
    if (withoutEntries === factsText) return;
    const result = planWith(withoutEntries);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not define');
  });

  it('fails when the kernel requirements do not name exactly the boards', () => {
    const result = planWith(factsText.replace(/^qemu-x86_64 = .*\n/m, ''));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required_kernel_config');
  });

  it('fails when a release fact would not pass the contract schema', () => {
    const result = planWith(factsText.replace(/^min_os_version = .*$/m, 'min_os_version = "1.0"'));
    expect(result.reason).toBe('schema-invalid');
  });

  it('plans and states only the Cargo version it is told to release', () => {
    for (const command of [['plan'], ['statements', '--artifacts', dir, '--out-dir', dir]]) {
      const result = tool([...command, '--expect-version', `${VERSION}-not`]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`is not the Cargo version ${VERSION}`);
    }
  });

  it('fails when the extra build features name no finding that removes them', () => {
    const result = planWith(factsText.replace(/^crate_required_features_tracked_by = .*\n/m, ''));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('crate_required_features_tracked_by');
  });

  it('fails closed on a contract schema keyword its validator does not implement', () => {
    const contract = join(dir, 'contract');
    for (const name of ['boards.json', 'artifact-naming.json', 'statements.json']) {
      cpSync(join(CONTRACT, name), join(contract, name));
    }
    for (const name of ['schemas', 'test-keys']) {
      cpSync(join(CONTRACT, name), join(contract, name), { recursive: true });
    }
    ok(tool(['--contract', contract, 'plan']));
    const schemaPath = join(contract, 'schemas', 'edge-release.schema.json');
    const schema = readJson(schemaPath);
    schema['dependentRequired'] = { name: ['version'] };
    writeFileSync(schemaPath, JSON.stringify(schema));
    const result = tool(['--contract', contract, 'plan']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("schema keyword 'dependentRequired'");
    expect(result.stderr).toContain('is not implemented by this validator');
  });
});
