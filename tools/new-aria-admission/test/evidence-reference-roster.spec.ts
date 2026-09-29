import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyEvidenceChain } from '../src/kernel/evidence-chain';

import { MutableFixture } from './mutable-fixture';
import { evidenceBundle } from './progress-fixture';

type Manifest = MutableFixture<ReturnType<typeof evidenceBundle>['manifest']>;

class CountingObjectMap extends Map<string, Uint8Array> {
  reads = 0;

  override get(key: string): Uint8Array | undefined {
    this.reads += 1;
    return super.get(key);
  }
}

function manifestBytes(value: Manifest): Buffer {
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
}

describe('evidence reference roster bounds', () => {
  it('rejects a duplicated role before reading or hashing the referenced object', () => {
    const bundle = evidenceBundle('d'.repeat(64));
    const manifest = bundle.manifest as Manifest;
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) throw new Error('artifact fixture is missing');
    manifest.artifacts = [artifact, artifact];
    const objects = new CountingObjectMap(bundle.objects);

    expect(() => verifyEvidenceChain([manifestBytes(manifest)], objects)).toThrow(/reused/);
    expect(objects.reads).toBe(0);
  });

  it('rejects the artifact-count boundary before any object lookup', () => {
    const bundle = evidenceBundle('d'.repeat(64));
    const manifest = bundle.manifest as Manifest;
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) throw new Error('artifact fixture is missing');
    manifest.artifacts = Array.from({ length: 129 }, (_, index) => ({
      uri: `aria-evidence://sha256/${index.toString(16).padStart(64, '0')}`,
      sha256: index.toString(16).padStart(64, '0'),
    }));
    const objects = new CountingObjectMap(bundle.objects);

    expect(() => verifyEvidenceChain([manifestBytes(manifest)], objects)).toThrow(/artifact.*bound/i);
    expect(objects.reads).toBe(0);
  });
});
