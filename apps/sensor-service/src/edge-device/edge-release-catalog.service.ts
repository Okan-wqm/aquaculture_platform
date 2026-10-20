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
  releaseStatementName,
} from './edge-boards';
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
 */

export interface AdmittedRelease {
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
}

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
  if (
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
  ) {}

  private url(version: string, asset: string): string {
    return this.config.settings.release.urlTemplate
      .replace('{version}', version)
      .replace('{asset}', asset);
  }

  /** The configured release for `board`, fetched once and admitted. */
  async forBoard(board: BoardRow): Promise<AdmittedRelease> {
    const { agentVersion: version, urlTemplate } = this.config.settings.release;
    const anchors = this.bundle
      .edgeReleaseKeys()
      .map((key) => `${key.keyid}@${key.epoch}`)
      .sort()
      .join(',');
    const cacheKey = [urlTemplate, version, board.boardProfile, anchors].join('|');
    const cached = this.admitted.get(cacheKey);
    if (cached !== undefined) return cached;

    const artifact = releaseArtifactName(version, board);
    const statementUrl = this.url(version, releaseStatementName(artifact));
    const release = this.admit(
      asEnvelope(await this.fetcher(statementUrl)),
      board,
      version,
      artifact,
    );
    this.admitted.set(cacheKey, release);
    this.logger.log({
      event: 'suderra_edge_release_admitted',
      version,
      board: board.boardProfile,
      digest: release.digest.sha256,
    });
    return release;
  }

  private admit(
    envelope: DsseEnvelope,
    board: BoardRow,
    version: string,
    artifact: string,
  ): AdmittedRelease {
    const what = `The ${version} release statement for ${board.boardProfile}`;
    const payloadBytes = admitEnvelope(
      what,
      envelope,
      payloadTypeOf(STATEMENT.edgeRelease),
      'edge-release',
      this.bundle.edgeReleaseKeys(),
    );
    const body = parseReleaseBody(what, payloadBytes);
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
      body.artifact['binary_name'] !== RELEASE_BINARY_NAME
    ) {
      // release-mismatch / release-profile-mismatch on the device; refusing
      // here keeps the cloud from naming a release no device can install.
      throw new StatementAdmissionError(what, 'it does not describe this board, version and name');
    }
    return {
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
