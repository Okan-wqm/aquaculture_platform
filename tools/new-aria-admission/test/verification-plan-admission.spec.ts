import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { assertSignedVerificationPlanEvidence } from '../src/application/verification-plan-admission';
import { assertCompletionVerifyingHistory } from '../src/application/verifying-history-admission';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { isJsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';
import { authenticateVerifierInput } from '../src/verifier/authenticated-input';
import { canonicalVerifierBaselineReport } from '../src/verifier/baseline-report';

import { verifiedGitTarget } from './git-target-fixture';
import { digest } from './operator-authority-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const verifierPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
type Fixture = ReturnType<typeof productionVerifierFixture>;
type Target = ReturnType<typeof verifiedGitTarget>;
let fixture: Fixture | undefined;
let target: Target | undefined;

function active(): { readonly fixture: Fixture; readonly target: Target } {
  if (fixture === undefined || target === undefined) {
    throw new TypeError('verification plan fixture is absent');
  }
  return { fixture, target };
}

function reference(bytes: Uint8Array) {
  const sha256 = digest(bytes);
  return { sha256, uri: `aria-evidence://sha256/${sha256}` };
}

function scenario() {
  const value = active();
  const baselineBytes = canonicalJsonBytes(value.fixture.baseline);
  const authenticated = authenticateVerifierInput(
    [
      baselineBytes,
      value.fixture.operator_envelope_bytes,
      value.fixture.operator_trust_root_bytes,
      value.fixture.current_epoch_snapshot_bytes,
    ],
    value.fixture.operator_root_sha256,
    value.fixture.repository.root,
    value.fixture.baseline_args,
  );
  const reportStdout = canonicalVerifierBaselineReport(authenticated.verification.dossier);
  const reportBytes = reportStdout.subarray(0, -1);
  const objects = new Map<string, Uint8Array>();
  for (const bytes of [
    baselineBytes,
    reportBytes,
    value.fixture.operator_envelope_bytes,
    value.fixture.operator_trust_root_bytes,
    value.fixture.current_epoch_snapshot_bytes,
  ])
    objects.set(reference(bytes).uri, Buffer.from(bytes));
  return {
    manifest: { inputs: [reference(baselineBytes)], report: reference(reportBytes) },
    objects,
    reportBytes,
  };
}

beforeAll(() => {
  fixture = productionVerifierFixture(verifierPath);
  target = verifiedGitTarget(fixture.repository);
});

afterAll(() => {
  if (fixture !== undefined) {
    fixture.current_epoch_provider.close();
    rmSync(fixture.repository.root, { force: true, recursive: true });
    rmSync(fixture.epoch_store_root, { force: true, recursive: true });
  }
});

describe('completion verification plan admission', () => {
  it('recomputes the dossier against the immutable reviewed target snapshot', () => {
    const value = active();
    const input = scenario();
    expect(() =>
      assertSignedVerificationPlanEvidence(
        input.manifest,
        input.objects,
        value.fixture.authority,
        value.target,
        digest(value.fixture.current_epoch_snapshot_bytes),
      ),
    ).not.toThrow();
  });

  it('rejects a rehashed report whose event result differs from dossier recomputation', () => {
    const value = active();
    const input = scenario();
    const report = parseStrictJson(input.reportBytes);
    if (!isJsonRecord(report) || !isJsonRecord(report.result)) {
      throw new TypeError('verifier report fixture is invalid');
    }
    report.result.event_chain_sha256 = '0'.repeat(64);
    const changed = canonicalJsonBytes(report);
    input.objects.delete(input.manifest.report.uri);
    input.objects.set(reference(changed).uri, changed);
    const manifest = { ...input.manifest, report: reference(changed) };
    expect(() =>
      assertSignedVerificationPlanEvidence(
        manifest,
        input.objects,
        value.fixture.authority,
        value.target,
        digest(value.fixture.current_epoch_snapshot_bytes),
      ),
    ).toThrow(/differs from trusted recomputation/);
  });

  it.each(['event', 'manifest', 'predecessor'] as const)(
    'rejects an actual completion history with changed VERIFYING %s bytes',
    (field) => {
      const value = active();
      const input = scenario();
      const verified = assertSignedVerificationPlanEvidence(
        input.manifest,
        input.objects,
        value.fixture.authority,
        value.target,
        digest(value.fixture.current_epoch_snapshot_bytes),
      );
      const events = Buffer.concat([verified.event_chain_bytes, Buffer.from('{}\n')]);
      const manifests = [...verified.manifest_chain_bytes, Buffer.from('{}\n')];
      const predecessor = verified.manifest_chain_sha256s[2];
      if (predecessor === undefined) throw new TypeError('VERIFYING predecessor is absent');
      if (field === 'event') events[0] = events[0] === 0x7b ? 0x5b : 0x7b;
      if (field === 'manifest') manifests[0] = Buffer.from('changed\n');
      expect(() =>
        assertCompletionVerifyingHistory(
          events,
          manifests,
          field === 'predecessor' ? '0'.repeat(64) : predecessor,
          verified,
        ),
      ).toThrow(/differs from signed VERIFYING dossier/);
    },
  );
});
