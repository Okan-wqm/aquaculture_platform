import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CompletionProofBundlePublication,
  materializeCompletionProofBundle,
} from '../src/runtime/completion-proof-bundle';
import { readCompletionProofBundleAuthority } from '../src/runtime/completion-proof-bundle-authority';
import { readCompletionProofBundle } from '../src/runtime/completion-proof-bundle-reader';
import { ensureStagedCompletionProofBundle } from '../src/runtime/completion-proof-bundle-resume';

import { completionProofTransportSource as source } from './completion-proof-bundle-transport-fixture';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('portable completion proof bundle transport', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'new-aria-completion-bundle-'));
    chmodSync(root, 0o700);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('publishes and reloads an exact closed final-proof source roster', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(expected);

    const loaded = readCompletionProofBundle(bundlePath, 'CANDIDATE.json');
    expect(loaded.source.target_request_bytes).toEqual(expected.target_request_bytes);
    expect(loaded.source.event_chain_bytes).toEqual(expected.event_chain_bytes);
    expect(loaded.source.manifest_bytes).toEqual(expected.manifest_bytes);
    expect([...loaded.source.objects]).toEqual([...expected.objects]);
    expect(loaded.source.projection_artifact_bytes).toEqual(expected.projection_artifact_bytes);
    expect(loaded.marker.files.manifests).toHaveLength(4);
    expect(loaded.marker.files.objects).toHaveLength(1);

    publication.abort();
  });

  it('creates a fresh staged candidate only when the public path is absent', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();

    ensureStagedCompletionProofBundle(bundlePath, expected);

    expect(
      readCompletionProofBundle(bundlePath, 'CANDIDATE.json').source.event_chain_bytes,
    ).toEqual(expected.event_chain_bytes);
  });

  it('rejects a changed payload even when its byte length is preserved', () => {
    const bundlePath = join(root, 'bundle');
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(source());
    const path = join(bundlePath, 'payload', 'event-chain.jsonl');
    const bytes = readFileSync(path);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    writeFileSync(path, bytes);

    expect(() => readCompletionProofBundle(bundlePath, 'CANDIDATE.json')).toThrow(
      /differs from its marker/i,
    );
    publication.abort();
  });

  it('rejects an object whose URI does not address its exact bytes', () => {
    const bundlePath = join(root, 'bundle');
    const publication = new CompletionProofBundlePublication(bundlePath);
    const expected = source();
    const objects = new Map(expected.objects);
    const [uri] = objects.keys();
    if (uri === undefined) throw new TypeError('fixture object is absent');
    objects.set(uri, Buffer.from('different object'));

    expect(() => publication.stage({ ...expected, objects })).toThrow(/content address/i);
    expect(existsSync(bundlePath)).toBe(false);
  });

  it('reads only bounded public authority artifacts during pre-authorization', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(expected);
    const [uri] = expected.objects.keys();
    if (uri === undefined) throw new TypeError('fixture object is absent');
    const objectPath = join(
      bundlePath,
      'payload',
      `object-${uri.slice('aria-evidence://sha256/'.length)}.bin`,
    );
    unlinkSync(objectPath);
    execFileSync('mkfifo', [objectPath]);

    expect(readCompletionProofBundleAuthority(bundlePath, 'CANDIDATE.json')).toEqual({
      marker_sha256: digest(readFileSync(join(bundlePath, 'CANDIDATE.json'))),
      operator_envelope_bytes: expected.operator_envelope_bytes,
      operator_trust_root_bytes: expected.operator_trust_root_bytes,
    });
    expect(() => publication.abort()).toThrow();
  });

  it('does not enumerate attacker-sized bundle rosters before authority verification', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(expected);
    const rootJunk = join(bundlePath, 'attacker-junk');
    const payloadJunk = join(bundlePath, 'payload', 'attacker-junk');
    writeFileSync(rootJunk, 'junk');
    writeFileSync(payloadJunk, 'junk');

    expect(readCompletionProofBundleAuthority(bundlePath, 'CANDIDATE.json')).toMatchObject({
      operator_envelope_bytes: expected.operator_envelope_bytes,
      operator_trust_root_bytes: expected.operator_trust_root_bytes,
    });
    expect(() => readCompletionProofBundle(bundlePath, 'CANDIDATE.json')).toThrow(/roster/i);

    unlinkSync(payloadJunk);
    unlinkSync(rootJunk);
    publication.abort();
  });

  it('rejects and preserves an unproven interrupted staging write', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const material = materializeCompletionProofBundle(expected);
    const [name, bytes] = [...material.artifacts][0] ?? [];
    if (name === undefined || bytes === undefined)
      throw new TypeError('fixture artifact is absent');
    mkdirSync(bundlePath, { mode: 0o700 });
    mkdirSync(join(bundlePath, 'staging'), { mode: 0o700 });
    const artifactPath = join(bundlePath, 'staging', name);
    writeFileSync(artifactPath, bytes.subarray(0, 3), { mode: 0o600 });
    const before = lstatSync(artifactPath);

    expect(() => ensureStagedCompletionProofBundle(bundlePath, expected)).toThrow(
      /unproven partial publication/i,
    );
    expect(lstatSync(artifactPath).ino).toBe(before.ino);
    expect(readFileSync(artifactPath)).toEqual(bytes.subarray(0, 3));
  });

  it('rejects and preserves a foreign interrupted staging artifact', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const material = materializeCompletionProofBundle(expected);
    const [name] = [...material.artifacts][0] ?? [];
    if (name === undefined) throw new TypeError('fixture artifact is absent');
    const foreign = Buffer.from('foreign bytes');
    mkdirSync(bundlePath, { mode: 0o700 });
    mkdirSync(join(bundlePath, 'staging'), { mode: 0o700 });
    const artifactPath = join(bundlePath, 'staging', name);
    writeFileSync(artifactPath, foreign, { mode: 0o600 });

    expect(() => ensureStagedCompletionProofBundle(bundlePath, expected)).toThrow(
      /unproven partial publication/i,
    );
    expect(readFileSync(artifactPath)).toEqual(foreign);
  });

  it.each(['payload', 'candidate'] as const)(
    'rejects and preserves an unproven %s publication boundary',
    (boundary) => {
      const bundlePath = join(root, 'bundle');
      const expected = source();
      const material = materializeCompletionProofBundle(expected);
      mkdirSync(bundlePath, { mode: 0o700 });
      mkdirSync(join(bundlePath, 'payload'), { mode: 0o700 });
      for (const [name, bytes] of material.artifacts) {
        writeFileSync(join(bundlePath, 'payload', name), bytes, { mode: 0o600 });
      }
      if (boundary === 'candidate') {
        writeFileSync(join(bundlePath, 'CANDIDATE.json'), material.marker_bytes.subarray(0, 7), {
          mode: 0o600,
        });
      }
      const payloadStat = lstatSync(join(bundlePath, 'payload'));

      expect(() => ensureStagedCompletionProofBundle(bundlePath, expected)).toThrow(
        /unproven partial publication|artifact (bytes differ|metadata is unsafe)/i,
      );
      expect(lstatSync(join(bundlePath, 'payload')).ino).toBe(payloadStat.ino);
      for (const [name, bytes] of material.artifacts) {
        expect(readFileSync(join(bundlePath, 'payload', name))).toEqual(bytes);
      }
      if (boundary === 'candidate') {
        expect(readFileSync(join(bundlePath, 'CANDIDATE.json'))).toEqual(
          material.marker_bytes.subarray(0, 7),
        );
      }
    },
  );

  it('rejects and preserves a foreign empty public bundle directory', () => {
    const bundlePath = join(root, 'bundle');
    mkdirSync(bundlePath, { mode: 0o700 });
    const before = lstatSync(bundlePath);

    expect(() => ensureStagedCompletionProofBundle(bundlePath, source())).toThrow(
      /unproven partial publication/i,
    );
    expect(lstatSync(bundlePath).ino).toBe(before.ino);
    expect(readdirSync(bundlePath)).toEqual([]);
  });

  it('accepts only the exact authenticated CANDIDATE state for restart', () => {
    const bundlePath = join(root, 'bundle');
    const expected = source();
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(expected);
    publication.detachCandidate();

    expect(() => ensureStagedCompletionProofBundle(bundlePath, expected)).not.toThrow();
    expect(
      readCompletionProofBundle(bundlePath, 'CANDIDATE.json').source.event_chain_bytes,
    ).toEqual(expected.event_chain_bytes);
  });
});
