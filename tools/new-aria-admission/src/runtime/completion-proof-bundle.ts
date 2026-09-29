import { createHash } from 'node:crypto';

import { snapshotCompletionCandidate } from '../application/completion-candidate';
import { canonicalJsonBytes } from '../kernel/canonical-json';

import { AtomicDirectoryPublication } from './atomic-directory-publication';
import type {
  CompletionBundleArtifactDescriptor,
  CompletionBundleObjectDescriptor,
} from './completion-proof-bundle-contract';

export interface CompletionProofBundleSource {
  readonly target_request_bytes: Uint8Array;
  readonly operator_envelope_bytes: Uint8Array;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly evidence_trust_root_bytes: Uint8Array;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly event_policy_bytes: Uint8Array;
  readonly freshness_policy_bytes: Uint8Array;
  readonly event_chain_bytes: Uint8Array;
  readonly manifest_bytes: readonly Uint8Array[];
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly evidence_attestation_bytes: Uint8Array;
  readonly projection_artifact_bytes: Uint8Array;
}

export interface CompletionProofBundleMaterial {
  readonly artifacts: ReadonlyMap<string, Buffer>;
  readonly marker_bytes: Buffer;
  readonly marker_sha256: string;
}

const MAX_PUBLIC_RESOURCE_BYTES = 1024 * 1024;
const MAX_PROJECTION_BYTES = 1024 * 1024;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function ownedBounded(value: Uint8Array, maximum: number, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) {
    throw new TypeError(`${label} is not bounded bytes`);
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} cannot use shared mutable memory`);
  }
  return Buffer.from(value);
}

function descriptor(path: string, bytes: Uint8Array): CompletionBundleArtifactDescriptor {
  return Object.freeze({
    path: `payload/${path}`,
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function objectDescriptor(
  path: string,
  uri: string,
  bytes: Uint8Array,
): CompletionBundleObjectDescriptor {
  const result = descriptor(path, bytes);
  if (uri !== `aria-evidence://sha256/${result.sha256}`) {
    throw new TypeError('completion bundle object content address mismatch');
  }
  return Object.freeze({ ...result, uri });
}

function jsonLine(value: unknown): Buffer {
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
}

function fixedArtifact(
  artifacts: Map<string, Buffer>,
  name: string,
  value: Uint8Array,
  label: string,
): CompletionBundleArtifactDescriptor {
  const bytes = ownedBounded(value, MAX_PUBLIC_RESOURCE_BYTES, label);
  artifacts.set(name, bytes);
  return descriptor(name, bytes);
}

export function materializeCompletionProofBundle(
  input: CompletionProofBundleSource,
): CompletionProofBundleMaterial {
  const candidate = snapshotCompletionCandidate({
    event_bytes: input.event_chain_bytes,
    manifest_bytes: input.manifest_bytes,
    objects: input.objects,
    evidence_attestation_bytes: input.evidence_attestation_bytes,
  });
  if (candidate.manifest_bytes.length !== 4) {
    throw new TypeError('completion bundle requires the exact four-manifest history');
  }
  const artifacts = new Map<string, Buffer>();
  const fixed = {
    target_request: fixedArtifact(
      artifacts,
      'target-request.json',
      input.target_request_bytes,
      'repository target request',
    ),
    operator_envelope: fixedArtifact(
      artifacts,
      'operator-envelope.json',
      input.operator_envelope_bytes,
      'operator authority envelope',
    ),
    operator_trust_root: fixedArtifact(
      artifacts,
      'operator-trust-root.json',
      input.operator_trust_root_bytes,
      'operator trust root',
    ),
    evidence_trust_root: fixedArtifact(
      artifacts,
      'evidence-trust-root.json',
      input.evidence_trust_root_bytes,
      'evidence trust root',
    ),
    execution_trust_root: fixedArtifact(
      artifacts,
      'execution-trust-root.json',
      input.execution_trust_root_bytes,
      'execution trust root',
    ),
    event_policy: fixedArtifact(
      artifacts,
      'event-policy.json',
      input.event_policy_bytes,
      'event policy',
    ),
    freshness_policy: fixedArtifact(
      artifacts,
      'freshness-policy.json',
      input.freshness_policy_bytes,
      'freshness policy',
    ),
  };
  const eventChain = Buffer.from(candidate.event_bytes);
  artifacts.set('event-chain.jsonl', eventChain);
  const manifests = candidate.manifest_bytes.map((value, index) => {
    const name = `manifest-${index.toString().padStart(2, '0')}.json`;
    const bytes = Buffer.from(value);
    artifacts.set(name, bytes);
    return descriptor(name, bytes);
  });
  const objects = [...candidate.objects.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([uri, value]) => {
      const name = `object-${uri.slice('aria-evidence://sha256/'.length)}.bin`;
      const bytes = Buffer.from(value);
      const result = objectDescriptor(name, uri, bytes);
      artifacts.set(name, bytes);
      return result;
    });
  const attestation = Buffer.from(candidate.evidence_attestation_bytes);
  const projection = ownedBounded(
    input.projection_artifact_bytes,
    MAX_PROJECTION_BYTES,
    'completion projection artifact',
  );
  artifacts.set('evidence-attestation.json', attestation);
  artifacts.set('completion-projection.json', projection);
  const markerBytes = jsonLine({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-proof-bundle-v1',
    bundle_verdict: 'VALID_AT',
    files: {
      ...fixed,
      event_chain: descriptor('event-chain.jsonl', eventChain),
      manifests,
      objects,
      evidence_attestation: descriptor('evidence-attestation.json', attestation),
      projection_artifact: descriptor('completion-projection.json', projection),
    },
  });
  return Object.freeze({
    artifacts,
    marker_bytes: markerBytes,
    marker_sha256: sha256(markerBytes),
  });
}

export class CompletionProofBundlePublication {
  private readonly publication: AtomicDirectoryPublication;
  private released = false;
  private stagedMarkerSha256: string | undefined;

  constructor(bundlePath: string) {
    this.publication = new AtomicDirectoryPublication(bundlePath);
  }

  stage(input: CompletionProofBundleSource): void {
    if (this.released) throw new TypeError('completion bundle publication is closed');
    try {
      const material = materializeCompletionProofBundle(input);
      for (const [name, bytes] of material.artifacts) this.publication.write(name, bytes);
      this.publication.commitPayload();
      this.publication.stageCandidate(material.marker_bytes);
      this.stagedMarkerSha256 = material.marker_sha256;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  detachCandidate(): void {
    if (this.released || this.stagedMarkerSha256 === undefined) {
      throw new TypeError('completion bundle publication has no staged candidate');
    }
    this.publication.releaseCandidate();
    this.released = true;
  }

  abort(): void {
    if (this.released) return;
    this.released = true;
    this.publication.abort();
  }
}

Object.freeze(CompletionProofBundlePublication.prototype);
Object.freeze(CompletionProofBundlePublication);
