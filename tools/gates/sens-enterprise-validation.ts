#!/usr/bin/env ts-node
/**
 * Sens enterprise validation gate.
 *
 * This gate intentionally validates closure mechanics and known release
 * blockers from executable repository state. A claim marked `closed` must have
 * non-doc evidence and every referenced check must pass. Claims without enough
 * executable evidence stay `blocked`; release mode fails on any blocker.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

type ClaimStatus = 'closed' | 'blocked' | 'fail';
type EvidenceType = 'static' | 'behavioral' | 'hil';
type EvidenceClass =
  | 'workflow_static'
  | 'static_analysis'
  | 'code_and_unit'
  | 'runtime_behavioral'
  | 'hil';

interface ClaimManifest {
  metadata: ManifestMetadata;
  version: number;
  claims: ClaimDefinition[];
  release_profiles: ReleaseProfile[];
}

interface ReleaseProfile {
  id: string;
  title: string;
  feature_tier: string;
  tag_pattern: string;
  blocking_claims: string[];
  non_blocking_claims: string[];
  non_blocking_rationale: string;
}

interface ManifestMetadata {
  plan_id: string;
  plan_path: string;
  reviewed_at: string;
  release_gate: boolean;
  claim_schema: string;
}

interface ClaimDefinition {
  id: string;
  title: string;
  status: ClaimStatus;
  owner: string;
  risk_tier: 'P0' | 'P1' | 'P2' | 'P3';
  release_blocker: boolean;
  evidence_type: EvidenceType;
  evidence_class: EvidenceClass;
  command: string;
  expected_exit: 0 | 1;
  checks: string[];
  plan_refs: string[];
  evidence_refs: string[];
  blocker?: string;
  linked_finding_id: string;
}

interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  exit_code: 0 | 1;
  command: string;
  details: string;
  code_refs: string[];
  files: string[];
}

interface EvaluatedClaim extends ClaimDefinition {
  evaluated_status: 'pass' | 'blocked' | 'fail';
  workflow_run_id: string;
  check_results: Array<Pick<CheckResult, 'id' | 'ok' | 'exit_code' | 'details' | 'code_refs'>>;
  artifact_hashes: Record<string, string>;
  closure_errors: string[];
}

interface RunOptions {
  artifactRoot: string;
  releaseMode: boolean;
  releaseProfile: string | null;
  noArtifacts: boolean;
}

const REPO_ROOT = (() => {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
})();

const MANIFEST_PATH = 'tools/gates/sens-enterprise-claims.json';
const DEFAULT_RELEASE_PROFILE = 'edge-agent-scada-display';
const WORKFLOW_CI = '.github/workflows/ci-affected.yml';
const WORKFLOW_SENS = '.github/workflows/sens-api-gateway-ci.yml';
const WORKFLOW_RELEASE = '.github/workflows/edge-agent-release.yml';
const REQUIRED_STATUS_CHECKS_MANIFEST = '.github/manifests/main-required-status-checks.json';
const DEPLOYMENT_SCOPE_SELECTOR = 'scripts/ci/select-deployment-scope.ts';
const TPM_BUILD_DEPS_ACTION = '.github/actions/install-tpm-build-dependencies/action.yml';
const RUST_TOOLCHAIN = 'rust-toolchain.toml';
const SX1302_HIL_EVIDENCE_SCHEMA = 'tools/gates/sx1302-hil-evidence.schema.json';
const CATALOG = 'sens-api-gateway/src/commands/catalog.rs';
const PERMISSION = 'sens-api-gateway/src/authz/permission.rs';
const IO_CONFIG = 'sens-api-gateway/src/commands/io_config.rs';
const INSTALLER_SCRIPT = 'apps/sensor-service/src/edge-device/installer-script.service.ts';
const EDGE_DEVICE_SERVICE = 'apps/sensor-service/src/edge-device/edge-device.service.ts';
const EDGE_DEVICE_RESOLVER = 'apps/sensor-service/src/edge-device/edge-device.resolver.ts';
const RUST_FIRMWARE = 'sens-api-gateway/src/commands/firmware.rs';
const RUST_APPLY_SIGNED_MANIFEST = 'sens-api-gateway/src/commands/apply_signed_manifest.rs';
const EDGE_RELEASE_ARCHITECTURE_DOC = 'docs/architecture/edge-release-provisioning-ota.md';
const DISALLOWED_WORKFLOW_UPDATE_FLAG = '--update-' + 'baseline';

const ALL_WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const CI_AFFECTED_SENS_FEATURES =
  'health,telemetry,metrics,strict-security,scada-display,lorawan,signed-deploy,tpm,st-bytecode,multi-task-scheduler,opc-ua-server,live-debug,license-enforce';
const CI_ENTERPRISE_SUMMARY_JOBS = [
  'install',
  'lint',
  'type-check',
  'test',
  'sensor-service-gates',
  'sens-api-gateway-rust',
  'sens-enterprise-validation',
  'build',
] as const;
const SENS_GATEWAY_SUMMARY_JOBS = [
  'format',
  'check-default',
  'check-ci-features',
  'clippy',
  'test',
  'test-ci-features',
  'deny',
  'audit',
  'doc',
] as const;
const CLOSED_EVIDENCE_CLASSES = new Set<EvidenceClass>([
  'workflow_static',
  'static_analysis',
  'code_and_unit',
  'runtime_behavioral',
  'hil',
]);
const EVIDENCE_TYPE_BY_CLASS: Record<EvidenceClass, EvidenceType> = {
  workflow_static: 'static',
  static_analysis: 'static',
  code_and_unit: 'behavioral',
  runtime_behavioral: 'behavioral',
  hil: 'hil',
};

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function listWorkflowFiles(): string[] {
  if (!fs.existsSync(ALL_WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(ALL_WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join('.github/workflows', name).replaceAll(path.sep, '/'))
    .sort();
}

/**
 * Local composite actions — `.github/actions/<name>/action.yml`.
 *
 * A composite action's steps run inside the calling job. The runner does not
 * distinguish them from steps written in the workflow file, and neither should
 * a gate that scans for what those steps may not do.
 */
function listCompositeActionFiles(): string[] {
  const root = path.join(REPO_ROOT, '.github', 'actions');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const candidate of ['action.yml', 'action.yaml']) {
      const rel = path.join('.github/actions', entry.name, candidate).replaceAll(path.sep, '/');
      if (fs.existsSync(path.join(REPO_ROOT, rel))) {
        out.push(rel);
        break;
      }
    }
  }
  return out.sort();
}

/**
 * Every file whose STEPS the runner executes as part of a governed job.
 *
 * WHY THIS EXISTS. The three `workflows_do_not_*` checks below scanned
 * `.github/workflows/` only. That was complete while every step lived in a
 * workflow file — and it stopped being complete the moment a step moved into a
 * composite action, which RC-9 did: extracting the sandbox install/verify pair
 * into `.github/actions/ensure-sandbox-backend` carried a `continue-on-error:
 * true` across the boundary and out of enforcement, with the gate still
 * reporting compliance. Refactoring is not supposed to be a way through a gate.
 *
 * Scoped to LOCAL composite actions. A third-party `uses:` is pinned by SHA and
 * reviewed as a dependency; scanning it would be asserting a rule over code this
 * repository does not own.
 *
 * Only the three content-scan checks use this. The workflow-shaped checks
 * (`on:` triggers, top-level `permissions:`, curated job matrices) stay on
 * `listWorkflowFiles()` — an action.yml legitimately has none of those, and
 * demanding them would make the gate noise, which is how gates get deleted.
 */
function listGovernedStepFiles(): string[] {
  return [...listWorkflowFiles(), ...listCompositeActionFiles()];
}

function sha256File(relPath: string): string {
  return createHash('sha256').update(readFile(relPath)).digest('hex');
}

function sensCargoPackageVersion(): string {
  const cargo = readFile('sens-api-gateway/Cargo.toml');
  const versionLine = cargo.split(/\r?\n/).find((line) => line.startsWith('version = '));
  const match = /^version = "([^"]+)"$/.exec(versionLine ?? '');
  const version = match?.[1];
  if (!version) {
    throw new Error('sens-api-gateway Cargo package version not found');
  }
  return version;
}

function lineRef(relPath: string, needle: string): string {
  const src = readFile(relPath);
  const line = src.split(/\r?\n/).findIndex((candidate) => candidate.includes(needle));
  return `${relPath}:${line >= 0 ? line + 1 : 1}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCommentOnlyLines(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#(?!\[)/.test(line))
    .join('\n');
}

function workflowJobBlock(src: string, jobName: string): string {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^ {2}${escapeRegExp(jobName)}:\\s*$`).test(line));
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function hasExecutableText(src: string, value: string): boolean {
  return stripCommentOnlyLines(src).includes(value);
}

function hasAll(src: string, needles: readonly string[]): string[] {
  const uncommented = stripCommentOnlyLines(src);
  return needles.filter((needle) => !uncommented.includes(needle));
}

function sensSpecialistRequiredPathFilters(): string[] {
  const raw: unknown = JSON.parse(readFile(REQUIRED_STATUS_CHECKS_MANIFEST));
  if (!isRecord(raw)) {
    throw new Error(`${REQUIRED_STATUS_CHECKS_MANIFEST} must be a JSON object`);
  }
  return requireStringArray(raw.sens_specialist_required_path_filters, 'sens_specialist_required_path_filters');
}

function representativePathForFilter(filter: string): string {
  return filter.replaceAll('**', 'README.md').replaceAll('*', 'README.md');
}

interface SelectorExecutionResult {
  readonly status: number | null;
  readonly stderr: string;
}

function selectorFailureDetails(
  result: SelectorExecutionResult,
  representativePath: string,
): string {
  const stderr = result.stderr.trim() || '<empty>';
  return `representative=${representativePath} exit=${String(result.status)} stderr=${stderr}`;
}

function observedSpecialistFlags(scope: {
  rustChecksRequired?: boolean;
  sensorChecksRequired?: boolean;
  validationRequired?: boolean;
}): string {
  return [
    `validationRequired=${String(scope.validationRequired)}`,
    `sensorChecksRequired=${String(scope.sensorChecksRequired)}`,
    `rustChecksRequired=${String(scope.rustChecksRequired)}`,
  ].join(', ');
}

function missingCiPathFilterEvidence(src: string): string[] {
  const missing: string[] = [];
  const detectChangesJob = workflowJobBlock(src, 'detect-changes');
  if (!detectChangesJob || !hasExecutableText(detectChangesJob, `node ${DEPLOYMENT_SCOPE_SELECTOR}`)) {
    missing.push(`node ${DEPLOYMENT_SCOPE_SELECTOR}`);
  }
  for (const filter of sensSpecialistRequiredPathFilters()) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, DEPLOYMENT_SCOPE_SELECTOR),
        '--repo',
        REPO_ROOT,
        '--requested-services',
        'auto',
        '--channel',
        'development',
        '--changed-files-json',
        JSON.stringify([representativePathForFilter(filter)]),
        '--affected-projects-json',
        '[]',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      missing.push(`selector failed for ${filter}: ${selectorFailureDetails(result, representativePathForFilter(filter))}`);
      continue;
    }
    try {
      const scope = JSON.parse(result.stdout) as {
        rustChecksRequired?: boolean;
        sensorChecksRequired?: boolean;
        validationRequired?: boolean;
      };
      if (scope.validationRequired !== true || scope.sensorChecksRequired !== true || scope.rustChecksRequired !== true) {
        missing.push(
          `selector specialist coverage for ${filter}: representative=${representativePathForFilter(filter)} observed ${observedSpecialistFlags(scope)}`,
        );
      }
    } catch {
      missing.push(`selector returned invalid JSON for ${filter}`);
    }
  }
  return missing;
}
function missingSummaryDependencyEvidence(
  src: string,
  jobName: string,
  expectedJobs: readonly string[],
  options: { allowNoChangesExit?: boolean } = {},
): string[] {
  const job = workflowJobBlock(src, jobName);
  if (!job) return [`${jobName}:`];

  const missing: string[] = [];
  if (!/if:\s*always\(\)/.test(stripCommentOnlyLines(job))) missing.push('if: always()');
  if (!hasExecutableText(job, 'if [ "$result" != "success" ]; then')) {
    missing.push('if [ "$result" != "success" ]; then');
  }
  if (!hasExecutableText(job, 'exit 1')) missing.push('exit 1');
  for (const expected of expectedJobs) {
    const marker = `needs.${expected}.result`;
    if (!hasExecutableText(job, marker)) missing.push(marker);
  }
  if (options.allowNoChangesExit && !hasExecutableText(job, 'needs.detect-changes.outputs.has_changes')) {
    missing.push('needs.detect-changes.outputs.has_changes');
  }
  return missing;
}

function check(
  id: string,
  title: string,
  ok: boolean,
  details: string,
  files: string[],
  refs: string[],
): CheckResult {
  return {
    id,
    title,
    ok,
    exit_code: ok ? 0 : 1,
    command: `static-check:${id}`,
    details,
    code_refs: refs,
    files,
  };
}

function workflowCommandsOnly(src: string): string {
  return stripCommentOnlyLines(src)
    .split(/\r?\n/)
    .filter((line) =>
      new RegExp(
        `^\\s*(run:|continue-on-error:|\\|\\||.*${escapeRegExp(DISALLOWED_WORKFLOW_UPDATE_FLAG)}|.*cargo\\s+(audit|deny))`,
      ).test(line),
    )
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} must be unique`);
  }
  return strings;
}

function requireClaimIdArray(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an array' : 'a non-empty string array'}`);
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} entries must be non-empty strings`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} must be unique`);
  }
  return strings;
}

function validateSx1302HilEvidence(relPath: string): string[] {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(relPath));
  } catch (error) {
    return [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (!isRecord(raw)) return ['evidence must be an object'];
  const evidence = raw;
  if (evidence.schema_version !== 1) errors.push('schema_version must be 1');
  if (evidence.evidence_kind !== 'sx1302_hil') errors.push('evidence_kind must be sx1302_hil');
  if (evidence.result !== 'pass') errors.push('result must be pass');
  for (const key of ['workflow_run_id', 'commit_sha', 'operator', 'started_at', 'completed_at']) {
    requiredString(evidence, key, errors);
  }

  if (!isRecord(evidence.hardware)) {
    errors.push('hardware must be an object');
  } else {
    for (const key of ['concentrator_model', 'sx1302_hal_source_sha256', 'spi_bus', 'reset_gpio']) {
      const value = evidence.hardware[key];
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`hardware.${key} must be a non-empty string`);
      }
    }
  }

  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    errors.push('commands must be a non-empty array');
  } else if (evidence.commands.some((command) => typeof command !== 'string' || command.length === 0)) {
    errors.push('commands entries must be non-empty strings');
  }

  if (!isRecord(evidence.measurements)) {
    errors.push('measurements must be an object');
  } else {
    if (typeof evidence.measurements.packets_received !== 'number' || evidence.measurements.packets_received < 1) {
      errors.push('measurements.packets_received must be >= 1');
    }
    if (evidence.measurements.tx_acknowledged !== true) {
      errors.push('measurements.tx_acknowledged must be true');
    }
  }

  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
    errors.push('artifacts must be a non-empty array');
  } else if (evidence.artifacts.some((artifact) => typeof artifact !== 'string' || artifact.length === 0)) {
    errors.push('artifacts entries must be non-empty strings');
  }

  return errors;
}

const CHECKS: Record<string, () => CheckResult> = {
  ci_path_filters_cover_sens_surface: () => {
    const src = readFile(WORKFLOW_CI);
    let missing: string[];
    try {
      missing = missingCiPathFilterEvidence(src);
    } catch (error) {
      missing = [error instanceof Error ? error.message : String(error)];
    }
    return check(
      'ci_path_filters_cover_sens_surface',
      'ci-affected selector covers manifest-governed Sens/Rust critical paths',
      missing.length === 0,
      missing.length ? `missing selector specialist evidence: ${missing.join(', ')}` : 'selector requires validation and both Sens specialists for every manifest-governed path',
      [WORKFLOW_CI, REQUIRED_STATUS_CHECKS_MANIFEST, DEPLOYMENT_SCOPE_SELECTOR],
      [
        lineRef(WORKFLOW_CI, `node ${DEPLOYMENT_SCOPE_SELECTOR}`),
        lineRef(REQUIRED_STATUS_CHECKS_MANIFEST, 'sens_specialist_required_path_filters'),
        lineRef(DEPLOYMENT_SCOPE_SELECTOR, 'loadSensSpecialistRequiredPathFilters'),
      ],
    );
  },

  ci_enterprise_validation_job_present: () => {
    const src = readFile(WORKFLOW_CI);
    const job = workflowJobBlock(src, 'sens-enterprise-validation');
    const required = [
      'sens-enterprise-validation:',
      'npm run gates:sens-enterprise-validation',
      'Upload Sens enterprise validation artifacts',
      'if-no-files-found: error',
    ];
    const missing = job ? hasAll(job, required) : ['sens-enterprise-validation:'];
    return check(
      'ci_enterprise_validation_job_present',
      'ci-affected runs the enterprise validation gate and uploads artifacts',
      missing.length === 0,
      missing.length ? `missing workflow markers: ${missing.join(', ')}` : 'enterprise validation job present',
      [WORKFLOW_CI],
      [lineRef(WORKFLOW_CI, 'sens-enterprise-validation:')],
    );
  },

  ci_enterprise_summary_fails_bad_dependencies: () => {
    const src = readFile(WORKFLOW_CI);
    const missing = missingSummaryDependencyEvidence(src, 'sens-enterprise-summary', CI_ENTERPRISE_SUMMARY_JOBS, {
      allowNoChangesExit: true,
    });
    return check(
      'ci_enterprise_summary_fails_bad_dependencies',
      'enterprise summary fails when dependent Sens jobs fail, skip or cancel',
      missing.length === 0,
      missing.length ? `missing summary fail markers: ${missing.join(', ')}` : 'summary dependency checks present',
      [WORKFLOW_CI],
      [lineRef(WORKFLOW_CI, 'sens-enterprise-summary:')],
    );
  },

  ci_affected_sens_rust_uses_curated_features: () => {
    const src = readFile(WORKFLOW_CI);
    const tpmAction = readFile(TPM_BUILD_DEPS_ACTION);
    const job = workflowJobBlock(src, 'sens-api-gateway-rust');
    const missing = job
      ? [
          ...hasAll(src, [`SENS_API_GATEWAY_CI_FEATURES: ${CI_AFFECTED_SENS_FEATURES}`]),
          ...hasAll(job, [
            'uses: ./.github/actions/install-tpm-build-dependencies',
            'cargo check --locked --release --all-targets --features "$SENS_API_GATEWAY_CI_FEATURES"',
          ]),
          ...hasAll(tpmAction, ['pkg-config libtss2-dev', 'timeout 20m apt-get']),
          ...(hasExecutableText(job, 'cargo check --locked --all-features') ? ['must not use cargo check --locked --all-features'] : []),
        ]
      : ['sens-api-gateway-rust:'];
    return check(
      'ci_affected_sens_rust_uses_curated_features',
      'ci-affected Sens Rust job uses curated software feature set, not all-features HAL coupling',
      missing.length === 0,
      missing.length ? `missing curated ci-affected evidence: ${missing.join(', ')}` : 'ci-affected Sens Rust job uses curated features with TPM deps',
      [WORKFLOW_CI, TPM_BUILD_DEPS_ACTION],
      [
        lineRef(WORKFLOW_CI, 'SENS_API_GATEWAY_CI_FEATURES'),
        lineRef(WORKFLOW_CI, 'Cargo check locked curated CI features'),
        lineRef(TPM_BUILD_DEPS_ACTION, 'pkg-config libtss2-dev'),
      ],
    );
  },

  edge_release_has_enterprise_validation_job: () => {
    const src = readFile(WORKFLOW_RELEASE);
    const job = workflowJobBlock(src, 'sens-enterprise-validation');
    const required = [
      'sens-enterprise-validation:',
      'npm run gates:sens-enterprise-validation -- --release',
      'SENS_ENTERPRISE_RELEASE: \'1\'',
      'SENS_ENTERPRISE_RELEASE_PROFILE: edge-agent-scada-display',
      '--release-profile=edge-agent-scada-display',
      'if-no-files-found: error',
    ];
    const missing = job ? hasAll(job, required) : ['sens-enterprise-validation:'];
    return check(
      'edge_release_has_enterprise_validation_job',
      'edge release workflow runs enterprise validation in release mode',
      missing.length === 0,
      missing.length ? `missing release validation markers: ${missing.join(', ')}` : 'release validation job present',
      [WORKFLOW_RELEASE],
      [lineRef(WORKFLOW_RELEASE, 'sens-enterprise-validation:')],
    );
  },

  edge_release_build_needs_enterprise_validation: () => {
    const src = readFile(WORKFLOW_RELEASE);
    const buildJob = workflowJobBlock(src, 'build');
    const missing = hasAll(buildJob, ['needs:', '- release-ref-contract', '- sens-enterprise-validation']);
    return check(
      'edge_release_build_needs_enterprise_validation',
      'edge release build matrix depends on enterprise validation',
      missing.length === 0,
      missing.length === 0
        ? 'build job needs release-ref-contract and enterprise validation'
        : `build job dependency drift: ${missing.join(', ')}`,
      [WORKFLOW_RELEASE],
      [lineRef(WORKFLOW_RELEASE, 'build:')],
    );
  },

  edge_release_rust_toolchain_pinned: () => {
    const release = readFile(WORKFLOW_RELEASE);
    const toolchain = readFile(RUST_TOOLCHAIN);
    const ok =
      hasExecutableText(release, "RUST_TOOLCHAIN: '1.88.0'") &&
      hasExecutableText(toolchain, 'channel = "1.88.0"') &&
      !hasExecutableText(release, 'RUST_TOOLCHAIN: stable');
    return check(
      'edge_release_rust_toolchain_pinned',
      'edge release uses the repository-pinned Rust toolchain',
      ok,
      ok ? 'edge release Rust toolchain is pinned to 1.88.0' : 'edge release still uses an unpinned/stable toolchain or differs from rust-toolchain.toml',
      [WORKFLOW_RELEASE, RUST_TOOLCHAIN],
      [lineRef(WORKFLOW_RELEASE, 'RUST_TOOLCHAIN'), lineRef(RUST_TOOLCHAIN, 'channel')],
    );
  },

  edge_release_tiered_binary_feature_contract: () => {
    const release = readFile(WORKFLOW_RELEASE);
    const sensCi = readFile(WORKFLOW_SENS);
    const buildJob = workflowJobBlock(release, 'build');
    const ok =
      hasExecutableText(release, 'EDGE_RELEASE_FEATURES: scada-display') &&
      hasExecutableText(release, 'CARGO_TARGET_DIR: ${{ github.workspace }}/sens-api-gateway/target') &&
      hasExecutableText(buildJob, 'cross build --target-dir "$CARGO_TARGET_DIR" --release --target ${{ matrix.target }} --features "$EDGE_RELEASE_FEATURES"') &&
      hasExecutableText(sensCi, `SENS_API_GATEWAY_CI_FEATURES: ${CI_AFFECTED_SENS_FEATURES}`) &&
      !hasExecutableText(buildJob, '--features scada-display');
    return check(
      'edge_release_tiered_binary_feature_contract',
      'edge release binary feature tier is explicit and distinct from curated CI/HIL feature gates',
      ok,
      ok
        ? 'release tarball tier is explicitly scada-display; CI curated feature coverage remains separate'
        : 'release feature tier is implicit or drifted from the curated CI feature contract',
      [WORKFLOW_RELEASE, WORKFLOW_SENS],
      [lineRef(WORKFLOW_RELEASE, 'EDGE_RELEASE_FEATURES'), lineRef(WORKFLOW_SENS, 'SENS_API_GATEWAY_CI_FEATURES')],
    );
  },

  edge_release_ref_contract_matches_cargo_semver: () => {
    const release = readFile(WORKFLOW_RELEASE);
    const cargoVersion = sensCargoPackageVersion();
    const required = [
      'VERSION="${GITHUB_REF_NAME#agent-v}"',
      "grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'",
      'CARGO_VERSION="$(awk -F\' = \'',
      'if [ "${VERSION}" != "${CARGO_VERSION}" ]; then',
      'if [ "${GITHUB_REF_NAME}" != "agent-v${CARGO_VERSION}" ]; then',
      'echo "version=${VERSION}" >> "$GITHUB_OUTPUT"',
      'echo "version=${{ needs.release-ref-contract.outputs.version }}" >> "$GITHUB_OUTPUT"',
      'RELEASE_VERSION: ${{ needs.release-ref-contract.outputs.version }}',
    ];
    const forbidden = [
      'echo "version=${GITHUB_REF_NAME#agent-}" >> "$GITHUB_OUTPUT"',
      'needs.sens-enterprise-validation.outputs.version',
      'contains(steps.version.outputs.tag, \'-rc\')',
    ];
    const missing = [
      ...hasAll(release, required),
      ...forbidden.filter((needle) => hasExecutableText(release, needle)).map((needle) => `forbidden marker: ${needle}`),
    ];
    const ok = missing.length === 0 && hasExecutableText(release, 'expected agent-v${CARGO_VERSION}');
    return check(
      'edge_release_ref_contract_matches_cargo_semver',
      'edge release tag contract is canonical agent-v<exact Cargo semver> with no self-referential outputs',
      ok,
      ok
        ? `release ref contract requires agent-v${cargoVersion} and exports validated release-ref-contract outputs`
        : `release ref contract drift: ${missing.join(', ') || 'missing expected agent-v${CARGO_VERSION}'}`,
      [WORKFLOW_RELEASE, 'sens-api-gateway/Cargo.toml'],
      [lineRef(WORKFLOW_RELEASE, 'Validate release ref'), lineRef('sens-api-gateway/Cargo.toml', 'version = ')],
    );
  },

  edge_release_signed_manifest_contract: () => {
    const release = readFile(WORKFLOW_RELEASE);
    const required = [
      'Create release manifest',
      'Sign release manifest with cosign',
      'edge-release-manifest.json',
      "kind: 'suderra.edge.release.manifest'",
      "targets = ['x86_64-linux', 'aarch64-linux', 'armv7-linux']",
      'signature: requireFile(`${base}.tar.gz.sig`)',
      'certificate: requireFile(`${base}.tar.gz.pem`)',
      'artifacts/edge-release-manifest.json.sig',
      'artifacts/edge-release-manifest.json.pem',
      'artifacts/edge-release-manifest.json',
    ];
    const missing = hasAll(release, required);
    return check(
      'edge_release_signed_manifest_contract',
      'edge release publishes a signed machine-readable manifest for all target artifacts',
      missing.length === 0,
      missing.length ? `missing signed manifest markers: ${missing.join(', ')}` : 'signed manifest contract present',
      [WORKFLOW_RELEASE],
      [lineRef(WORKFLOW_RELEASE, 'Create release manifest'), lineRef(WORKFLOW_RELEASE, 'Sign release manifest with cosign')],
    );
  },

  edge_release_runtime_consumers_block_latest_and_legacy_ota: () => {
    const installer = readFile(INSTALLER_SCRIPT);
    const service = readFile(EDGE_DEVICE_SERVICE);
    const resolver = readFile(EDGE_DEVICE_RESOLVER);
    const firmware = readFile(RUST_FIRMWARE);
    const applyManifest = readFile(RUST_APPLY_SIGNED_MANIFEST);
    const required = [
      [installer, 'assertExplicitAgentVersion'],
      [installer, 'AGENT_VERSION cannot be latest'],
      [installer, 'RELEASE_VERSION="\\${AGENT_VERSION#agent-v}"'],
      [service, 'EDGE_LEGACY_OTA_ALLOWED'],
      [service, 'Legacy update_firmware is disabled'],
      [resolver, 'explicit-version-required'],
      [firmware, 'FirmwareUpdateMode::Disabled => LegacyTarballGateDecision::Reject'],
      [applyManifest, 'gate: "ab_partitions_required"'],
    ] as const;
    const missing = required
      .filter(([src, needle]) => !hasExecutableText(src, needle))
      .map(([, needle]) => needle);
    const forbidden = [
      [installer, "AGENT_VERSION', 'latest'"],
      [installer, 'releases?per_page=20'],
      [installer, "grep 'agent-v' | head -1"],
      [service, "targetVersion || 'latest'"],
      [service, 'github_repo'],
      [firmware, 'if target == "latest"'],
      [applyManifest, 'HC-1 backward-compat'],
    ] as const;
    const offenders = forbidden
      .filter(([src, needle]) => hasExecutableText(src, needle))
      .map(([, needle]) => `forbidden marker: ${needle}`);
    const details = [...missing, ...offenders];
    return check(
      'edge_release_runtime_consumers_block_latest_and_legacy_ota',
      'tenant provisioning and edge OTA consumers cannot resolve live latest or legacy GitHub tarball updates by default',
      details.length === 0,
      details.length ? `runtime consumer contract drift: ${details.join(', ')}` : 'runtime consumers require explicit signed release paths',
      [INSTALLER_SCRIPT, EDGE_DEVICE_SERVICE, EDGE_DEVICE_RESOLVER, RUST_FIRMWARE, RUST_APPLY_SIGNED_MANIFEST],
      [
        lineRef(INSTALLER_SCRIPT, 'assertExplicitAgentVersion'),
        lineRef(EDGE_DEVICE_SERVICE, 'EDGE_LEGACY_OTA_ALLOWED'),
        lineRef(RUST_FIRMWARE, 'FirmwareUpdateMode::Disabled'),
        lineRef(RUST_APPLY_SIGNED_MANIFEST, 'ab_partitions_required'),
      ],
    );
  },

  edge_release_docs_mark_rc4_historical_and_define_signed_ota: () => {
    const docExists = fs.existsSync(path.join(REPO_ROOT, EDGE_RELEASE_ARCHITECTURE_DOC));
    const releaseNotes = readFile('docs/releases/sens-api-gateway-edge-v2.0.0-rc4.md');
    const runbook = readFile('docs/runbooks/edge-gateway-rc4-operator.md');
    const architecture = docExists ? readFile(EDGE_RELEASE_ARCHITECTURE_DOC) : '';
    const required = [
      [releaseNotes, 'not an approved production tenant download'],
      [runbook, 'not approved for production tenant downloads'],
      [architecture, 'EdgeReleaseRegistryService'],
      [architecture, 'ProvisioningCredentialService'],
      [architecture, 'apply_signed_manifest'],
      [architecture, 'agent-v<exact Cargo semver>'],
    ] as const;
    const missing = required
      .filter(([src, needle]) => !hasExecutableText(src, needle))
      .map(([, needle]) => needle);
    const ok = docExists && missing.length === 0;
    return check(
      'edge_release_docs_mark_rc4_historical_and_define_signed_ota',
      'edge release documentation marks RC4 historical and defines signed provisioning/OTA architecture',
      ok,
      ok ? 'edge release docs are aligned with signed manifest provisioning architecture' : `documentation drift: ${missing.join(', ')}`,
      [EDGE_RELEASE_ARCHITECTURE_DOC, 'docs/releases/sens-api-gateway-edge-v2.0.0-rc4.md', 'docs/runbooks/edge-gateway-rc4-operator.md'],
      [lineRef(EDGE_RELEASE_ARCHITECTURE_DOC, 'EdgeReleaseRegistryService')],
    );
  },

  edge_release_cargo_deny_not_warning_only: () => {
    const src = readFile(WORKFLOW_RELEASE);
    const commands = workflowCommandsOnly(src);
    const warningPattern = /cargo\s+deny[\s\S]{0,160}(::warning::|\|\|\s*echo)/m;
    const ok = !warningPattern.test(commands) && commands.includes('cargo deny check advisories bans licenses sources');
    return check(
      'edge_release_cargo_deny_not_warning_only',
      'edge release cargo deny fails hard',
      ok,
      ok ? 'cargo deny has no warning-only fallback' : 'cargo deny is missing full hard check or still has warning-only fallback',
      [WORKFLOW_RELEASE],
      [lineRef(WORKFLOW_RELEASE, 'cargo deny')],
    );
  },

  edge_release_cargo_audit_denies_warnings: () => {
    const src = readFile(WORKFLOW_RELEASE);
    const commands = workflowCommandsOnly(src);
    const ok = /cargo\s+audit\s+--deny\s+warnings/.test(commands);
    return check(
      'edge_release_cargo_audit_denies_warnings',
      'edge release cargo audit denies warnings',
      ok,
      ok ? 'cargo audit --deny warnings present' : 'cargo audit --deny warnings missing',
      [WORKFLOW_RELEASE],
      [lineRef(WORKFLOW_RELEASE, 'cargo audit')],
    );
  },

  sens_ci_curated_matrix_present: () => {
    const src = readFile(WORKFLOW_SENS);
    const required = [
      'cargo fmt -- --check',
      'cargo check --locked',
      'cargo check --locked --release --all-targets --features "$SENS_API_GATEWAY_CI_FEATURES"',
      'cargo test --locked --all-targets --no-fail-fast',
      'cargo test --locked --all-targets --features "$SENS_API_GATEWAY_CI_FEATURES"',
      'cargo clippy --locked --all-targets --features "$SENS_API_GATEWAY_CI_FEATURES"',
      'cargo deny check advisories bans licenses sources',
      'cargo audit --deny warnings',
      'sens-api-gateway-summary:',
    ];
    const missing = [...hasAll(src, required), ...missingSummaryDependencyEvidence(src, 'sens-api-gateway-summary', SENS_GATEWAY_SUMMARY_JOBS)];
    return check(
      'sens_ci_curated_matrix_present',
      'sens-api-gateway CI has fmt/check/features/test/clippy/deny/audit plus summary',
      missing.length === 0,
      missing.length ? `missing curated matrix markers: ${missing.join(', ')}` : 'curated matrix present',
      [WORKFLOW_SENS],
      [lineRef(WORKFLOW_SENS, 'SENS_API_GATEWAY_CI_FEATURES')],
    );
  },

  workflows_do_not_suppress_docs_check: () => {
    const suppressionPattern =
      /(markdownlint|npm\s+run\s+(docs-check|test|lint|type-check|gates:[^\s]+)|npx\s+(jest|nx\s+affected|playwright\s+test)|cargo\s+(audit|deny))[^\n]*\|\|\s*(true|echo)/;
    const offenders = listGovernedStepFiles().filter((rel) => suppressionPattern.test(readFile(rel)));
    return check(
      'workflows_do_not_suppress_docs_check',
      'validation workflow commands do not use || true suppression',
      offenders.length === 0,
      offenders.length ? `validation suppression found in ${offenders.join(', ')}` : 'no validation || true workflow suppression found',
      offenders.length ? offenders : listGovernedStepFiles(),
      offenders.length
        ? offenders.map((rel) => lineRef(rel, '|| true'))
        : listGovernedStepFiles().map((rel) => lineRef(rel, 'name:')),
    );
  },

  workflows_do_not_continue_on_error: () => {
    const offenders = listGovernedStepFiles().filter((rel) => /continue-on-error:\s*true/.test(readFile(rel)));
    return check(
      'workflows_do_not_continue_on_error',
      'workflow jobs do not set continue-on-error true',
      offenders.length === 0,
      offenders.length ? `continue-on-error true found in ${offenders.join(', ')}` : 'no continue-on-error true found',
      offenders.length ? offenders : listGovernedStepFiles(),
      offenders.length
        ? offenders.map((rel) => lineRef(rel, 'continue-on-error: true'))
        : listGovernedStepFiles().map((rel) => lineRef(rel, 'name:')),
    );
  },

  workflows_do_not_update_baselines: () => {
    const offenders = listGovernedStepFiles().filter((rel) =>
      readFile(rel).includes(DISALLOWED_WORKFLOW_UPDATE_FLAG),
    );
    return check(
      'workflows_do_not_update_baselines',
      'workflows do not update baselines as part of validation',
      offenders.length === 0,
      offenders.length
        ? `disallowed workflow update flag found in ${offenders.join(', ')}`
        : 'no disallowed workflow update flag use found',
      offenders.length ? offenders : listGovernedStepFiles(),
      offenders.length
        ? offenders.map((rel) => lineRef(rel, DISALLOWED_WORKFLOW_UPDATE_FLAG))
        : listGovernedStepFiles().map((rel) => lineRef(rel, 'name:')),
    );
  },

  write_modbus_uses_modbus_write_permission: () => {
    const catalog = readFile(CATALOG);
    const permission = readFile(PERMISSION);
    const ok =
      catalog.includes('PermissionResolver::ModbusWriteParam') &&
      !/entry!\(\s*"write_modbus"[\s\S]{0,240}PermissionResolver::SafeStateFallback/.test(catalog) &&
      permission.includes('ModbusWrite {');
    return check(
      'write_modbus_uses_modbus_write_permission',
      'write_modbus resolves to ModbusWrite rather than SafeStateTrigger fallback',
      ok,
      ok ? 'write_modbus uses ModbusWriteParam' : 'write_modbus still falls back to SafeStateTrigger or lacks ModbusWrite evidence',
      [CATALOG, PERMISSION],
      [lineRef(CATALOG, '"write_modbus"'), lineRef(PERMISSION, 'ModbusWrite {')],
    );
  },

  update_io_config_uses_manage_io_config: () => {
    const catalog = readFile(CATALOG);
    const permission = readFile(PERMISSION);
    const ok =
      permission.includes('ManageIoConfig') &&
      /"update_io_config"[\s\S]{0,180}StaticPermission::ManageIoConfig/.test(catalog) &&
      !/"update_io_config"[\s\S]{0,180}StaticPermission::ManagePolicy/.test(catalog);
    return check(
      'update_io_config_uses_manage_io_config',
      'update_io_config uses dedicated ManageIoConfig permission',
      ok,
      ok ? 'ManageIoConfig is wired' : 'update_io_config still uses ManagePolicy or ManageIoConfig is missing',
      [CATALOG, PERMISSION],
      [lineRef(CATALOG, '"update_io_config"'), lineRef(PERMISSION, 'ManageIoConfig')],
    );
  },

  refresh_license_uses_manage_license: () => {
    const catalog = readFile(CATALOG);
    const ok =
      /"refresh_license"[\s\S]{0,180}StaticPermission::ManageLicense/.test(catalog) &&
      !/"refresh_license"[\s\S]{0,180}StaticPermission::ManagePolicy/.test(catalog);
    return check(
      'refresh_license_uses_manage_license',
      'refresh_license uses ManageLicense permission',
      ok,
      ok ? 'ManageLicense is wired' : 'refresh_license still uses ManagePolicy',
      [CATALOG, PERMISSION],
      [lineRef(CATALOG, '"refresh_license"'), lineRef(PERMISSION, 'ManageLicense')],
    );
  },

  modbus_output_routing_is_slave_bound: () => {
    const src = readFile(IO_CONFIG);
    const ok =
      !src.includes('state.config.modbus.first()') &&
      src.includes('find(|device| device.slave_id == *slave_id)');
    return check(
      'modbus_output_routing_is_slave_bound',
      'set_output Modbus routing is bound to the configured slave id, not first device',
      ok,
      ok ? 'Modbus output routing is slave-bound' : 'Modbus output routing still selects first configured device or lacks slave-bound lookup',
      [IO_CONFIG],
      [lineRef(IO_CONFIG, 'ProtocolConfig::Modbus')],
    );
  },

  anonymous_only_unsigned_enforcing: () => {
    const catalog = readFile(CATALOG);
    const envelope = readFile('sens-api-gateway/src/command_envelope/envelope.rs');
    const readCommandAllowsUnsigned =
      /"get_config"[\s\S]{0,180}LegacyPolicy::AllowUnsignedInEnforcing/.test(catalog) ||
      /"read_modbus"[\s\S]{0,180}LegacyPolicy::AllowUnsignedInEnforcing/.test(catalog) ||
      /"watch_subscribe"[\s\S]{0,180}LegacyPolicy::AllowUnsignedInEnforcing/.test(catalog);
    const ok =
      !readCommandAllowsUnsigned &&
      catalog.includes('fn only_anonymous_commands_allow_unsigned_legacy_in_enforcing') &&
      envelope.includes('permission_for_command(&env.cmd, &env.params).is_some()') &&
      envelope.includes('fn enforcing_mode_rejects_unsigned_read_permission_command');
    return check(
      'anonymous_only_unsigned_enforcing',
      'enforcing mode allows unsigned traffic only for catalog-anonymous commands',
      ok,
      ok
        ? 'legacy and envelope enforcement are anonymous-only'
        : 'non-anonymous read commands can still be unsigned or the executable regression test is missing',
      [CATALOG, 'sens-api-gateway/src/command_envelope/envelope.rs'],
      [
        lineRef(CATALOG, 'only_anonymous_commands_allow_unsigned_legacy_in_enforcing'),
        lineRef('sens-api-gateway/src/command_envelope/envelope.rs', 'requires_signature'),
      ],
    );
  },

  coapproval_role_expiry_permission_relevance_negative_tests: () =>
    {
      const adapter = readFile('sens-api-gateway/src/commands/envelope_adapter.rs');
      const engine = readFile('sens-api-gateway/src/authz/in_memory_engine.rs');
      const policy = readFile('sens-api-gateway/src/authz/policy.rs');
      const required = [
        [adapter, 'verify_co_approver_if_present'],
        [adapter, 'CoApproverSelfSignature'],
        [adapter, 'co_approver_pubkey_missing_rejects_with_invalid'],
        [engine, 'co_approver_has_relevant_permission'],
        [engine, 'operator_has_active_permission'],
        [engine, 'authorize_allows_tpi_when_co_approver_has_relevant_active_permission'],
        [engine, 'authorize_denies_tpi_self_approval_even_when_primary_has_permission'],
        [engine, 'authorize_denies_tpi_when_co_approver_role_expired'],
        [engine, 'authorize_denies_tpi_when_co_approver_lacks_requested_permission'],
        [policy, 'pub struct CoApproverEvidence'],
      ] as const;
      const missing = required
        .filter(([src, needle]) => !hasExecutableText(src, needle))
        .map(([, needle]) => needle);
      return check(
        'coapproval_role_expiry_permission_relevance_negative_tests',
        'co-approver role, expiry and permission relevance negative tests exist',
        missing.length === 0,
        missing.length
          ? `missing co-approval RBAC evidence: ${missing.join(', ')}`
          : 'co-approval checks cover second signature shape, distinct actor, active role expiry and requested-permission relevance',
        [
          'sens-api-gateway/src/commands/envelope_adapter.rs',
          'sens-api-gateway/src/authz/in_memory_engine.rs',
          'sens-api-gateway/src/authz/policy.rs',
        ],
        [
          lineRef('sens-api-gateway/src/commands/envelope_adapter.rs', 'verify_co_approver_if_present'),
          lineRef('sens-api-gateway/src/authz/in_memory_engine.rs', 'co_approver_has_relevant_permission'),
          lineRef('sens-api-gateway/src/authz/in_memory_engine.rs', 'authorize_denies_tpi_when_co_approver_role_expired'),
        ],
      );
    },

  safe_state_all_outputs_success_required: () =>
    {
      const safeState = readFile('sens-api-gateway/src/safe_state.rs');
      const main = readFile('sens-api-gateway/src/main.rs');
      const required = [
        'pub struct SafeStateResult',
        'pub fn failed_ids(&self) -> Vec<String>',
        'pub fn is_complete_success(&self) -> bool',
        'SafeStateErrorClass::WriteFailed',
        'SafeStateErrorClass::Timeout',
        'test_apply_partial_failure_reports_failed_ids',
      ];
      const missing = [...hasAll(safeState, required), ...hasAll(main, ['!safe_state_result.is_complete_success()', 'not all actuator outputs reached safe-state'])];
      return check(
        'safe_state_all_outputs_success_required',
        'safe-state success requires every output to report success',
        missing.length === 0,
        missing.length
          ? `missing safe-state all-success evidence: ${missing.join(', ')}`
          : 'SafeStateResult carries per-output outcomes and boot aborts on partial success',
        ['sens-api-gateway/src/safe_state.rs', 'sens-api-gateway/src/main.rs'],
        [
          lineRef('sens-api-gateway/src/safe_state.rs', 'pub struct SafeStateResult'),
          lineRef('sens-api-gateway/src/safe_state.rs', 'test_apply_partial_failure_reports_failed_ids'),
          lineRef('sens-api-gateway/src/main.rs', 'not all actuator outputs reached safe-state'),
        ],
      );
    },

  strict_io_config_restart_readback: () =>
    {
      const ioConfig = readFile(IO_CONFIG);
      const main = readFile('sens-api-gateway/src/main.rs');
      const sensorFixture = readFile('apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts');
      const required = [
        'struct AgentIoConfigV2',
        '#[serde(deny_unknown_fields)]',
        'schemaVersion',
        'parse_agent_io_config_v2_to_tags',
        'hydrate_process_image_from_persisted_io_config',
        'file.sync_all()',
        'fsync_parent_dir(config_dir)',
        'canonical_tag_configs(&persisted_value)?',
        'agent_io_config_v2_rejects_legacy_grouped_shape',
        'agent_io_config_v2_rejects_unknown_fields',
        'agent_io_config_v2_rejects_invalid_alarm_order',
        'agent_io_config_v2_rejects_protocol_io_type_mismatch',
        '../../../tools/gates/fixtures/agent-io-config-v2.golden.json',
      ];
      const missing = [
        ...hasAll(ioConfig, required),
        ...hasAll(main, ['hydrate_process_image_from_persisted_io_config', 'persisted I/O config readback failed']),
        ...hasAll(sensorFixture, ['agent-io-config-v2.golden.json', 'schemaVersion']),
      ];
      return check(
        'strict_io_config_restart_readback',
        'I/O config strict schema and restart readback are behaviorally proven',
        missing.length === 0,
        missing.length
          ? `missing strict schema/readback evidence: ${missing.join(', ')}`
          : 'AgentIoConfigV2 parser is strict, persisted atomically, read back, and cross-language golden fixture is covered',
        [IO_CONFIG, 'sens-api-gateway/src/main.rs', 'apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts', 'tools/gates/fixtures/agent-io-config-v2.golden.json'],
        [
          lineRef(IO_CONFIG, 'struct AgentIoConfigV2'),
          lineRef(IO_CONFIG, 'canonical_tag_configs(&persisted_value)?'),
          lineRef('sens-api-gateway/src/main.rs', 'persisted I/O config readback failed'),
          lineRef('apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts', 'agent-io-config-v2.golden.json'),
        ],
      );
    },

  shutdown_io_poll_ordering: () =>
    {
      const ioPoll = readFile('sens-api-gateway/src/io_poll.rs');
      const main = readFile('sens-api-gateway/src/main.rs');
      const required = [
        'pub async fn io_poll_loop',
        'broadcast::Receiver<()>',
        'tokio::select!',
        'I/O poll loop received shutdown; exiting before final safe-state',
      ];
      const missing = [
        ...hasAll(ioPoll, required),
        ...hasAll(main, [
          'let io_poll_shutdown = shutdown_coordinator.subscribe()',
          'tokio::spawn(io_poll::io_poll_loop(state.clone(), io_poll_shutdown))',
          'shutdown_coordinator.register_task("io_poll", io_poll_handle)',
          '.shutdown(Duration::from_secs(shutdown_timeout_secs))',
          'safe-state phase degraded',
        ]),
      ];
      return check(
        'shutdown_io_poll_ordering',
        'io_poll stops before final shutdown safe-state',
        missing.length === 0,
        missing.length
          ? `missing shutdown/io_poll ordering evidence: ${missing.join(', ')}`
          : 'io_poll is shutdown-coordinator registered and exits before final safe-state is applied',
        ['sens-api-gateway/src/io_poll.rs', 'sens-api-gateway/src/main.rs'],
        [
          lineRef('sens-api-gateway/src/io_poll.rs', 'I/O poll loop received shutdown'),
          lineRef('sens-api-gateway/src/main.rs', 'register_task("io_poll"'),
          lineRef('sens-api-gateway/src/main.rs', 'safe-state phase degraded'),
        ],
      );
    },

  runtime_io_safe_state_behavioral_tests: () =>
    check(
      'runtime_io_safe_state_behavioral_tests',
      'Runtime I/O safe-state and strict AgentIoConfigV2 closure has executable behavioral tests',
      false,
      'blocked: SafeStateResult all-output success, strict AgentIoConfigV2 persistence/readback, and shutdown/io_poll ordering evidence are not implemented in this checkout',
      ['sens-api-gateway/src/safe_state.rs', 'sens-api-gateway/src/commands/io_config.rs', 'sens-api-gateway/src/main.rs'],
      [
        lineRef('sens-api-gateway/src/safe_state.rs', 'SafeStateManager'),
        lineRef('sens-api-gateway/src/commands/io_config.rs', 'cmd_update_io_config'),
        lineRef('sens-api-gateway/src/main.rs', 'safe_state'),
      ],
    ),

  cloud_edge_durable_command_lifecycle_behavioral_tests: () =>
    check(
      'cloud_edge_durable_command_lifecycle_behavioral_tests',
      'pushIoConfigToDevice has durable EdgeCommand/outbox lifecycle behavioral evidence',
      false,
      'blocked: pushIoConfigToDevice still lacks durable EdgeCommand row/outbox, signed-envelope response correlation, and applied/failed/rejected/timed_out state tests',
      ['apps/sensor-service/src/edge-device/edge-device.service.ts'],
      [lineRef('apps/sensor-service/src/edge-device/edge-device.service.ts', 'pushIoConfigToDevice')],
    ),

  opcua_s7_physical_write_policy_audit_behavioral_tests: () =>
    check(
      'opcua_s7_physical_write_policy_audit_behavioral_tests',
      'OPC-UA/S7 physical writes have policy and audit behavioral tests',
      false,
      'blocked: write_opcua/write_s7 are still disabled stubs and physical-write closure is not claimed',
      ['sens-api-gateway/src/commands/write.rs'],
      [lineRef('sens-api-gateway/src/commands/write.rs', 'cmd_write_opcua')],
    ),

  sx1302_vendor_hal_hil_evidence: () => {
    const required = process.env.SUDERRA_REQUIRE_SX1302_VENDOR_HAL === '1';
    const hilArtifact = process.env.SUDERRA_SX1302_HIL_EVIDENCE;
    const evidenceExists = Boolean(hilArtifact) && fs.existsSync(path.resolve(REPO_ROOT, hilArtifact ?? ''));
    const schemaExists = fs.existsSync(path.join(REPO_ROOT, SX1302_HIL_EVIDENCE_SCHEMA));
    const schemaErrors = evidenceExists && hilArtifact ? validateSx1302HilEvidence(hilArtifact) : [];
    const ok = required && evidenceExists && schemaExists && schemaErrors.length === 0;
    return check(
      'sx1302_vendor_hal_hil_evidence',
      'SX1302 vendor HAL closure has explicit HIL evidence',
      ok,
      ok
        ? `SX1302 HIL evidence present and schema-valid at ${hilArtifact}`
        : [
            'blocked: set SUDERRA_REQUIRE_SX1302_VENDOR_HAL=1',
            'set SUDERRA_SX1302_HIL_EVIDENCE to a committed schema-valid evidence file',
            ...(schemaErrors.length ? [`schema errors: ${schemaErrors.join('; ')}`] : []),
          ].join('; '),
      [WORKFLOW_SENS, SX1302_HIL_EVIDENCE_SCHEMA, ...(hilArtifact && evidenceExists ? [hilArtifact] : [])],
      [lineRef(WORKFLOW_SENS, 'sx1302-vendor-hal-contract'), lineRef(SX1302_HIL_EVIDENCE_SCHEMA, 'SX1302 HIL Evidence')],
    );
  },
};

function parseArgs(argv: string[]): { options: RunOptions; selfTest: boolean } {
  let selfTest = false;
  let noArtifacts = false;
  let releaseMode = process.env.SENS_ENTERPRISE_RELEASE === '1';
  let releaseProfile = process.env.SENS_ENTERPRISE_RELEASE_PROFILE || null;
  let artifactRoot = process.env.SENS_ENTERPRISE_ARTIFACT_ROOT || 'artifacts/sens-enterprise-validation';

  for (const arg of argv) {
    if (arg === '--self-test') selfTest = true;
    else if (arg === '--no-artifacts') noArtifacts = true;
    else if (arg === '--release') releaseMode = true;
    else if (arg.startsWith('--release-profile=')) releaseProfile = arg.slice('--release-profile='.length);
    else if (arg.startsWith('--artifact-root=')) artifactRoot = arg.slice('--artifact-root='.length);
    else if (arg.length > 0) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (releaseMode && !releaseProfile) {
    releaseProfile = DEFAULT_RELEASE_PROFILE;
  }

  return {
    selfTest,
    options: {
      artifactRoot,
      releaseMode,
      releaseProfile,
      noArtifacts,
    },
  };
}


function loadReleaseProfiles(raw: unknown, claims: ClaimDefinition[]): ReleaseProfile[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('claim manifest release_profiles must be a non-empty array');
  }

  const claimIds = new Set(claims.map((claim) => claim.id));
  const releaseBlockerClaimIds = new Set(claims.filter((claim) => claim.release_blocker).map((claim) => claim.id));
  const profileIds = new Set<string>();

  return raw.map((item, index): ReleaseProfile => {
    if (!isRecord(item)) {
      throw new Error(`release_profile[${index}] must be an object`);
    }
    const profile = item;
    const allowed = new Set(['id', 'title', 'feature_tier', 'tag_pattern', 'blocking_claims', 'non_blocking_claims', 'non_blocking_rationale']);
    for (const key of Object.keys(profile)) {
      if (!allowed.has(key)) throw new Error(`release_profile[${index}] has unknown field: ${key}`);
    }

    const id = profile.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`release_profile[${index}] id must be kebab-case`);
    }
    if (profileIds.has(id)) throw new Error(`duplicate release profile id: ${id}`);
    profileIds.add(id);

    const title = profile.title;
    const featureTier = profile.feature_tier;
    const tagPattern = profile.tag_pattern;
    const deferRationale = profile.non_blocking_rationale;
    if (typeof title !== 'string' || title.length === 0) throw new Error(`release_profile[${id}] title required`);
    if (typeof featureTier !== 'string' || featureTier.length === 0) throw new Error(`release_profile[${id}] feature_tier required`);
    if (typeof tagPattern !== 'string' || tagPattern.length === 0) throw new Error(`release_profile[${id}] tag_pattern required`);
    if (typeof deferRationale !== 'string' || deferRationale.length === 0) {
      throw new Error(`release_profile[${id}] non_blocking_rationale required`);
    }

    const blockingClaims = requireClaimIdArray(profile.blocking_claims, `release_profile[${id}] blocking_claims`, false);
    const nonBlockingClaims = requireClaimIdArray(profile.non_blocking_claims, `release_profile[${id}] non_blocking_claims`, true);
    const nonBlockingSet = new Set(nonBlockingClaims);
    const overlap = blockingClaims.filter((claimId) => nonBlockingSet.has(claimId));
    if (overlap.length > 0) {
      throw new Error(`release_profile[${id}] claims cannot be both blocking and non-blocking: ${overlap.join(', ')}`);
    }

    for (const claimId of [...blockingClaims, ...nonBlockingClaims]) {
      if (!claimIds.has(claimId)) throw new Error(`release_profile[${id}] references unknown claim: ${claimId}`);
    }

    const classified = new Set([...blockingClaims, ...nonBlockingClaims]);
    for (const claimId of releaseBlockerClaimIds) {
      if (!classified.has(claimId)) {
        throw new Error(`release_profile[${id}] must classify release_blocker claim: ${claimId}`);
      }
    }

    return {
      id,
      title,
      feature_tier: featureTier,
      tag_pattern: tagPattern,
      blocking_claims: blockingClaims,
      non_blocking_claims: nonBlockingClaims,
      non_blocking_rationale: deferRationale,
    };
  });
}

function loadManifestObject(raw: unknown): ClaimManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('claim manifest must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const allowedTopLevel = new Set(['$schema', 'version', 'metadata', 'claims', 'release_profiles']);
  for (const key of Object.keys(obj)) {
    if (!allowedTopLevel.has(key)) throw new Error(`claim manifest has unknown field: ${key}`);
  }
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new Error('claim manifest version must be a positive integer');
  }
  if (!isRecord(obj.metadata)) {
    throw new Error('claim manifest metadata must be an object');
  }
  const metadataObj = obj.metadata;
  const allowedMetadata = new Set(['plan_id', 'plan_path', 'reviewed_at', 'release_gate', 'claim_schema']);
  for (const key of Object.keys(metadataObj)) {
    if (!allowedMetadata.has(key)) throw new Error(`claim manifest metadata has unknown field: ${key}`);
  }
  const planId = metadataObj.plan_id;
  const planPath = metadataObj.plan_path;
  const reviewedAt = metadataObj.reviewed_at;
  const claimSchema = metadataObj.claim_schema;
  if (typeof planId !== 'string' || planId.length === 0) {
    throw new Error('claim manifest metadata.plan_id must be a non-empty string');
  }
  if (typeof planPath !== 'string' || planPath.length === 0) {
    throw new Error('claim manifest metadata.plan_path must be a non-empty string');
  }
  if (typeof reviewedAt !== 'string' || reviewedAt.length === 0) {
    throw new Error('claim manifest metadata.reviewed_at must be a non-empty string');
  }
  if (typeof claimSchema !== 'string' || claimSchema.length === 0) {
    throw new Error('claim manifest metadata.claim_schema must be a non-empty string');
  }
  if (metadataObj.release_gate !== true) {
    throw new Error('claim manifest metadata.release_gate must be true');
  }
  const metadata: ManifestMetadata = {
    plan_id: planId,
    plan_path: planPath,
    reviewed_at: reviewedAt,
    release_gate: true,
    claim_schema: claimSchema,
  };
  if (!Array.isArray(obj.claims) || obj.claims.length === 0) {
    throw new Error('claim manifest must contain at least one claim');
  }

  const ids = new Set<string>();
  const claims = obj.claims.map((item, index): ClaimDefinition => {
    if (!item || typeof item !== 'object') {
      throw new Error(`claim[${index}] must be an object`);
    }
    const claim = item as Record<string, unknown>;
    const allowed = new Set([
      'id',
      'title',
      'status',
      'owner',
      'risk_tier',
      'release_blocker',
      'evidence_type',
      'evidence_class',
      'command',
      'expected_exit',
      'checks',
      'plan_refs',
      'evidence_refs',
      'blocker',
      'linked_finding_id',
    ]);
    for (const key of Object.keys(claim)) {
      if (!allowed.has(key)) throw new Error(`claim[${index}] has unknown field: ${key}`);
    }
    const id = claim.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`claim[${index}] id must be kebab-case`);
    }
    if (ids.has(id)) throw new Error(`duplicate claim id: ${id}`);
    ids.add(id);

    const title = claim.title;
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error(`claim[${id}] title required`);
    }
    const status = claim.status;
    if (status !== 'closed' && status !== 'blocked' && status !== 'fail') {
      throw new Error(`claim[${id}] status must be closed, blocked or fail`);
    }
    const owner = claim.owner;
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new Error(`claim[${id}] owner required`);
    }
    const riskTier = claim.risk_tier;
    if (riskTier !== 'P0' && riskTier !== 'P1' && riskTier !== 'P2' && riskTier !== 'P3') {
      throw new Error(`claim[${id}] risk_tier must be P0, P1, P2 or P3`);
    }
    const releaseBlocker = claim.release_blocker;
    if (typeof releaseBlocker !== 'boolean') {
      throw new Error(`claim[${id}] release_blocker must be boolean`);
    }
    const evidenceType = claim.evidence_type;
    if (evidenceType !== 'static' && evidenceType !== 'behavioral' && evidenceType !== 'hil') {
      throw new Error(`claim[${id}] evidence_type must be static, behavioral or hil`);
    }
    const evidence = claim.evidence_class;
    if (
      evidence !== 'workflow_static' &&
      evidence !== 'static_analysis' &&
      evidence !== 'code_and_unit' &&
      evidence !== 'runtime_behavioral' &&
      evidence !== 'hil'
    ) {
      throw new Error(`claim[${id}] evidence_class is invalid or missing`);
    }
    if (EVIDENCE_TYPE_BY_CLASS[evidence] !== evidenceType) {
      throw new Error(`claim[${id}] evidence_type does not match evidence_class`);
    }
    const command = claim.command;
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`claim[${id}] command required`);
    }
    const expectedExit = claim.expected_exit;
    if (expectedExit !== 0 && expectedExit !== 1) {
      throw new Error(`claim[${id}] expected_exit must be 0 or 1`);
    }
    const checks = claim.checks;
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((c) => typeof c !== 'string' || c.length === 0)) {
      throw new Error(`claim[${id}] checks must be a non-empty string array`);
    }
    const uniqueChecks = new Set(checks as string[]);
    if (uniqueChecks.size !== checks.length) {
      throw new Error(`claim[${id}] checks must be unique`);
    }
    const planRefs = requireStringArray(claim.plan_refs, `claim[${id}] plan_refs`);
    const evidenceRefs = requireStringArray(claim.evidence_refs, `claim[${id}] evidence_refs`);
    const blocker = claim.blocker;
    if (status === 'blocked' && (typeof blocker !== 'string' || blocker.length === 0)) {
      throw new Error(`claim[${id}] blocked status requires blocker text`);
    }
    if (status === 'closed' && !CLOSED_EVIDENCE_CLASSES.has(evidence)) {
      throw new Error(`claim[${id}] uses non-executable evidence_class`);
    }
    const linkedFindingId = claim.linked_finding_id;
    if (typeof linkedFindingId !== 'string' || linkedFindingId.length === 0) {
      throw new Error(`claim[${id}] linked_finding_id required`);
    }
    return {
      id,
      title,
      status,
      owner,
      risk_tier: riskTier,
      release_blocker: releaseBlocker,
      evidence_type: evidenceType,
      evidence_class: evidence,
      command,
      expected_exit: expectedExit,
      checks: checks as string[],
      plan_refs: planRefs,
      evidence_refs: evidenceRefs,
      ...(typeof blocker === 'string' ? { blocker } : {}),
      linked_finding_id: linkedFindingId,
    };
  });

  const releaseProfiles = loadReleaseProfiles(obj.release_profiles, claims);

  return { version: obj.version, metadata, claims, release_profiles: releaseProfiles };
}

function evaluateClaim(
  claim: ClaimDefinition,
  checkResults: Map<string, CheckResult>,
  workflowRunId: string,
): EvaluatedClaim {
  const closureErrors: string[] = [];
  const results = claim.checks.map((id) => {
    const result = checkResults.get(id);
    if (!result) {
      const missing: CheckResult = {
        id,
        title: id,
        ok: false,
        exit_code: 1,
        command: `static-check:${id}`,
        details: 'claim references an unknown check',
        code_refs: [],
        files: [],
      };
      return missing;
    }
    return result;
  });

  if (claim.status === 'closed') {
    for (const result of results) {
      if (!result.ok) closureErrors.push(`check failed: ${result.id}: ${result.details}`);
      if (result.code_refs.length === 0) closureErrors.push(`check has no code refs: ${result.id}`);
    }
    if (claim.evidence_class === 'hil' && process.env.SUDERRA_REQUIRE_SX1302_VENDOR_HAL !== '1') {
      closureErrors.push('HIL closure requires SUDERRA_REQUIRE_SX1302_VENDOR_HAL=1');
    }
  }

  const files = new Set(results.flatMap((result) => result.files));
  const hashes: Record<string, string> = {};
  for (const file of files) {
    if (fs.existsSync(path.join(REPO_ROOT, file))) {
      hashes[file] = sha256File(file);
    }
  }

  let evaluatedStatus: EvaluatedClaim['evaluated_status'];
  if (claim.status === 'blocked') evaluatedStatus = 'blocked';
  else if (claim.status === 'fail' || closureErrors.length > 0) evaluatedStatus = 'fail';
  else evaluatedStatus = 'pass';

  return {
    ...claim,
    evaluated_status: evaluatedStatus,
    workflow_run_id: workflowRunId,
    check_results: results.map((result) => ({
      id: result.id,
      ok: result.ok,
      exit_code: result.exit_code,
      details: result.details,
      code_refs: result.code_refs,
    })),
    artifact_hashes: hashes,
    closure_errors: closureErrors,
  };
}

function timestampForArtifact(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

function writeJsonArtifact(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function writeArtifacts(
  options: RunOptions,
  claims: EvaluatedClaim[],
  commands: CheckResult[],
  metadata: ManifestMetadata,
  manifestHash: string,
  releaseProfile: ReleaseProfile | null,
): string | null {
  if (options.noArtifacts) return null;
  const dir = path.resolve(REPO_ROOT, options.artifactRoot, timestampForArtifact());
  fs.mkdirSync(dir, { recursive: true });

  const claimsPath = path.join(dir, 'claims.json');
  const commandsPath = path.join(dir, 'commands.json');
  const reportPath = path.join(dir, 'report.md');

  writeJsonArtifact(claimsPath, {
    generated_at: new Date().toISOString(),
    release_mode: options.releaseMode,
    release_profile: releaseProfile,
    manifest: MANIFEST_PATH,
    manifest_metadata: metadata,
    manifest_sha256: manifestHash,
    claims,
  });

  writeJsonArtifact(commandsPath, {
    generated_at: new Date().toISOString(),
    commands,
  });

  const passCount = claims.filter((claim) => claim.evaluated_status === 'pass').length;
  const blockedCount = claims.filter((claim) => claim.evaluated_status === 'blocked').length;
  const failCount = claims.filter((claim) => claim.evaluated_status === 'fail').length;
  const lines = [
    '# Sens Enterprise Validation',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Release mode: ${options.releaseMode ? 'yes' : 'no'}`,
    `- Release profile: ${releaseProfile ? releaseProfile.id : 'none'}`,
    ...(releaseProfile
      ? [
          `- Release profile tier: ${releaseProfile.feature_tier}`,
          `- Blocking profile claims: ${releaseProfile.blocking_claims.join(', ')}`,
          `- Non-blocking profile claims: ${releaseProfile.non_blocking_claims.join(', ') || 'none'}`,
          `- Non-blocking rationale: ${releaseProfile.non_blocking_rationale}`,
        ]
      : []),
    `- Plan: ${metadata.plan_id} (${metadata.plan_path})`,
    `- Manifest hash: ${manifestHash}`,
    `- Claims: ${passCount} pass, ${blockedCount} blocked, ${failCount} fail`,
    '',
    '## Claims',
    '',
    ...claims.flatMap((claim) => [
      `### ${claim.id}`,
      '',
      `- Status: ${claim.evaluated_status}`,
      `- Owner: ${claim.owner}`,
      `- Risk tier: ${claim.risk_tier}`,
      `- Release blocker: ${claim.release_blocker ? 'yes' : 'no'}`,
      `- Evidence type: ${claim.evidence_type}`,
      `- Evidence class: ${claim.evidence_class}`,
      `- Command: ${claim.command}`,
      `- Expected exit: ${claim.expected_exit}`,
      `- Linked finding: ${claim.linked_finding_id}`,
      `- Plan refs: ${claim.plan_refs.join(', ')}`,
      `- Evidence refs: ${claim.evidence_refs.join(', ')}`,
      `- Code refs: ${claim.check_results.flatMap((result) => result.code_refs).join(', ') || 'none'}`,
      ...(claim.blocker ? [`- Blocker: ${claim.blocker}`] : []),
      ...(claim.closure_errors.length ? [`- Closure errors: ${claim.closure_errors.join('; ')}`] : []),
      '',
    ]),
  ];
  fs.writeFileSync(reportPath, lines.join('\n'));

  return path.relative(REPO_ROOT, dir);
}


function resolveReleaseProfile(manifest: ClaimManifest, options: RunOptions): ReleaseProfile | null {
  if (!options.releaseMode && !options.releaseProfile) return null;

  const profileId = options.releaseProfile || DEFAULT_RELEASE_PROFILE;
  const profile = manifest.release_profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    const available = manifest.release_profiles.map((candidate) => candidate.id).join(', ') || 'none';
    throw new Error(`unknown release profile: ${profileId}; available profiles: ${available}`);
  }
  return profile;
}

function runGate(options: RunOptions): { exitCode: number; artifactDir: string | null; claims: EvaluatedClaim[] } {
  const manifestRaw = readFile(MANIFEST_PATH);
  const manifest = loadManifestObject(JSON.parse(manifestRaw));
  const manifestHash = createHash('sha256').update(manifestRaw).digest('hex');
  const releaseProfile = resolveReleaseProfile(manifest, options);

  const checkIds = new Set(manifest.claims.flatMap((claim) => claim.checks));
  const results = new Map<string, CheckResult>();
  for (const id of checkIds) {
    const factory = CHECKS[id];
    if (!factory) {
      results.set(id, {
        id,
        title: id,
        ok: false,
        exit_code: 1,
        command: `static-check:${id}`,
        details: 'unknown check id',
        code_refs: [],
        files: [],
      });
      continue;
    }
    results.set(id, factory());
  }

  const workflowRunId = process.env.GITHUB_RUN_ID || 'local';
  const claims = manifest.claims.map((claim) => evaluateClaim(claim, results, workflowRunId));
  const commands = [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  const artifactDir = writeArtifacts(options, claims, commands, manifest.metadata, manifestHash, releaseProfile);

  const failedClosedClaims = claims.filter((claim) => claim.status === 'closed' && claim.evaluated_status !== 'pass');
  const failedClaims = claims.filter((claim) => claim.evaluated_status === 'fail' && claim.status !== 'closed');
  const blockedClaims = claims.filter((claim) => claim.evaluated_status === 'blocked');

  writeStdout(
    `sens-enterprise-validation: ${claims.filter((c) => c.evaluated_status === 'pass').length} pass, ` +
      `${blockedClaims.length} blocked, ${failedClosedClaims.length + failedClaims.length} fail` +
      (releaseProfile ? `; profile=${releaseProfile.id}` : '') +
      (artifactDir ? `; artifacts=${artifactDir}` : ''),
  );

  if (failedClosedClaims.length > 0) {
    for (const claim of failedClosedClaims) {
      writeStderr(`FAIL closed-claim ${claim.id}: ${claim.closure_errors.join('; ')}`);
    }
    return { exitCode: 1, artifactDir, claims };
  }

  if (failedClaims.length > 0) {
    for (const claim of failedClaims) {
      writeStderr(`FAIL claim ${claim.id}`);
    }
    return { exitCode: 1, artifactDir, claims };
  }

  const blockedReleaseClaims = blockedClaims;

  if (options.releaseMode && blockedReleaseClaims.length > 0) {
    for (const claim of blockedReleaseClaims) {
      writeStderr(`BLOCKED release claim ${claim.id}: ${claim.blocker ?? 'no blocker detail'}`);
    }
    return { exitCode: 1, artifactDir, claims };
  }

  return { exitCode: 0, artifactDir, claims };
}

function runSelfTest(): void {
  const metadata: ManifestMetadata = {
    plan_id: 'self-test',
    plan_path: 'tools/gates/sens-enterprise-validation.ts',
    reviewed_at: '2026-05-13',
    release_gate: true,
    claim_schema: 'tools/gates/sens-enterprise-claims.schema.json',
  };

  assert.throws(
    () => loadManifestObject({ version: 1, claims: [{ id: 'bad', title: 'Bad', status: 'closed', checks: ['x'] }] }),
    /metadata/,
  );
  assert.throws(
    () =>
      loadManifestObject({
        version: 1,
        metadata,
        claims: [
          {
            id: 'blocked-no-reason',
            title: 'Blocked no reason',
            status: 'blocked',
            owner: 'safety',
            risk_tier: 'P0',
            release_blocker: true,
            evidence_type: 'behavioral',
            evidence_class: 'runtime_behavioral',
            command: 'static-check:x',
            expected_exit: 0,
            checks: ['x'],
            plan_refs: ['self-test plan'],
            evidence_refs: ['tools/gates/sens-enterprise-validation.ts'],
            linked_finding_id: 'SELF-TEST',
          },
        ],
      }),
    /blocked status requires blocker/,
  );

  const manifest = loadManifestObject({
    version: 1,
    metadata,
    release_profiles: [
      {
        id: 'self-test-profile',
        title: 'Self-test profile',
        feature_tier: 'self-test',
        tag_pattern: 'self-test-*',
        blocking_claims: ['closed-claim'],
        non_blocking_claims: ['blocked-claim'],
        non_blocking_rationale: 'self-test non-blocking claim remains outside the closed release profile',
      },
    ],
    claims: [
      {
        id: 'closed-claim',
        title: 'Closed claim',
        status: 'closed',
        owner: 'safety',
        risk_tier: 'P1',
        release_blocker: true,
        evidence_type: 'static',
        evidence_class: 'static_analysis',
        command: 'static-check:passing',
        expected_exit: 0,
        checks: ['passing'],
        plan_refs: ['self-test plan'],
        evidence_refs: ['package.json'],
        linked_finding_id: 'SELF-TEST',
      },
      {
        id: 'blocked-claim',
        title: 'Blocked claim',
        status: 'blocked',
        owner: 'safety',
        risk_tier: 'P0',
        release_blocker: true,
        evidence_type: 'hil',
        evidence_class: 'hil',
        command: 'static-check:blocked',
        expected_exit: 0,
        checks: ['blocked'],
        plan_refs: ['self-test HIL plan'],
        evidence_refs: ['package.json'],
        blocker: 'needs HIL',
        linked_finding_id: 'SELF-TEST',
      },
    ],
  });
  const checks = new Map<string, CheckResult>([
    [
      'passing',
      check('passing', 'Passing', true, 'ok', ['package.json'], ['package.json:1']),
    ],
    ['blocked', check('blocked', 'Blocked', false, 'blocked', ['package.json'], ['package.json:1'])],
  ]);
  const evaluated = manifest.claims.map((claim) => evaluateClaim(claim, checks, 'self-test'));
  assert.equal(evaluated[0]?.evaluated_status, 'pass');
  assert.equal(evaluated[1]?.evaluated_status, 'blocked');
  writeStdout('sens-enterprise-validation self-test: ok');
}

function main(): void {
  const { options, selfTest } = parseArgs(process.argv.slice(2));
  if (selfTest) {
    runSelfTest();
    return;
  }
  const result = runGate(options);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
