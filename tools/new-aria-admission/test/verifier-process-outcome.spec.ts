import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { isJsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';
import { validateExecutionInputEnvelope } from '../src/runtime/execution-input-envelope';
import type { VerifierProcessObservation } from '../src/runtime/verifier-process';
import {
  assertExactVerifierProcessOutcome,
  expectedVerifierProcessOutcome,
} from '../src/runtime/verifier-process-outcome';
import { authenticateVerifierInput } from '../src/verifier/authenticated-input';

import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const verifierPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
type Fixture = ReturnType<typeof productionVerifierFixture>;
let fixture: Fixture | undefined;

function active(): Fixture {
  if (fixture === undefined) throw new TypeError('production fixture is absent');
  return fixture;
}

function observation(
  output: ReturnType<typeof expectedVerifierProcessOutcome>,
  overrides: Partial<Pick<VerifierProcessObservation, 'exit_code' | 'stdout' | 'stderr'>> = {},
): VerifierProcessObservation {
  return {
    materialized_argv: ['/verified/runtime', '/verified/tool'],
    runtime_id: `node@${process.version}`,
    runtime_version: process.version,
    runtime_sha256: '1'.repeat(64),
    tool_sha256: '2'.repeat(64),
    started_at: '2026-09-03T12:00:00.000Z',
    ended_at: '2026-09-03T12:00:01.000Z',
    exit_code: output.exit_code,
    stdout: output.stdout,
    stderr: output.stderr,
    ...overrides,
  };
}

function alteredReceipt(stdout: Uint8Array, field: 'implementation' | 'reason' | 'scope'): Buffer {
  const bytes = Buffer.from(stdout);
  const value = parseStrictJson(bytes.subarray(0, -1));
  if (!isJsonRecord(value)) throw new TypeError('negative receipt fixture is invalid');
  if (field === 'implementation') value.implementation_sha256 = '0'.repeat(64);
  if (field === 'reason') value.reason_code = 'TARGET_HEAD_NOT_AUTHORIZED';
  if (field === 'scope') {
    if (!isJsonRecord(value.scope)) throw new TypeError('negative receipt scope is invalid');
    value.scope.repository_id = 'repo-attacker';
  }
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
}

beforeAll(() => {
  fixture = productionVerifierFixture(verifierPath);
});

afterAll(() => {
  if (fixture !== undefined) {
    fixture.current_epoch_provider.close();
    rmSync(fixture.repository.root, { force: true, recursive: true });
    rmSync(fixture.epoch_store_root, { force: true, recursive: true });
  }
});

describe('authenticated verifier process outcome', () => {
  function negativeOutcome() {
    const value = active();
    const control = value.roster.controls[0];
    if (control === undefined) throw new TypeError('negative control fixture is absent');
    const input = validateExecutionInputEnvelope(control.envelope.bytes);
    const authenticated = authenticateVerifierInput(
      input.object_bytes.slice(0, 4),
      value.operator_root_sha256,
      value.repository.root,
      value.baseline_args,
    );
    return expectedVerifierProcessOutcome(control.run_id, input.object_bytes, authenticated);
  }

  it('rejects canonical negative output returned with infrastructure exit 2', () => {
    const expected = negativeOutcome();
    expect(() =>
      assertExactVerifierProcessOutcome(observation(expected, { exit_code: 2 }), expected),
    ).toThrow(/differs from authenticated oracle/);
  });

  it.each(['implementation', 'reason', 'scope'] as const)(
    'rejects a canonical receipt with changed %s identity',
    (field) => {
      const expected = negativeOutcome();
      expect(() =>
        assertExactVerifierProcessOutcome(
          observation(expected, { stdout: alteredReceipt(expected.stdout, field) }),
          expected,
        ),
      ).toThrow(/differs from authenticated oracle/);
    },
  );

  it('requires exact baseline exit 0 and empty stderr', () => {
    const value = active();
    const input = validateExecutionInputEnvelope(value.roster.baseline_run.envelope.bytes);
    const authenticated = authenticateVerifierInput(
      input.object_bytes,
      value.operator_root_sha256,
      value.repository.root,
      value.baseline_args,
    );
    const expected = expectedVerifierProcessOutcome('BASELINE', input.object_bytes, authenticated);
    expect(() =>
      assertExactVerifierProcessOutcome(
        observation(expected, { stderr: Buffer.from('unexpected\n') }),
        expected,
      ),
    ).toThrow(/differs from authenticated oracle/);
  });
});
