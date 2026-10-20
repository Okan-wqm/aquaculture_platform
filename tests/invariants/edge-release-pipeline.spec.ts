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
 *   - the workflows build only planned rows, test every feature set before
 *     packaging, use --locked everywhere, keep the release cache-free and sign
 *     in a separate, minimal job of the protected `edge-release` environment;
 *   - the tool's statements pass the contract schemas under Ajv, verify under
 *     Node's Ed25519 over the DSSE PAE, and name exactly the artifact bytes;
 *     its refusals carry the statements.json rejection reasons.
 */
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import Ajv2020 from 'ajv/dist/2020';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';

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
    unbuildable?: Record<string, { blocked_by: string; reason: string }>;
    required_kernel_config: Record<string, string[]>;
  };
  generic_channel: { cargo_features: string[] };
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

/** A minimal dynamically linked ELF executable: PT_INTERP, PT_LOAD, PT_DYNAMIC. */
function elf(arch: string, interpreter: string, needed: string[]): Buffer {
  const is64 = arch !== 'armv7';
  const machine = ELF_MACHINE[arch];
  if (machine === undefined) throw new Error(`no ELF machine for ${arch}`);
  const [ehsize, phentsize] = is64 ? [64, 56] : [52, 32];
  const phnum = 3;
  const interp = Buffer.from(`${interpreter}\0`);
  const strtab = Buffer.concat([Buffer.from('\0'), ...needed.map((n) => Buffer.from(`${n}\0`))]);
  const interpOff = ehsize + phnum * phentsize;
  const strtabOff = interpOff + interp.length;
  let dynOff = strtabOff + strtab.length;
  dynOff += (8 - (dynOff % 8)) % 8;
  const vbase = 0x400000;
  const entries: [number, number][] = [];
  let off = 1;
  for (const n of needed) {
    entries.push([1, off]);
    off += n.length + 1;
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
    const at = ehsize + i * phentsize;
    if (is64) {
      out.writeUInt32LE(type, at);
      out.writeUInt32LE(flags, at + 4);
      out.writeBigUInt64LE(BigInt(offset), at + 8);
      out.writeBigUInt64LE(BigInt(vbase + offset), at + 16);
      out.writeBigUInt64LE(BigInt(filesz), at + 32);
      out.writeBigUInt64LE(BigInt(filesz), at + 40);
      out.writeBigUInt64LE(BigInt(align), at + 48);
    } else {
      out.writeUInt32LE(type, at);
      out.writeUInt32LE(offset, at + 4);
      out.writeUInt32LE(vbase + offset, at + 8);
      out.writeUInt32LE(filesz, at + 16);
      out.writeUInt32LE(filesz, at + 20);
      out.writeUInt32LE(flags, at + 24);
      out.writeUInt32LE(align, at + 28);
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
  entries.forEach(([tag, val], i) => {
    const at = dynOff + i * dynSize;
    if (is64) {
      out.writeBigInt64LE(BigInt(tag), at);
      out.writeBigUInt64LE(BigInt(val), at + 8);
    } else {
      out.writeInt32LE(tag, at);
      out.writeUInt32LE(val, at + 4);
    }
  });
  return out;
}

function releaseElf(row: Row, extraNeeded: string[] = []): Buffer {
  const rt = facts.runtime[row.arch];
  if (rt === undefined) throw new Error(`no runtime for ${row.arch}`);
  return elf(row.arch, rt.interpreter, ['libc.so.6', 'libgcc_s.so.1', ...extraNeeded]);
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

/** One release run of the tool over stand-in binaries, in a fresh directory. */
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
  for (const row of osRows) {
    const bin = join(dir, `${row.id}.bin`);
    writeFileSync(bin, releaseElf(row));
    ok(
      tool(
        ['package', '--channel', row.channel, '--id', row.id, '--binary', bin, '--out-dir', art],
        GITHUB_ENV,
      ),
    );
    ok(
      tool(
        [
          'provenance',
          '--channel',
          row.channel,
          '--id',
          row.id,
          '--artifact',
          join(art, row.artifact),
          '--tag',
          `agent-v${VERSION}`,
          '--out-dir',
          art,
        ],
        GITHUB_ENV,
      ),
    );
  }
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
    const sign = release.wf.jobs['sign'];
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
      if (name === 'sign') continue;
      expect({ name, key: JSON.stringify(job).includes('EDGE_RELEASE_SIGNING_KEY') }).toEqual({
        name,
        key: false,
      });
    }
  });

  it('publishes only after every statement verified, and publishes the statements', () => {
    const publish = release.wf.jobs['release'];
    expect(needs(publish ?? {})).toContain('sign');
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
    rmSync(run.dir, { recursive: true, force: true });
  });

  it('packs exactly the contract member, root-owned and executable, reproducibly', () => {
    for (const row of osRows) {
      const archive = readFileSync(join(run.art, row.artifact));
      expect(tarMembers(archive)).toEqual([
        { name: row.binary_name, mode: 0o755, uid: 0, type: '0' },
      ]);
      const again = join(run.dir, 'again');
      const bin = join(run.dir, `${row.id}.bin`);
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
        sha256: sha256(readFileSync(join(run.dir, `${row.id}.bin`))),
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
    copyFileSync(join(run.dir, `${row.id}.bin`), join(staging, 'edge-agent'));
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

describe('edge release plan refusals', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'edge-release-plan-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
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
});
