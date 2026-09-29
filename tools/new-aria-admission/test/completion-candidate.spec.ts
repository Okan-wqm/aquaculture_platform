import { snapshotCompletionCandidate } from '../src/application/completion-candidate';
import type { CompletionCandidate } from '../src/application/completion-candidate';

const uri = (digit: string): string => `aria-evidence://sha256/${digit.repeat(64)}`;

function candidate(overrides: Partial<CompletionCandidate> = {}): CompletionCandidate {
  return {
    event_bytes: Buffer.from('event'),
    manifest_bytes: [Buffer.from('manifest')],
    objects: new Map([[uri('1'), Buffer.from('object')]]),
    evidence_attestation_bytes: Buffer.from('attestation'),
    ...overrides,
  };
}

describe('completion candidate allocation boundary', () => {
  it('rejects manifest and object counts before snapshot allocation', () => {
    const manifests = Array.from({ length: 65 }, () => Buffer.from('manifest'));
    const objects = new Map<string, Uint8Array>();
    for (let index = 0; index < 257; index += 1) {
      objects.set(
        `aria-evidence://sha256/${index.toString(16).padStart(64, '0')}`,
        Buffer.alloc(0),
      );
    }

    expect(() => snapshotCompletionCandidate(candidate({ manifest_bytes: manifests }))).toThrow(
      /manifest.*count|limit/i,
    );
    expect(() => snapshotCompletionCandidate(candidate({ objects }))).toThrow(
      /object.*count|limit/i,
    );
  });

  it('rejects per-object and aggregate byte pressure before copying objects', () => {
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    const reused = new Uint8Array(16 * 1024 * 1024);
    const aggregate = new Map(
      ['1', '2', '3', '4', '5'].map((digit) => [uri(digit), reused] as const),
    );

    expect(() =>
      snapshotCompletionCandidate(candidate({ objects: new Map([[uri('1'), oversized]]) })),
    ).toThrow(/object.*byte|allocation|limit/i);
    expect(() => snapshotCompletionCandidate(candidate({ objects: aggregate }))).toThrow(
      /aggregate|total|allocation|limit/i,
    );
  });

  it('rejects shared bytes, noncanonical URIs, and iterator-based duplicate injection', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(1));
    const injected = new Map([[uri('1'), Buffer.from('one')]]);
    Object.defineProperty(injected, Symbol.iterator, {
      value: function* entries() {
        yield [uri('1'), Buffer.from('one')];
        yield [uri('1'), Buffer.from('two')];
      },
    });

    expect(() => snapshotCompletionCandidate(candidate({ event_bytes: shared }))).toThrow(
      /shared/i,
    );
    expect(() =>
      snapshotCompletionCandidate(
        candidate({ objects: new Map([['HTTP://host/object', Buffer.alloc(0)]]) }),
      ),
    ).toThrow(/URI|canonical/i);
    expect(() => snapshotCompletionCandidate(candidate({ objects: injected }))).toThrow(
      /iterator|map|duplicate|canonical/i,
    );
  });

  it('does not expose mutable map state or mutable stored object bytes', () => {
    const snapshot = snapshotCompletionCandidate(candidate());
    const first = snapshot.objects.get(uri('1'));
    if (first === undefined) throw new Error('snapshotted object is missing');
    first.fill(0);

    expect(Reflect.get(snapshot.objects, 'set')).toBeUndefined();
    expect(snapshot.objects.get(uri('1'))).toEqual(Buffer.from('object'));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
