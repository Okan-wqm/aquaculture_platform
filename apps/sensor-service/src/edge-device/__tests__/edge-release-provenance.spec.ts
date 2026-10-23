/**
 * Release admission against the release pipeline's own output (ADR-048 DEC-3.8,
 * DEC-20): the provenance the signing job states (`scripts/edge/edge_release.py
 * provenance`) is what the cloud's verifier reads, so the two cannot drift. The
 * pipeline runs here for real, over throw-away artifacts, for a 1.6.0 release; its
 * unsigned statement body is the contract's golden release fixture with the digests of
 * those artifacts and of that provenance, signed with the contract's TEST-ONLY
 * edge-release key, so the catalog admits it end to end.
 */
import { createHash, createPrivateKey, sign } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { ConfigService } from '@nestjs/config';

import {
  ED25519_PKCS8_PREFIX,
  FIXTURES,
  keyringFile,
  objects,
  asString,
} from '../../../../../tests/invariants/lib/suderra-edge-contract';
import { boardRow, releaseArtifactName, releaseProvenanceName } from '../edge-boards';
import { pae, payloadTypeOf, STATEMENT, type DsseEnvelope } from '../edge-contract';
import {
  AdmittedRelease,
  EdgeReleaseCatalog,
  type ReleaseStatementFetcher,
} from '../edge-release-catalog.service';
import {
  EDGE_RELEASE_WORKFLOW_PATH,
  type ProvenanceExpectation,
  releaseTag,
  verifyReleaseProvenance,
} from '../edge-release-provenance';
import { StatementAdmissionError } from '../manifest-signer';
import { SuderraEdgeConfig } from '../suderra-edge.config';
import { TrustAnchorBundleService } from '../trust-anchor-bundle.service';

const REPO = resolve(__dirname, '../../../../..');
const SCRIPT = join(REPO, 'scripts/edge/edge_release.py');
const VERSION = '1.6.0';
const REPOSITORY = 'example-org/aquaculture';
const COMMIT = 'ab'.repeat(20);
const RELEASE_URL_TEMPLATE = 'https://edge-releases.example.com/agent/{version}/{asset}';

interface PlanRow {
  readonly channel: string;
  readonly id: string;
  readonly artifact: string;
  readonly base: string;
  readonly features: string;
  readonly rust_target: string;
}

let work: string;
let revpi: PlanRow;
let artifactBytes: Buffer;
let provenanceBytes: Buffer;
let artifactSha256: string;
let pipelineEnv: Record<string, string>;
let globalArgs: string[];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function pipeline(args: string[]): string {
  return execFileSync('python3', ['-I', SCRIPT, ...globalArgs, ...args], {
    env: { PATH: process.env['PATH'] ?? '', ...pipelineEnv },
    encoding: 'utf8',
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'edge-provenance-'));
  // The pipeline reads the agent version from Cargo.toml; the facts file keeps its
  // plan free of the EDGE-HIGH-128 crate_required_features so the plan's feature set is
  // the board's, which is what the golden release statement names.
  const cargo = readFileSync(join(REPO, 'sens-api-gateway/Cargo.toml'), 'utf8').replace(
    /^version = ".*"$/m,
    `version = "${VERSION}"`,
  );
  writeFileSync(join(work, 'Cargo.toml'), cargo);
  const facts = readFileSync(join(REPO, 'sens-api-gateway/release/edge-release.toml'), 'utf8')
    .replace(/^crate_required_features = .*$/m, 'crate_required_features = []')
    .replace(/^crate_required_features_tracked_by = .*$/m, '');
  writeFileSync(join(work, 'edge-release.toml'), facts);
  globalArgs = [
    '--facts',
    join(work, 'edge-release.toml'),
    '--cargo-toml',
    join(work, 'Cargo.toml'),
  ];
  pipelineEnv = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WORKFLOW: 'Edge Agent Release',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${EDGE_RELEASE_WORKFLOW_PATH}@refs/tags/${releaseTag(VERSION)}`,
    GITHUB_SHA: COMMIT,
    GITHUB_RUN_ID: '4242',
  };
  const plan = JSON.parse(pipeline(['plan'])) as { build: { include: PlanRow[] } };
  const rows = plan.build.include;
  const found = rows.find((row) => row.channel === 'suderra-os' && row.id === 'revpi-connect4');
  if (found === undefined) throw new Error('the plan has no revpi-connect4 build');
  revpi = found;
  const artifacts = join(work, 'dist');
  mkdirSync(artifacts);
  for (const row of rows) {
    writeFileSync(
      join(artifacts, row.artifact),
      Buffer.from(`throw-away bytes of ${row.artifact}`),
    );
  }
  artifactBytes = readFileSync(join(artifacts, revpi.artifact));
  artifactSha256 = sha256(artifactBytes);
  pipeline([
    'provenance',
    '--artifacts',
    artifacts,
    '--tag',
    releaseTag(VERSION),
    '--out-dir',
    join(work, 'out'),
  ]);
  provenanceBytes = readFileSync(join(work, 'out', `${revpi.base}.intoto.jsonl`));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const expectationFor = (
  bytes: Buffer,
  over: Partial<ProvenanceExpectation> = {},
): ProvenanceExpectation => ({
  repository: REPOSITORY,
  version: VERSION,
  artifact: { name: revpi.artifact, sha256: artifactSha256 },
  boardProfile: 'revpi-connect4',
  rustTarget: revpi.rust_target,
  features: revpi.features.split(','),
  predicateType: 'https://slsa.dev/provenance/v1',
  digestSha256: sha256(bytes),
  ...over,
});

/** A provenance document edited, with the digest the (forged) signed statement would name for it. */
function edited(change: (statement: Record<string, any>) => void): { bytes: Buffer } {
  const statement = JSON.parse(provenanceBytes.toString('utf8')) as Record<string, any>;
  change(statement);
  return { bytes: Buffer.from(`${JSON.stringify(statement)}\n`) };
}

describe("the cloud names the pipeline's provenance asset", () => {
  it('is {artifact base}.intoto.jsonl, exactly as the plan names it', () => {
    const board = boardRow('revpi-connect4');
    if (board === null) throw new Error('board');
    expect(releaseArtifactName(VERSION, board)).toBe(revpi.artifact);
    expect(releaseProvenanceName(revpi.artifact)).toBe(`${revpi.base}.intoto.jsonl`);
  });

  it('the workflow the verifier expects exists at that path', () => {
    expect(() => readFileSync(join(REPO, EDGE_RELEASE_WORKFLOW_PATH), 'utf8')).not.toThrow();
  });
});

describe("verifyReleaseProvenance over the pipeline's own output", () => {
  it('accepts it and reads the repository, workflow ref, tag and commit out of it', () => {
    expect(verifyReleaseProvenance(provenanceBytes, expectationFor(provenanceBytes))).toEqual({
      digestSha256: sha256(provenanceBytes),
      repository: REPOSITORY,
      workflowRef: `${REPOSITORY}/${EDGE_RELEASE_WORKFLOW_PATH}@refs/tags/agent-v${VERSION}`,
      tag: `agent-v${VERSION}`,
      commit: COMMIT,
    });
  });

  it('refuses bytes other than the ones the signed statement names', () => {
    const tampered = Buffer.concat([provenanceBytes.subarray(0, -1), Buffer.from(' \n')]);
    expect(() => verifyReleaseProvenance(tampered, expectationFor(provenanceBytes))).toThrow(
      /not the one the signed release statement names/,
    );
  });

  const claims: ReadonlyArray<readonly [string, (s: Record<string, any>) => void, RegExp]> = [
    [
      'another in-toto type',
      (s) => {
        s['_type'] = 'https://in-toto.io/Statement/v0.1';
      },
      /in-toto Statement v1/,
    ],
    [
      'another predicate type',
      (s) => {
        s['predicateType'] = 'https://slsa.dev/provenance/v0.2';
      },
      /predicate type/,
    ],
    [
      'a subject of another name',
      (s) => {
        s['subject'][0]['name'] = 'other.tar.gz';
      },
      /subject/,
    ],
    [
      'a subject at another digest',
      (s) => {
        s['subject'][0]['digest']['sha256'] = '0'.repeat(64);
      },
      /subject/,
    ],
    [
      'a second subject',
      (s) => {
        s['subject'].push({ ...s['subject'][0] });
      },
      /subject/,
    ],
    [
      'an extra subject member',
      (s) => {
        s['subject'][0]['annotations'] = {};
      },
      /subject/,
    ],
    [
      'another repository',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['repository'] =
          'attacker/aquaculture';
      },
      /another repository/,
    ],
    [
      'another workflow ref',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['workflowRef'] =
          `${REPOSITORY}/.github/workflows/other.yml@refs/tags/agent-v${VERSION}`;
      },
      /not built by/,
    ],
    [
      'a branch instead of the tag',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['workflowRef'] =
          `${REPOSITORY}/${EDGE_RELEASE_WORKFLOW_PATH}@refs/heads/main`;
      },
      /not built by/,
    ],
    [
      'another release tag',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['releaseTag'] = 'agent-v9.9.9';
      },
      /another tag/,
    ],
    [
      'the generic channel',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['channel'] = 'generic';
      },
      /Suderra OS artifact/,
    ],
    [
      'another board',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['target'] = 'rpi4-cm4';
      },
      /another board/,
    ],
    [
      'another rust target',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['rustTarget'] =
          'x86_64-unknown-linux-gnu';
      },
      /Rust target/,
    ],
    [
      'another feature set',
      (s) => {
        s['predicate']['buildDefinition']['externalParameters']['features'] = 'suderra-os';
      },
      /feature set/,
    ],
    [
      'another source repository',
      (s) => {
        s['predicate']['buildDefinition']['resolvedDependencies'][0]['uri'] =
          'git+https://github.com/attacker/aquaculture';
      },
      /git commit/,
    ],
    [
      'a commit that is not a sha',
      (s) => {
        s['predicate']['buildDefinition']['resolvedDependencies'][0]['digest']['gitCommit'] =
          'main';
      },
      /git commit/,
    ],
    [
      'no resolved source',
      (s) => {
        s['predicate']['buildDefinition']['resolvedDependencies'] = [];
      },
      /git commit/,
    ],
    [
      'two resolved sources',
      (s) => {
        s['predicate']['buildDefinition']['resolvedDependencies'].push(
          s['predicate']['buildDefinition']['resolvedDependencies'][0],
        );
      },
      /git commit/,
    ],
  ];

  it.each(claims)(
    'refuses a document of %s even when the signed statement names its digest',
    (_label, change, reason) => {
      const { bytes } = edited(change);
      expect(() => verifyReleaseProvenance(bytes, expectationFor(bytes))).toThrow(reason);
    },
  );

  it('refuses a document that is not one statement line', () => {
    const doubled = Buffer.concat([provenanceBytes, provenanceBytes]);
    expect(() => verifyReleaseProvenance(doubled, expectationFor(doubled))).toThrow(
      /one in-toto statement line/,
    );
    const noNewline = provenanceBytes.subarray(0, -1);
    expect(() => verifyReleaseProvenance(noNewline, expectationFor(noNewline))).toThrow(
      /one in-toto statement line/,
    );
    const prose = Buffer.from('not json\n');
    expect(() => verifyReleaseProvenance(prose, expectationFor(prose))).toThrow(/not JSON/);
  });

  it('refuses the expectations of another release: version, board, artifact and repository', () => {
    const e = (over: Partial<ProvenanceExpectation>): ProvenanceExpectation =>
      expectationFor(provenanceBytes, over);
    expect(() => verifyReleaseProvenance(provenanceBytes, e({ version: '1.7.0' }))).toThrow(
      /not built by|another tag/,
    );
    expect(() => verifyReleaseProvenance(provenanceBytes, e({ boardProfile: 'rpi4-cm4' }))).toThrow(
      /another board/,
    );
    expect(() =>
      verifyReleaseProvenance(
        provenanceBytes,
        e({ artifact: { name: revpi.artifact, sha256: '0'.repeat(64) } }),
      ),
    ).toThrow(/subject/);
    expect(() =>
      verifyReleaseProvenance(provenanceBytes, e({ repository: 'other-org/aquaculture' })),
    ).toThrow(/another repository/);
  });

  it('every refusal is a StatementAdmissionError naming the artifact', () => {
    try {
      verifyReleaseProvenance(Buffer.from('x\n'), expectationFor(provenanceBytes));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(StatementAdmissionError);
      expect((error as Error).message).toContain(revpi.artifact);
    }
  });
});

// ---------------------------------------------------------------- the catalog

const releaseKey = (): ReturnType<typeof createPrivateKey> => {
  const entry = objects(keyringFile['keys'], 'keys').find(
    (key) => key['purpose'] === 'edge-release' && key['epoch'] === 1,
  );
  if (entry === undefined) throw new Error('keyring has no edge-release key');
  const seed = createHash('sha256').update(asString(entry['seed_label'], 'seed_label')).digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
};

function signedStatement(provenance: Buffer): string {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES, 'edge-release/valid/revpi-connect4-aarch64-1.6.0.dsse.json'),
      'utf8',
    ),
  ) as DsseEnvelope;
  const body = JSON.parse(Buffer.from(fixture.payload, 'base64').toString('utf8')) as Record<
    string,
    any
  >;
  body['artifact']['digest'] = { sha256: artifactSha256 };
  body['artifact']['size_bytes'] = artifactBytes.length;
  body['provenance']['digest'] = { sha256: sha256(provenance) };
  // Members in code point order, no whitespace: the form the contract signs.
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : value;
  const payload = Buffer.from(JSON.stringify(sorted(body)));
  const type = payloadTypeOf(STATEMENT.edgeRelease);
  const sig = sign(null, pae(type, payload), releaseKey());
  return JSON.stringify({
    payloadType: type,
    payload: payload.toString('base64'),
    signatures: [{ keyid: fixture.signatures[0].keyid, sig: sig.toString('base64') }],
  });
}

function catalog(
  statement: string,
  provenance: Buffer | 'missing',
  repository = REPOSITORY,
): EdgeReleaseCatalog {
  const env = channelEnvWith(repository);
  const config = new SuderraEdgeConfig(new ConfigService(env));
  const fetcher: ReleaseStatementFetcher = async (url) => {
    if (url.endsWith('.release.dsse.json')) return statement;
    if (url.endsWith('.intoto.jsonl')) {
      if (provenance === 'missing')
        throw new StatementAdmissionError('The provenance', 'answered 404');
      return provenance.toString('utf8');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return new EdgeReleaseCatalog(
    config,
    new TrustAnchorBundleService(config),
    fetcher,
    verifyReleaseProvenance,
  );
}

// A full channel over the contract's TEST-ONLY keys: reuse the golden spec's environment shape.
import { channelEnvironment } from './support/edge-channel-env';
const channelEnvWith = (repository: string): Record<string, string> =>
  channelEnvironment({
    SUDERRA_EDGE_RELEASE_URL_TEMPLATE: RELEASE_URL_TEMPLATE,
    SUDERRA_EDGE_RELEASE_REPOSITORY: repository,
    SUDERRA_EDGE_AGENT_VERSION: VERSION,
  });

describe('the catalog admits a release only with its provenance', () => {
  const board = (): NonNullable<ReturnType<typeof boardRow>> => {
    const row = boardRow('revpi-connect4');
    if (row === null) throw new Error('board');
    return row;
  };

  it("admits the statement and the pipeline's provenance, and the result is an AdmittedRelease", async () => {
    const release = await catalog(signedStatement(provenanceBytes), provenanceBytes).forBoard(
      board(),
    );
    expect(AdmittedRelease.is(release)).toBe(true);
    expect(release).toMatchObject({
      version: VERSION,
      boardProfile: 'revpi-connect4',
      artifact: { sizeBytes: artifactBytes.length, sha256: artifactSha256 },
      provenance: { repository: REPOSITORY, commit: COMMIT, tag: `agent-v${VERSION}` },
    });
    expect(release.statementUrl).toBe(
      `https://edge-releases.example.com/agent/${VERSION}/${revpi.artifact}.release.dsse.json`,
    );
  });

  it('a structurally similar object is not an admitted release', () => {
    expect(AdmittedRelease.is({ version: VERSION })).toBe(false);
    expect(AdmittedRelease.is(null)).toBe(false);
  });

  it('refuses a release whose provenance cannot be fetched: no admission without it', async () => {
    await expect(
      catalog(signedStatement(provenanceBytes), 'missing').forBoard(board()),
    ).rejects.toThrow(StatementAdmissionError);
  });

  it('refuses a provenance other than the one the signed statement names', async () => {
    const other = edited((s) => {
      s['predicate']['buildDefinition']['externalParameters']['target'] = 'rpi4-cm4';
    }).bytes;
    await expect(
      catalog(signedStatement(provenanceBytes), other).forBoard(board()),
    ).rejects.toThrow(/not the one the signed release statement names/);
  });

  it('refuses a statement that names a forged provenance, even one that is internally consistent', async () => {
    const forged = edited((s) => {
      s['predicate']['buildDefinition']['externalParameters']['repository'] =
        'attacker/aquaculture';
    }).bytes;
    await expect(catalog(signedStatement(forged), forged).forBoard(board())).rejects.toThrow(
      /another repository/,
    );
  });

  it('refuses when the deployment trusts another repository', async () => {
    await expect(
      catalog(signedStatement(provenanceBytes), provenanceBytes, 'other-org/aquaculture').forBoard(
        board(),
      ),
    ).rejects.toThrow(/another repository/);
  });

  it('forVersion refuses a version that is not a path-safe semantic version, before any fetch', async () => {
    const c = catalog(signedStatement(provenanceBytes), provenanceBytes);
    for (const version of ['', '1.6', '../../etc', '1.6.0+build', '1.6.0/../x', 'v1.6.0']) {
      await expect(c.forVersion(board(), version)).rejects.toThrow(/path-safe semantic version/);
    }
  });
});
