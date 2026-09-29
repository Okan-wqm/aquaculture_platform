import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { computeEventHash } from '../src/kernel/event-chain';
import type { EventRecord } from '../src/kernel/event-chain';
import { verifyEventChain } from '../src/kernel/event-chain';
import { loadEventPolicy } from '../src/kernel/policy';
import type { VerifiedDossierResult } from '../src/verifier/verification-dossier';

import { eventPolicyBytes } from './progress-authority-fixture';

export type CompletionEvent = EventRecord & {
  actor_id: string;
  event_hash: string;
  occurred_at: string;
  previous_hash: string;
};

export function completionEvents(
  authoritySha256: string,
  evidenceSha256s: string | readonly string[],
  targetSha = 'b'.repeat(40),
  verifiedDossier?: VerifiedDossierResult,
): CompletionEvent[] {
  const transitions: readonly (readonly [string, string])[] = [
    ['PLANNED', 'READY'],
    ['READY', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'VERIFYING'],
    ['VERIFYING', 'DONE'],
  ];
  const prefix = verifiedDossier === undefined
    ? []
    : verifyEventChain(verifiedDossier.event_chain_bytes, loadEventPolicy(eventPolicyBytes));
  if (
    prefix.length !== (verifiedDossier === undefined ? 0 : 3) ||
    prefix.some((event, index) =>
      event.evidence_sha256 !== verifiedDossier?.manifest_chain_sha256s[index])
  ) throw new TypeError('verified dossier event prefix is incomplete');
  const prefixTailHash = prefix.at(-1)?.event_hash;
  if (prefixTailHash !== undefined && typeof prefixTailHash !== 'string') {
    throw new TypeError('verified dossier event tail hash is invalid');
  }
  let previousHash = prefixTailHash ?? '0'.repeat(64);
  const suffix = transitions.slice(prefix.length).map(([fromState, toState], index) => {
    const offset = index + prefix.length;
    const evidenceSha256 =
      typeof evidenceSha256s === 'string' ? evidenceSha256s : evidenceSha256s[offset];
    if (evidenceSha256 === undefined) throw new Error('completion event evidence is missing');
    const sequence = offset + 1;
    const value = {
      schema_version: '1.0.0',
      contract_id: 'aria-event-cjson-v1',
      program_id: 'new-aria-autonomous-engineering',
      event_id: `s01-${sequence.toString().padStart(4, '0')}`,
      sequence,
      sprint_id: 'S01',
      from_state: fromState,
      to_state: toState,
      occurred_at: `2026-09-02T12:0${sequence}:00.000Z`,
      actor_id: 's01-controller',
      target_sha: targetSha,
      authority_sha256: authoritySha256,
      evidence_uri: `aria-evidence://sha256/${evidenceSha256}`,
      evidence_sha256: evidenceSha256,
      previous_hash: previousHash,
      event_hash: '',
    };
    value.event_hash = computeEventHash(value);
    previousHash = value.event_hash;
    return value;
  });
  return [...prefix.map((event) => ({ ...event }) as CompletionEvent), ...suffix];
}

export const eventBytes = (events: ReturnType<typeof completionEvents>): Buffer =>
  Buffer.from(`${events.map((event) => canonicalJsonBytes(event)).join('\n')}\n`);
