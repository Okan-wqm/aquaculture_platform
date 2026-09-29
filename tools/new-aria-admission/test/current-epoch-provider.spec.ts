import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as directoryIo from '../src/adapters/file-checkpoint-directory-io';
import { currentEpochSnapshotFileName } from '../src/adapters/file-current-epoch-binding';
import {
  FileCurrentEpochProvider,
  readCurrentEpochSnapshot,
} from '../src/adapters/file-current-epoch-provider';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import {
  currentEpochProviderFixture,
  currentEpochProviderId,
  currentEpochSnapshotBytes,
  currentEpochStoreFixture,
} from './current-epoch-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';

describe('external current invalidation epoch provider', () => {
  const roots: string[] = [];
  const providers: FileCurrentEpochProvider[] = [];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const provider of providers.splice(0)) provider.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rereads D1 to D2 and durably rejects rollback in-process and after restart', () => {
    const trustRoot = operatorTrustRootBytes();
    const store = currentEpochStoreFixture(trustRoot);
    roots.push(store.root);
    const authorityBytes = s01ProgressAuthorityBytes(store.authority);
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes,
        observedAt: '2026-09-02T12:00:00.000Z',
        validUntil: '2026-09-02T14:00:00.000Z',
      }),
      trust_root_bytes: trustRoot,
      expected_trust_root_sha256: digest(trustRoot),
    });
    const fixture = currentEpochProviderFixture(authority, trustRoot, store);
    providers.push(fixture.provider);

    fixture.writeSnapshot({ revision: 2, dependency_sha256: 'a'.repeat(64) });
    expect(readCurrentEpochSnapshot(fixture.provider, authority).epochs.get('dependency')).toBe(
      `sha256:${'a'.repeat(64)}`,
    );
    fixture.writeSnapshot({ revision: 1 });
    expect(() => readCurrentEpochSnapshot(fixture.provider, authority)).toThrow(/rollback|state/i);
    fixture.provider.close();
    const restarted = new FileCurrentEpochProvider({
      state_root: store.root,
      provider_id: currentEpochProviderId,
      operator_trust_root_bytes: trustRoot,
      expected_operator_trust_root_sha256: digest(trustRoot),
    });
    providers.push(restarted);
    expect(() => readCurrentEpochSnapshot(restarted, authority)).toThrow(/rollback|state/i);
  });

  it('rejects a stale signed snapshot moved to a fresh caller-selected state root', () => {
    const trustRoot = operatorTrustRootBytes();
    const canonicalStore = currentEpochStoreFixture(trustRoot);
    const alternateStore = currentEpochStoreFixture(trustRoot);
    roots.push(canonicalStore.root, alternateStore.root);
    const authorityBytes = s01ProgressAuthorityBytes(canonicalStore.authority);
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes,
        observedAt: '2026-09-02T12:00:00.000Z',
        validUntil: '2026-09-02T14:00:00.000Z',
      }),
      trust_root_bytes: trustRoot,
      expected_trust_root_sha256: digest(trustRoot),
    });
    const canonical = currentEpochProviderFixture(authority, trustRoot, canonicalStore);
    const alternate = currentEpochProviderFixture(authority, trustRoot, alternateStore);
    providers.push(canonical.provider, alternate.provider);
    canonical.writeSnapshot({ revision: 2, dependency_sha256: 'a'.repeat(64) });

    expect(readCurrentEpochSnapshot(canonical.provider, authority).revision).toBe(2);
    expect(() => readCurrentEpochSnapshot(alternate.provider, authority)).toThrow(
      /provider identity/i,
    );
  });

  it('reads the snapshot and durable state through the held directory descriptor', () => {
    const trustRoot = operatorTrustRootBytes();
    const store = currentEpochStoreFixture(trustRoot);
    roots.push(store.root);
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes: s01ProgressAuthorityBytes(store.authority),
        observedAt: '2026-09-02T12:00:00.000Z',
        validUntil: '2026-09-02T14:00:00.000Z',
      }),
      trust_root_bytes: trustRoot,
      expected_trust_root_sha256: digest(trustRoot),
    });
    const fixture = currentEpochProviderFixture(authority, trustRoot, store);
    providers.push(fixture.provider);
    const displaced = `${store.root}-displaced`;
    let swapped = false;
    const readCheckpointFile = directoryIo.readCheckpointFile;
    jest.spyOn(directoryIo, 'readCheckpointFile').mockImplementation((...args) => {
      if (!swapped && args[1] === currentEpochSnapshotFileName) {
        swapped = true;
        renameSync(store.root, displaced);
        mkdirSync(store.root, { mode: 0o700 });
        writeFileSync(
          join(store.root, currentEpochSnapshotFileName),
          currentEpochSnapshotBytes(authority, {
            revision: 2,
            dependency_sha256: 'a'.repeat(64),
          }),
          { mode: 0o600 },
        );
        try {
          return readCheckpointFile(...args);
        } finally {
          rmSync(store.root, { recursive: true, force: true });
          renameSync(displaced, store.root);
        }
      }
      return readCheckpointFile(...args);
    });

    expect(readCurrentEpochSnapshot(fixture.provider, authority).revision).toBe(1);
    expect(swapped).toBe(true);
  });

  it('rejects an over-budget durable state roster incrementally', () => {
    const trustRoot = operatorTrustRootBytes();
    const store = currentEpochStoreFixture(trustRoot);
    roots.push(store.root);
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes: s01ProgressAuthorityBytes(store.authority),
      }),
      trust_root_bytes: trustRoot,
      expected_trust_root_sha256: digest(trustRoot),
    });
    const fixture = currentEpochProviderFixture(authority, trustRoot, store);
    providers.push(fixture.provider);
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(store.root, `.junk-${index.toString().padStart(4, '0')}`), '');
    }

    expect(() => readCurrentEpochSnapshot(fixture.provider, authority)).toThrow(/entry limit/i);
  });
});
