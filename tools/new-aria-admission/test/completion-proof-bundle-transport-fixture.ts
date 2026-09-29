import { createHash } from 'node:crypto';

import type { CompletionProofBundleSource } from '../src/runtime/completion-proof-bundle';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function completionProofTransportSource(): CompletionProofBundleSource {
  const object = Buffer.from('content-addressed execution evidence');
  return {
    target_request_bytes: Buffer.from('{"target":true}'),
    operator_envelope_bytes: Buffer.from('{"authority":true}'),
    operator_trust_root_bytes: Buffer.from('{"operator_root":true}'),
    evidence_trust_root_bytes: Buffer.from('{"evidence_root":true}'),
    execution_trust_root_bytes: Buffer.from('{"execution_root":true}'),
    event_policy_bytes: Buffer.from('{"event_policy":true}'),
    freshness_policy_bytes: Buffer.from('{"freshness_policy":true}'),
    event_chain_bytes: Buffer.from('{"event":1}\n'),
    manifest_bytes: Object.freeze([
      Buffer.from('{"manifest":0}'),
      Buffer.from('{"manifest":1}'),
      Buffer.from('{"manifest":2}'),
      Buffer.from('{"manifest":3}'),
    ]),
    objects: new Map([[`aria-evidence://sha256/${digest(object)}`, object]]),
    evidence_attestation_bytes: Buffer.from('{"attestation":true}'),
    projection_artifact_bytes: Buffer.from('{"projection":true}\n'),
  };
}
