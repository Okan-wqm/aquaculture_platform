import { prepareSprintCompletion } from '../src/application/progress-admission';
import { createTrustedCompletionContext } from '../src/application/trusted-completion-context';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { renderCompletionProjection } from '../src/runtime/projection-renderer';

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

describe('sprint completion admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('projects DONE only from exact current evidence and authority', async () => {
    const input = admissionInput();
    const result = await admitScenario(input);
    expect(result).toMatchObject({
      program_id: 'new-aria-autonomous-engineering',
      sprint_id: 'S01',
      state: 'DONE',
      status: 'OK',
      freshness: 'VALID_AT',
      verdict: 'ACCEPTED',
      head_sha: input.fixture.manifest.target.head_sha,
      verified_at: '2026-09-02T12:05:00.000Z',
      valid_from: '2026-09-02T12:05:00.000Z',
      valid_until: '2026-09-02T13:00:00.000Z',
    });
    expect(result.event_chain_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.attestation_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'state', 'READY')).toBe(false);
    const firstProjection = renderCompletionProjection(result);
    expect(renderCompletionProjection(result)).toEqual(firstProjection);
    expect(firstProjection.at(-1)).toBe(0x0a);
    expect(() => renderCompletionProjection({ ...result })).toThrow(/issued by admission/);

    jest.setSystemTime(new Date('2026-09-02T12:04:59.999Z'));
    expect(() => renderCompletionProjection(result)).toThrow(/no longer current/);
    jest.setSystemTime(new Date('2026-09-02T13:00:00.001Z'));
    expect(() => renderCompletionProjection(result)).toThrow(/no longer current/);
  });

  it('rejects a DONE event whose evidence digest is not the admitted manifest', async () => {
    const input = admissionInput();
    input.candidate.event_bytes = eventBytes(
      completionEvents(input.authority_sha256, 'd'.repeat(64)),
    );
    await expect(admitScenario(input)).rejects.toThrow(/evidence/);
  });

  it('rejects stale evidence even when transport and semantic results passed', async () => {
    const input = admissionInput();
    jest.setSystemTime(new Date('2026-09-02T13:00:00.001Z'));
    await expect(admitScenario(input)).rejects.toThrow(/stale/);
  });

  it('rejects a future attestation before checkpointing even within policy clock skew', async () => {
    const input = admissionInput();
    jest.setSystemTime(new Date('2026-09-02T12:04:30.000Z'));
    await expect(admitScenario(input)).rejects.toThrow(/future/);
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    await expect(admitScenario(input)).resolves.toMatchObject({ state: 'DONE' });
  });

  it('rejects a policy change under the previously authorized digest', () => {
    const input = admissionInput().context_input;
    const policy = JSON.parse(Buffer.from(input.freshness_policy_bytes).toString()) as {
      proof_max_age_seconds: { SOURCE_CODE_ORACLE: number };
    };
    policy.proof_max_age_seconds.SOURCE_CODE_ORACLE += 1;
    expect(() =>
      createTrustedCompletionContext({
        ...input,
        freshness_policy_bytes: canonicalJsonBytes(policy),
      }),
    ).toThrow(/policy digest/);
  });

  it('rejects a caller-fabricated copy of a trusted completion context', async () => {
    const input = admissionInput();
    expect(() => prepareSprintCompletion(input.candidate, { ...input.context })).toThrow(
      /context capability/,
    );
  });

  it('rejects a claim that differs from the signed progress authority', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    fixture.manifest.claim.acceptance_ids = ['ACC-S01'];
    const changedBytes = evidenceBytes(fixture.manifest);
    const events = completionEvents(fixture.authoritySha256, sha256(changedBytes));
    const tail = requiredValue(events.at(-1), 'changed completion tail event');
    input.candidate.manifest_bytes = [changedBytes];
    input.candidate.event_bytes = eventBytes(events);
    input.candidate.evidence_attestation_bytes = attestationBytes(
      changedBytes,
      fixture.authoritySha256,
      input.candidate.event_bytes,
      tail.event_hash,
    );
    await expect(admitScenario(input)).rejects.toThrow(/claim/);
  });

  it('returns byte-identical projections for an exact checkpoint replay', async () => {
    const input = admissionInput();
    const first = await admitScenario(input);
    const second = await admitScenario(input);
    expect(renderCompletionProjection(second)).toEqual(renderCompletionProjection(first));
  });

  it('rejects a non-DONE tail instead of claiming completion', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    input.candidate.event_bytes = eventBytes(
      completionEvents(fixture.authoritySha256, fixture.manifestSha256).slice(0, -1),
    );
    await expect(admitScenario(input)).rejects.toThrow(/DONE/);
  });

  it('rejects non-canonical evidence manifest bytes', async () => {
    const input = admissionInput();
    const fixture = input.fixture;
    input.candidate.manifest_bytes = [Buffer.from(` ${JSON.stringify(fixture.manifest)}\n`)];
    await expect(admitScenario(input)).rejects.toThrow(/canonical/);
  });
});
