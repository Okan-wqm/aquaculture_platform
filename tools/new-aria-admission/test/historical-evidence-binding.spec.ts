import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import type { EventRecord } from '../src/kernel/event-chain';
import { verifyEventEvidenceHistory } from '../src/kernel/event-evidence-history';
import { manifestSha256 } from '../src/kernel/evidence-chain';
import { isJsonRecord } from '../src/kernel/evidence-object';
import type { JsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';

import { completionFixture } from './progress-fixture';

function manifestRecord(bytes: Uint8Array): JsonRecord {
  const value = parseStrictJson(bytes.slice(0, -1));
  if (!isJsonRecord(value)) throw new TypeError('fixture manifest is not an object');
  return value;
}

function manifestBytes(value: JsonRecord): Buffer {
  return Buffer.from(`${canonicalJsonBytes(value).toString()}\n`);
}

function replaceEvidence(
  events: readonly EventRecord[],
  index: number,
  bytes: Uint8Array,
): readonly EventRecord[] {
  const digest = manifestSha256(bytes);
  return events.map((event, eventIndex) =>
    eventIndex === index
      ? {
          ...event,
          evidence_sha256: digest,
          evidence_uri: `aria-evidence://sha256/${digest}`,
        }
      : event,
  );
}

describe('event-specific historical evidence', () => {
  it('accepts one ordered, state-bound manifest per transition', () => {
    const fixture = completionFixture();

    const verified = verifyEventEvidenceHistory(
      fixture.events,
      fixture.manifestBytesChain,
      fixture.objects,
    );

    expect(verified.final_manifest.version).toBe(4);
    expect(verified.manifests.map(({ claim }) => claim.state)).toEqual([
      'READY',
      'IN_PROGRESS',
      'VERIFYING',
      'DONE',
    ]);
    expect(Object.isFrozen(verified.manifests)).toBe(true);
  });

  it('rejects reusing one final DONE manifest for earlier state transitions', () => {
    const fixture = completionFixture();

    expect(() =>
      verifyEventEvidenceHistory(fixture.events, [fixture.manifestBytes], fixture.objects),
    ).toThrow(/one-to-one|count|reuse|unique/i);
  });

  it.each([
    {
      name: 'state',
      index: 0,
      mutate: (manifest: JsonRecord): void => {
        if (!isJsonRecord(manifest.claim)) throw new TypeError('claim fixture is invalid');
        manifest.claim.state = 'DONE';
      },
    },
    {
      name: 'predecessor',
      index: 1,
      mutate: (manifest: JsonRecord): void => {
        manifest.previous_manifest_sha256 = 'f'.repeat(64);
      },
    },
    {
      name: 'event time',
      index: 0,
      mutate: (manifest: JsonRecord): void => {
        manifest.observed_at = '2026-09-02T12:02:00.000Z';
      },
    },
    {
      name: 'immutable target scope',
      index: 1,
      mutate: (manifest: JsonRecord): void => {
        if (!isJsonRecord(manifest.target)) throw new TypeError('target fixture is invalid');
        manifest.target.workspace_id = 'workspace-fork';
      },
    },
  ])('rejects a manifest with mismatched $name binding', ({ index, mutate }) => {
    const fixture = completionFixture();
    const originalBytes = fixture.manifestBytesChain[index];
    if (originalBytes === undefined) throw new TypeError('fixture manifest is missing');
    const changedManifest = manifestRecord(originalBytes);
    mutate(changedManifest);
    const changedBytes = manifestBytes(changedManifest);
    const manifests = [...fixture.manifestBytesChain];
    manifests[index] = changedBytes;

    expect(() =>
      verifyEventEvidenceHistory(
        replaceEvidence(fixture.events, index, changedBytes),
        manifests,
        fixture.objects,
      ),
    ).toThrow(/claim|order|state|predecessor|time|scope|mismatch/i);
  });

  it('returns a deeply immutable verified history snapshot', () => {
    const fixture = completionFixture();
    const verified = verifyEventEvidenceHistory(
      fixture.events,
      fixture.manifestBytesChain,
      fixture.objects,
    );
    const first = verified.manifests[0];

    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.claim)).toBe(true);
    expect(Object.isFrozen(first?.claim.acceptance_ids)).toBe(true);
    expect(Object.isFrozen(first?.target)).toBe(true);
    expect(Reflect.set(first?.claim.acceptance_ids ?? [], 0, 'ACC-FORGED')).toBe(false);
    expect(Reflect.set(verified.final_manifest.execution, 'exit_code', 99)).toBe(false);
  });
});
