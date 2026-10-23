import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  type DsseEnvelope,
  payloadTypeOf,
  type Sha256Digest,
  STATEMENT,
  statementDigest,
} from './edge-contract';
import {
  type BoardRow,
  RELEASE_ARTIFACT_FORMAT,
  RELEASE_BINARY_NAME,
  releaseArtifactName,
  releaseProvenanceName,
  releaseStatementName,
} from './edge-boards';
import { isContractSemver } from './edge-contract';
import { type VerifiedProvenance, verifyReleaseProvenance } from './edge-release-provenance';
import { admitEnvelope, StatementAdmissionError } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';
import { TrustAnchorBundleService } from './trust-anchor-bundle.service';

/**
 * The release a Suderra OS manifest names (ADR-048 DEC-1, DEC-3.1, DEC-3.8,
 * DEC-23). The release workflow publishes one `suderra.edge-release.v1`
 * statement per (board_profile, arch) beside its artifact, signed by the
 * edge-release key; the cloud fetches the statement of the configured
 * version for the device's board, admits it against the bundle's
 * edge-release anchor and the board's contract row, and names it by
 * statement digest. Integrity of the artifact comes from that statement,
 * never from the URL (edge-provisioning.schema.json `artifact_url`).
 *
 * Admission is two checks, both before anything names the release: the
 * statement's signature, board and name, and the provenance document the
 * statement names by digest (edge-release-provenance.ts: the expected
 * repository's release workflow built this artifact from this tag). An
 * {@link AdmittedRelease} exists only as the catalog's answer — the brand below
 * makes every other way to obtain one a compile error — so a provisioning
 * manifest or an update statement cannot name a release that was not admitted.
 */

/** What admission read out of a release statement and its provenance. */
export interface AdmittedReleaseFacts {
  readonly envelope: DsseEnvelope;
  readonly payloadBytes: Buffer;
  readonly digest: Sha256Digest;
  readonly version: string;
  readonly securityVersion: number;
  readonly boardProfile: string;
  readonly arch: string;
  readonly minOsVersion: string;
  readonly agentAbi: number;
  readonly artifactUrl: string;
  /** The artifact's own size and digest, as the signed statement states them. */
  readonly artifact: { readonly sizeBytes: number; readonly sha256: string };
  /** The release statement URL a statement names (`release_statement.url`). */
  readonly statementUrl: string;
  readonly provenance: VerifiedProvenance;
}

/**
 * A release that passed admission. A class with a private member, so no object
 * literal is one: the only constructor call is the catalog's own, after the
 * statement and its provenance verified (tests/invariants/edge-release-admission.spec.ts
 * fails the build when `new AdmittedRelease(` appears anywhere else).
 */
export class AdmittedRelease implements AdmittedReleaseFacts {
  readonly #admitted = true;
  readonly envelope: DsseEnvelope;
  readonly payloadBytes: Buffer;
  readonly digest: Sha256Digest;
  readonly version: string;
  readonly securityVersion: number;
  readonly boardProfile: string;
  readonly arch: string;
  readonly minOsVersion: string;
  readonly agentAbi: number;
  readonly artifactUrl: string;
  readonly artifact: { readonly sizeBytes: number; readonly sha256: string };
  readonly statementUrl: string;
  readonly provenance: VerifiedProvenance;

  constructor(facts: AdmittedReleaseFacts) {
    this.envelope = facts.envelope;
    this.payloadBytes = facts.payloadBytes;
    this.digest = facts.digest;
    this.version = facts.version;
    this.securityVersion = facts.securityVersion;
    this.boardProfile = facts.boardProfile;
    this.arch = facts.arch;
    this.minOsVersion = facts.minOsVersion;
    this.agentAbi = facts.agentAbi;
    this.artifactUrl = facts.artifactUrl;
    this.artifact = facts.artifact;
    this.statementUrl = facts.statementUrl;
    this.provenance = facts.provenance;
  }

  /** True for a release the catalog admitted (not for a structurally similar object). */
  static is(value: unknown): value is AdmittedRelease {
    return typeof value === 'object' && value !== null && #admitted in value;
  }
}

/** Checks a provenance document; injectable so a fixture-only test needs no pipeline output. */
export type ReleaseProvenanceVerifier = typeof verifyReleaseProvenance;
export const RELEASE_PROVENANCE_VERIFIER = Symbol('RELEASE_PROVENANCE_VERIFIER');

/** Fetches a release statement by URL; injectable so tests need no network. */
export type ReleaseStatementFetcher = (url: string) => Promise<string>;
export const RELEASE_STATEMENT_FETCHER = Symbol('RELEASE_STATEMENT_FETCHER');

const MAX_STATEMENT_BYTES = 64 * 1024;

/**
 * Reads at most MAX_STATEMENT_BYTES of the body, refusing the rest as it
 * streams: a declared or actual larger body is refused without being
 * buffered, and the body must be UTF-8.
 */
export const fetchReleaseStatement: ReleaseStatementFetcher = async (url) => {
  const what = 'The release statement';
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new StatementAdmissionError(what, `${url} answered ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_STATEMENT_BYTES) {
    if (response.body !== null) await response.body.cancel();
    throw new StatementAdmissionError(what, 'it exceeds 64 KiB');
  }
  if (response.body === null) {
    throw new StatementAdmissionError(what, `${url} answered with no body`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_STATEMENT_BYTES) {
      await reader.cancel();
      throw new StatementAdmissionError(what, 'it exceeds 64 KiB');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new StatementAdmissionError(what, 'it is not UTF-8');
  }
};

/** suderra.edge-release.v1, the members the cloud reads (edge-release.schema.json). */
interface ReleaseBody {
  readonly type: unknown;
  readonly name: unknown;
  readonly version: unknown;
  readonly boardProfile: unknown;
  readonly arch: unknown;
  readonly agentProfile: unknown;
  readonly cargoFeatures: readonly string[];
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly securityVersion: number;
  readonly minOsVersion: string;
  readonly agentAbi: number;
  readonly provenance: { readonly predicateType: string; readonly digestSha256: string };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the admitted payload's members, refusing a payload of another shape. */
function parseReleaseBody(what: string, payloadBytes: Buffer): ReleaseBody {
  let body: unknown;
  try {
    body = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new StatementAdmissionError(what, 'its payload is not JSON');
  }
  if (!isRecord(body)) throw new StatementAdmissionError(what, 'its payload is not an object');
  const features = body['cargo_features'];
  const artifact = body['artifact'];
  const securityVersion = body['security_version'];
  const minOsVersion = body['min_os_version'];
  const agentAbi = body['agent_abi'];
  const provenance = body['provenance'];
  const provenanceDigest = isRecord(provenance) ? provenance['digest'] : undefined;
  if (
    !isRecord(provenance) ||
    typeof provenance['predicate_type'] !== 'string' ||
    !isRecord(provenanceDigest) ||
    typeof provenanceDigest['sha256'] !== 'string' ||
    !Array.isArray(features) ||
    !features.every((f): f is string => typeof f === 'string') ||
    !isRecord(artifact) ||
    typeof securityVersion !== 'number' ||
    typeof minOsVersion !== 'string' ||
    typeof agentAbi !== 'number'
  ) {
    throw new StatementAdmissionError(what, 'its payload is not a suderra.edge-release.v1 body');
  }
  return {
    type: body['_type'],
    name: body['name'],
    version: body['version'],
    boardProfile: body['board_profile'],
    arch: body['arch'],
    agentProfile: body['agent_profile'],
    cargoFeatures: [...features].sort(),
    artifact,
    securityVersion,
    minOsVersion,
    agentAbi,
    provenance: {
      predicateType: provenance['predicate_type'],
      digestSha256: provenanceDigest['sha256'],
    },
  };
}

function asEnvelope(text: string): DsseEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StatementAdmissionError('The release statement', 'it is not JSON');
  }
  if (!isRecord(parsed)) {
    throw new StatementAdmissionError('The release statement', 'it is not a DSSE envelope');
  }
  const { payloadType, payload, signatures } = parsed;
  if (
    typeof payloadType !== 'string' ||
    typeof payload !== 'string' ||
    !Array.isArray(signatures) ||
    signatures.length !== 1
  ) {
    throw new StatementAdmissionError('The release statement', 'it is not a DSSE envelope');
  }
  const [signature]: unknown[] = signatures;
  if (
    !isRecord(signature) ||
    typeof signature['keyid'] !== 'string' ||
    typeof signature['sig'] !== 'string'
  ) {
    throw new StatementAdmissionError('The release statement', 'its signature is malformed');
  }
  return {
    payloadType,
    payload,
    signatures: [{ keyid: signature['keyid'], sig: signature['sig'] }],
  };
}

/**
 * Admitted releases are kept for the life of the process. A statement names
 * one version for one board and is never re-signed in place, and everything
 * admission depends on — the configured version and URL template and the
 * bundle's edge-release anchors — is fixed when the process starts
 * (SuderraEdgeConfig, TrustAnchorBundleService). The cache key nevertheless
 * names all of them, so an entry can never answer for another configuration.
 */
@Injectable()
export class EdgeReleaseCatalog {
  private readonly logger = new Logger(EdgeReleaseCatalog.name);
  private readonly admitted = new Map<string, AdmittedRelease>();

  constructor(
    private readonly config: SuderraEdgeConfig,
    private readonly bundle: TrustAnchorBundleService,
    @Inject(RELEASE_STATEMENT_FETCHER)
    private readonly fetcher: ReleaseStatementFetcher,
    @Inject(RELEASE_PROVENANCE_VERIFIER)
    private readonly verifyProvenance: ReleaseProvenanceVerifier,
  ) {}

  private url(version: string, asset: string): string {
    return this.config.settings.release.urlTemplate
      .replace('{version}', version)
      .replace('{asset}', asset);
  }

  /** The configured release for `board`, fetched once and admitted. */
  forBoard(board: BoardRow): Promise<AdmittedRelease> {
    return this.forVersion(board, this.config.settings.release.agentVersion);
  }

  /**
   * The release `version` for `board`, fetched once and admitted: the statement's
   * signature, board and name, then the provenance it names. `version` is a path
   * component of the release URLs, so it is the contract's path-safe semver and
   * nothing else.
   */
  async forVersion(board: BoardRow, version: string): Promise<AdmittedRelease> {
    if (!isContractSemver(version)) {
      throw new StatementAdmissionError(
        `The release version ${version.slice(0, 40)}`,
        'it is not a path-safe semantic version',
      );
    }
    const { urlTemplate, repository } = this.config.settings.release;
    const anchors = this.bundle
      .edgeReleaseKeys()
      .map((key) => `${key.keyid}@${key.epoch}`)
      .sort()
      .join(',');
    const cacheKey = [urlTemplate, repository, version, board.boardProfile, anchors].join('|');
    const cached = this.admitted.get(cacheKey);
    if (cached !== undefined) return cached;

    const artifact = releaseArtifactName(version, board);
    const statementUrl = this.url(version, releaseStatementName(artifact));
    const signed = this.admitStatement(
      asEnvelope(await this.fetcher(statementUrl)),
      board,
      version,
      artifact,
      statementUrl,
    );
    const provenance = this.verifyProvenance(
      Buffer.from(await this.fetcher(this.url(version, releaseProvenanceName(artifact))), 'utf8'),
      {
        repository,
        version,
        artifact: { name: artifact, sha256: signed.facts.artifact.sha256 },
        boardProfile: board.boardProfile,
        rustTarget: board.rustTarget,
        features: signed.features,
        predicateType: signed.provenance.predicateType,
        digestSha256: signed.provenance.digestSha256,
      },
    );
    const admitted = new AdmittedRelease({ ...signed.facts, provenance });
    this.admitted.set(cacheKey, admitted);
    this.logger.log({
      event: 'suderra_edge_release_admitted',
      version,
      board: board.boardProfile,
      digest: admitted.digest.sha256,
      provenanceCommit: provenance.commit,
    });
    return admitted;
  }

  private admitStatement(
    envelope: DsseEnvelope,
    board: BoardRow,
    version: string,
    artifact: string,
    statementUrl: string,
  ): {
    readonly facts: Omit<AdmittedReleaseFacts, 'provenance'>;
    readonly features: readonly string[];
    readonly provenance: { readonly predicateType: string; readonly digestSha256: string };
  } {
    const what = `The ${version} release statement for ${board.boardProfile}`;
    const payloadBytes = admitEnvelope(
      what,
      envelope,
      payloadTypeOf(STATEMENT.edgeRelease),
      'edge-release',
      this.bundle.edgeReleaseKeys(),
    );
    const body = parseReleaseBody(what, payloadBytes);
    const artifactDigest = body.artifact['digest'];
    const artifactSha256 = isRecord(artifactDigest) ? artifactDigest['sha256'] : undefined;
    const artifactSize = body.artifact['size_bytes'];
    if (
      body.type !== STATEMENT.edgeRelease ||
      body.name !== 'suderra-agent' ||
      body.version !== version ||
      body.boardProfile !== board.boardProfile ||
      body.arch !== board.arch ||
      body.agentProfile !== board.agentProfile ||
      body.cargoFeatures.join(',') !== board.cargoFeatures.join(',') ||
      body.artifact['name'] !== artifact ||
      body.artifact['format'] !== RELEASE_ARTIFACT_FORMAT ||
      body.artifact['binary_name'] !== RELEASE_BINARY_NAME ||
      typeof artifactSha256 !== 'string' ||
      typeof artifactSize !== 'number'
    ) {
      // release-mismatch / release-profile-mismatch on the device; refusing
      // here keeps the cloud from naming a release no device can install.
      throw new StatementAdmissionError(what, 'it does not describe this board, version and name');
    }
    return {
      facts: {
        envelope,
        payloadBytes,
        digest: statementDigest(payloadBytes),
        version,
        securityVersion: body.securityVersion,
        boardProfile: board.boardProfile,
        arch: board.arch,
        minOsVersion: body.minOsVersion,
        agentAbi: body.agentAbi,
        artifactUrl: this.url(version, artifact),
        artifact: { sizeBytes: artifactSize, sha256: artifactSha256 },
        statementUrl,
      },
      features: body.cargoFeatures,
      provenance: body.provenance,
    };
  }
}

/** Integer-tuple comparison of MAJOR.MINOR.PATCH (statements.json compatibility). */
export function osVersionAtLeast(have: string, need: string): boolean {
  const a = have.split('.').map(Number);
  const b = need.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** True when `abi` lies in the OS's inclusive SUDERRA_AGENT_ABI range `MIN-MAX`. */
export function abiSupported(range: string, abi: number): boolean {
  const [min, max] = range.split('-').map(Number);
  return min !== undefined && max !== undefined && min <= abi && abi <= max;
}
