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

export const fetchReleaseStatement: ReleaseStatementFetcher = async (url) => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new StatementAdmissionError(
      'The release statement',
      `${url} answered ${response.status}`,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_STATEMENT_BYTES) {
    throw new StatementAdmissionError('The release statement', 'it exceeds 64 KiB');
  }
  return text;
};

function asEnvelope(text: string): DsseEnvelope {
  const parsed = JSON.parse(text) as Partial<{
    payloadType: unknown;
    payload: unknown;
    signatures: unknown;
  }>;
  const signatures = parsed.signatures;
  if (
    typeof parsed.payloadType !== 'string' ||
    typeof parsed.payload !== 'string' ||
    !Array.isArray(signatures) ||
    signatures.length !== 1
  ) {
    throw new StatementAdmissionError('The release statement', 'it is not a DSSE envelope');
  }
  const [signature] = signatures as Array<{ keyid?: unknown; sig?: unknown }>;
  if (typeof signature?.keyid !== 'string' || typeof signature.sig !== 'string') {
    throw new StatementAdmissionError('The release statement', 'its signature is malformed');
  }
  return {
    payloadType: parsed.payloadType,
    payload: parsed.payload,
    signatures: [{ keyid: signature.keyid, sig: signature.sig }],
  };
}

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
    const version = this.config.settings.release.agentVersion;
    const cacheKey = `${version}/${board.boardProfile}`;
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
    const body = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
    const artifactBody = (body['artifact'] ?? {}) as Record<string, unknown>;
    const features = Array.isArray(body['cargo_features'])
      ? (body['cargo_features'] as unknown[]).map(String).sort()
      : [];
    const mismatch =
      body['_type'] !== STATEMENT.edgeRelease ||
      body['name'] !== 'suderra-agent' ||
      body['version'] !== version ||
      body['board_profile'] !== board.boardProfile ||
      body['arch'] !== board.arch ||
      body['agent_profile'] !== board.agentProfile ||
      features.join(',') !== board.cargoFeatures.join(',') ||
      artifactBody['name'] !== artifact ||
      artifactBody['format'] !== RELEASE_ARTIFACT_FORMAT ||
      artifactBody['binary_name'] !== RELEASE_BINARY_NAME;
    const securityVersion = body['security_version'];
    const minOsVersion = body['min_os_version'];
    const agentAbi = body['agent_abi'];
    if (
      mismatch ||
      typeof securityVersion !== 'number' ||
      typeof minOsVersion !== 'string' ||
      typeof agentAbi !== 'number'
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
      securityVersion,
      boardProfile: board.boardProfile,
      arch: board.arch,
      minOsVersion,
      agentAbi,
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
