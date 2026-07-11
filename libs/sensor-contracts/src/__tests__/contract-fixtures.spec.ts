import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import type { ValidateFunction } from 'ajv';

import {
  formatValidationErrors,
  validateBundleManifest,
  validateCommandEnvelope,
  validateDeployBundleParams,
  validateDeployProcessParams,
  validateDeployProgramParams,
  validateDeployScadaPackageParams,
} from '../validators';

/**
 * TS half of the cloud↔edge contract-parity gate (enterprise plan Faz 4).
 *
 * The fixtures under `libs/sensor-contracts/fixtures/` are the SHARED
 * source of truth: this spec proves every fixture satisfies the canonical
 * AJV schemas the cloud validates at its publish boundary, and the Rust
 * integration test (`sens-api-gateway/tests/contract_fixtures.rs`)
 * proves the SAME bytes deserialize into the agent's serde structs
 * (`CommandMessage`, `ScadaProcess`, `ProgramDefinition`,
 * `ScadaPackage`). A wire-shape change that breaks either side turns
 * exactly one of the two builds red — drift cannot land silently.
 */

const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures');

function readFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`fixture ${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function paramsOf(fixture: Record<string, unknown>): Record<string, unknown> {
  const params = fixture.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('fixture params must be a JSON object');
  }
  return params as Record<string, unknown>;
}

function expectValid(validate: ValidateFunction, value: unknown): void {
  const valid = validate(value);
  if (!valid) {
    throw new Error(formatValidationErrors(validate));
  }
  expect(valid).toBe(true);
}

describe('sensor-contracts fixtures — cloud-side schema parity', () => {
  const commandFixtures = [
    'command-envelope.json',
    'deploy-process.json',
    'deploy-program.json',
    'deploy-scada-package.json',
    'deploy-bundle.json',
  ] as const;

  it('every fixture file is covered by this spec (no orphan fixtures)', () => {
    const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
    expect(onDisk.sort()).toEqual([...commandFixtures].sort());
  });

  it.each([...commandFixtures])('%s satisfies the command envelope schema', (name) => {
    expectValid(validateCommandEnvelope, readFixture(name));
  });

  it('deploy-process params satisfy DEPLOY_PROCESS_PARAMS_SCHEMA', () => {
    expectValid(validateDeployProcessParams, paramsOf(readFixture('deploy-process.json')));
  });

  it('deploy-program params satisfy DEPLOY_PROGRAM_PARAMS_SCHEMA', () => {
    expectValid(validateDeployProgramParams, paramsOf(readFixture('deploy-program.json')));
  });

  it('deploy-scada-package params satisfy DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA', () => {
    expectValid(
      validateDeployScadaPackageParams,
      paramsOf(readFixture('deploy-scada-package.json')),
    );
  });

  it('deploy-bundle params satisfy DEPLOY_BUNDLE_PARAMS_SCHEMA and are self-consistent', () => {
    const params = paramsOf(readFixture('deploy-bundle.json'));
    expectValid(validateDeployBundleParams, params);

    // The manifest string's bytes hash to the signed value...
    const manifest = params.manifest as string;
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    expect(manifestSha).toBe(params.manifestSha256);

    // ...the parsed manifest satisfies its own schema...
    const parsedManifest: unknown = JSON.parse(manifest);
    expectValid(validateBundleManifest, parsedManifest);

    // ...and every content string hashes to its manifest-pinned key.
    const contents = params.contents as Record<string, string>;
    for (const [sha, content] of Object.entries(contents)) {
      expect(createHash('sha256').update(content).digest('hex')).toBe(sha);
    }
    const artifacts = (parsedManifest as { artifacts: Array<{ sha256: string }> }).artifacts;
    for (const artifact of artifacts) {
      expect(contents).toHaveProperty(artifact.sha256);
    }
  });

  it('nested scripting keys stay snake_case (the agent has no serde rename on them)', () => {
    const params = paramsOf(readFixture('deploy-program.json'));
    const script = params.script as Record<string, unknown>;
    expect(script).toHaveProperty('on_error');
    expect(script).not.toHaveProperty('onError');

    const functionBlocks = params.functionBlocks as Array<Record<string, unknown>>;
    for (const fb of functionBlocks) {
      expect(fb).toHaveProperty('fb_type');
      expect(fb).not.toHaveProperty('fbType');
    }

    const triggers = script.triggers as Array<Record<string, unknown>>;
    const interval = triggers.find((t) => t.type === 'interval');
    expect(interval).toBeDefined();
    expect(interval).toHaveProperty('interval_secs');
    expect(interval).not.toHaveProperty('intervalSecs');
  });

  it('rejects the historical camelCase drift shape (fbType instead of fb_type)', () => {
    const drifted = {
      ...paramsOf(readFixture('deploy-program.json')),
      functionBlocks: [
        { id: 'delay1', fbType: 'TON', params: {}, inputs: {}, outputs: {} },
      ],
    };
    expect(validateDeployProgramParams(drifted)).toBe(false);
  });

  it('rejects the historical camelCase drift shape (onError instead of on_error)', () => {
    const params = paramsOf(readFixture('deploy-program.json'));
    const script = structuredClone(params.script) as Record<string, unknown>;
    const onError = script.on_error;
    delete script.on_error;
    script.onError = onError;
    expect(validateDeployProgramParams({ ...params, script })).toBe(false);
  });
});
