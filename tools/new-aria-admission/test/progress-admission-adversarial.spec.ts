import { createTrustedCompletionContext } from '../src/application/trusted-completion-context';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { computeEventHash } from '../src/kernel/event-chain';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';
import { attestationBytes } from './attestation-fixture';
import {
  completionEvents,
  eventBytes,
  evidenceBytes,
  requiredValue,
  sha256,
} from './progress-fixture';
import { conflictReviewProof } from './review-proof-fixture';

describe('sprint completion adversarial boundaries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('rejects an unreferenced content-addressed object hidden in the candidate', async () => {
    const input = admissionInput();
    const hidden = Buffer.from('hidden-secret-material');
    const digest = sha256(hidden);
    const objects = new Map(input.candidate.objects);
    objects.set(`aria-evidence://sha256/${digest}`, hidden);
    input.candidate.objects = objects;

    await expect(admitScenario(input)).rejects.toThrow(/unreferenced|closure|extra/i);
  });

  it('rejects string-only reviewer identities without valid signatures', async () => {
    const input = admissionInput();
    const envelope = JSON.parse(input.candidate.evidence_attestation_bytes.toString()) as {
      signatures: { signature_base64: string }[];
    };
    const firstSignature = requiredValue(envelope.signatures[0], 'first evidence signature');
    firstSignature.signature_base64 = Buffer.alloc(64).toString('base64');
    input.candidate.evidence_attestation_bytes = canonicalJsonBytes(envelope);
    await expect(admitScenario(input)).rejects.toThrow(/signature/);
  });

  it('rejects a re-chained alternate history absent from the attestation', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const alternateEvent = requiredValue(fixture.events[1], 'alternate history event');
    alternateEvent.actor_id = 'alternate-controller';
    let previous = '0'.repeat(64);
    fixture.events.forEach((event) => {
      event.previous_hash = previous;
      event.event_hash = computeEventHash(event);
      previous = event.event_hash;
    });
    input.candidate.event_bytes = eventBytes(fixture.events);
    await expect(admitScenario(input)).rejects.toThrow(/attestation payload/);
  });

  it('rejects historical events whose evidence objects are unavailable', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const unavailableDigest = '9'.repeat(64);
    for (const event of fixture.events.slice(0, -1)) {
      event.evidence_sha256 = unavailableDigest;
      event.evidence_uri = `aria-evidence://sha256/${unavailableDigest}`;
    }
    let previousHash = '0'.repeat(64);
    for (const event of fixture.events) {
      event.previous_hash = previousHash;
      event.event_hash = computeEventHash(event);
      previousHash = event.event_hash;
    }
    const changedEventBytes = eventBytes(fixture.events);
    const tail = requiredValue(fixture.events.at(-1), 'historical-evidence tail event');
    input.candidate.event_bytes = changedEventBytes;
    input.candidate.evidence_attestation_bytes = attestationBytes(
      fixture.manifestBytes,
      fixture.authoritySha256,
      changedEventBytes,
      tail.event_hash,
    );

    await expect(admitScenario(input)).rejects.toThrow(/historical event evidence/);
  });

  it('rejects a DONE event after its signed review observation', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const tail = requiredValue(fixture.events.at(-1), 'late DONE event');
    tail.occurred_at = '2026-09-02T12:06:00.000Z';
    tail.event_hash = computeEventHash(tail);
    const changedEventBytes = eventBytes(fixture.events);
    input.candidate.event_bytes = changedEventBytes;
    input.candidate.evidence_attestation_bytes = attestationBytes(
      fixture.manifestBytes,
      fixture.authoritySha256,
      changedEventBytes,
      tail.event_hash,
    );
    await expect(admitScenario(input)).rejects.toThrow(/time order/);
  });

  it('rejects an unpinned reviewer trust root', () => {
    const input = admissionInput().context_input;
    const tamperedTrustRoot = Buffer.from(
      Buffer.from(input.evidence_trust_root_bytes).toString().replace('reviewer-1', 'reviewer-2'),
    );
    expect(() =>
      createTrustedCompletionContext({
        ...input,
        evidence_trust_root_bytes: tamperedTrustRoot,
      }),
    ).toThrow(/trust root digest/);
  });

  it('rejects event authority drift after evidence binding is valid', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    input.candidate.event_bytes = eventBytes(
      completionEvents('d'.repeat(64), fixture.manifestSha256),
    );
    await expect(admitScenario(input)).rejects.toThrow(/authority/);
  });

  it('rejects an event and evidence pair on an unauthorized target head', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const attackerHead = '9'.repeat(40);
    fixture.manifest.target.head_sha = attackerHead;
    const sourceHeadEpoch = requiredValue(
      fixture.manifest.freshness.invalidation_epochs.find(({ key }) => key === 'source_head'),
      'source-head invalidation epoch',
    );
    sourceHeadEpoch.epoch = `git:${attackerHead}`;
    const conflict = conflictReviewProof({
      authority_sha256: fixture.authoritySha256,
      target_head_sha: attackerHead,
      oracle_report_sha256: fixture.manifest.oracle.report.sha256,
      negative_controls: fixture.manifest.oracle.negative_controls,
      reviewed_at: fixture.manifest.observed_at,
    });
    fixture.manifest.review.conflict_evidence = conflict.reference;
    const objects = new Map(input.candidate.objects);
    objects.set(conflict.reference.uri, conflict.bytes);
    input.candidate.objects = objects;
    const changedBytes = evidenceBytes(fixture.manifest);
    const events = completionEvents(fixture.authoritySha256, sha256(changedBytes), attackerHead);
    const tail = requiredValue(events.at(-1), 'unauthorized-target DONE event');
    const changedEventBytes = eventBytes(events);
    input.candidate.manifest_bytes = [changedBytes];
    input.candidate.event_bytes = changedEventBytes;
    input.candidate.evidence_attestation_bytes = attestationBytes(
      changedBytes,
      fixture.authoritySha256,
      changedEventBytes,
      tail.event_hash,
      attackerHead,
    );
    await expect(admitScenario(input)).rejects.toThrow(/oracle baseline input|progress authority/);
  });

  it('rejects a present but authority-unbound dependency epoch', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const attackerEpoch = `sha256:${'9'.repeat(64)}`;
    const dependencyEpoch = requiredValue(
      fixture.manifest.freshness.invalidation_epochs.find(({ key }) => key === 'dependency'),
      'dependency invalidation epoch',
    );
    dependencyEpoch.epoch = attackerEpoch;
    const changedBytes = evidenceBytes(fixture.manifest);
    const events = completionEvents(fixture.authoritySha256, sha256(changedBytes));
    const tail = requiredValue(events.at(-1), 'dependency-tamper DONE event');
    const changedEventBytes = eventBytes(events);
    input.candidate.manifest_bytes = [changedBytes];
    input.candidate.event_bytes = changedEventBytes;
    input.candidate.evidence_attestation_bytes = attestationBytes(
      changedBytes,
      fixture.authoritySha256,
      changedEventBytes,
      tail.event_hash,
      'b'.repeat(40),
      { dependency: attackerEpoch },
    );
    await expect(admitScenario(input)).rejects.toThrow(/epochs/);
  });

  it('rejects an oracle implementation outside the progress authority', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    fixture.manifest.oracle.implementation_sha256 = '9'.repeat(64);
    const changedBytes = evidenceBytes(fixture.manifest);
    const events = completionEvents(fixture.authoritySha256, sha256(changedBytes));
    const tail = requiredValue(events.at(-1), 'oracle-tamper DONE event');
    input.candidate.manifest_bytes = [changedBytes];
    input.candidate.event_bytes = eventBytes(events);
    input.candidate.evidence_attestation_bytes = attestationBytes(
      changedBytes,
      fixture.authoritySha256,
      input.candidate.event_bytes,
      tail.event_hash,
    );
    await expect(admitScenario(input)).rejects.toThrow(/oracle/);
  });

  it('takes one owned manifest snapshot across parse, digest, and signature checks', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    const unchecked = JSON.parse(JSON.stringify(fixture.manifest)) as typeof fixture.manifest;
    const verdictReplaced = Reflect.set(unchecked.execution, 'semantic_verdict', 'FAILED');
    expect(verdictReplaced).toBe(true);
    const uncheckedBytes = evidenceBytes(unchecked);
    const events = completionEvents(fixture.authoritySha256, sha256(uncheckedBytes));
    const tail = requiredValue(events.at(-1), 'snapshot-tamper DONE event');
    const changedEventBytes = eventBytes(events);
    input.candidate.event_bytes = changedEventBytes;
    input.candidate.evidence_attestation_bytes = attestationBytes(
      uncheckedBytes,
      fixture.authoritySha256,
      changedEventBytes,
      tail.event_hash,
    );
    const replaced = Reflect.set(input.candidate, 'manifest_bytes', {
      [Symbol.iterator]: () => [fixture.manifestBytes][Symbol.iterator](),
      at: () => uncheckedBytes,
    });
    expect(replaced).toBe(true);
    await expect(admitScenario(input)).rejects.toThrow(/evidence/);
  });
});
