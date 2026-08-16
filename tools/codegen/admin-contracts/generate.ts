#!/usr/bin/env ts-node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { compileAdminHttpContractsV2 } from './compiler';
import { ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1 } from './diagnostic-baseline.v2';
import {
  canonicalAdminHttpContractArtifactJsonV2,
  canonicalAdminHttpContractDebtBaselineTypeScriptV1,
  createAdminHttpContractDebtBaselineV1,
} from './governance';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ARTIFACT_PATH = join(
  REPO_ROOT,
  'platform/libs/admin-http-contracts/src/generated/admin-http-contract-compilation.v2.json',
);
const FINDING_REGISTRY_PATH = join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

type CommandMode = '--check' | '--print-baseline' | '--report' | '--write';

interface TrackedFinding {
  readonly deadline: string | null;
  readonly id: string;
  readonly ownerAgent: string;
  readonly state: string;
}

function commandMode(arguments_: readonly string[]): CommandMode {
  if (arguments_.length !== 1) {
    throw new Error('Usage: generate.ts <--check|--write|--report|--print-baseline>');
  }
  const [mode] = arguments_;
  if (
    mode !== '--check' &&
    mode !== '--write' &&
    mode !== '--report' &&
    mode !== '--print-baseline'
  ) {
    throw new Error('Usage: generate.ts <--check|--write|--report|--print-baseline>');
  }
  return mode;
}

function readTrackedFinding(id: string): TrackedFinding {
  for (const line of readFileSync(FINDING_REGISTRY_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || parsed.id !== id) {
      continue;
    }
    if (
      !('deadline' in parsed) ||
      (typeof parsed.deadline !== 'string' && parsed.deadline !== null) ||
      !('owner_agent' in parsed) ||
      typeof parsed.owner_agent !== 'string' ||
      !('state' in parsed) ||
      typeof parsed.state !== 'string'
    ) {
      throw new Error(`Finding ${id} has an invalid registry shape`);
    }
    return {
      deadline: parsed.deadline,
      id,
      ownerAgent: parsed.owner_agent,
      state: parsed.state,
    };
  }
  throw new Error(`Finding ${id} is absent from the canonical finding registry`);
}

function assertBaselineFindingIsActive(): void {
  const finding = readTrackedFinding(ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.findingId);
  if (finding.state !== 'OPEN' && finding.state !== 'IN-PROGRESS') {
    throw new Error(
      `Finding ${finding.id} is ${finding.state}; diagnostic debt requires an active finding`,
    );
  }
  if (finding.deadline !== ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.expiresOn) {
    throw new Error(`Finding ${finding.id} deadline does not match the diagnostic debt expiry`);
  }
  if (finding.ownerAgent !== ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.owner) {
    throw new Error(`Finding ${finding.id} owner does not match the diagnostic debt owner`);
  }
}

function assertBaselineMainIsAncestor(): void {
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.basedOnMainSha, 'HEAD'],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
  } catch {
    throw new Error(
      `Baseline main SHA ${ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.basedOnMainSha} is not an ancestor of HEAD`,
    );
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeStdout(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function main(): void {
  const mode = commandMode(process.argv.slice(2));
  const compilation = compileAdminHttpContractsV2(REPO_ROOT);

  if (mode === '--print-baseline') {
    const baseline = createAdminHttpContractDebtBaselineV1(compilation, {
      basedOnMainSha: ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.basedOnMainSha,
      expiresOn: ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.expiresOn,
      findingId: ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.findingId,
      owner: ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.owner,
    });
    writeStdout(canonicalAdminHttpContractDebtBaselineTypeScriptV1(baseline));
    return;
  }

  assertBaselineFindingIsActive();
  assertBaselineMainIsAncestor();
  const artifact = canonicalAdminHttpContractArtifactJsonV2(
    compilation,
    ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1,
    todayUtc(),
  );

  if (mode === '--report') {
    writeStdout(artifact);
    return;
  }
  if (mode === '--write') {
    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, artifact);
    writeStdout(`Wrote ${ARTIFACT_PATH.slice(REPO_ROOT.length + 1)}`);
    return;
  }
  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(`Admin HTTP contract artifact is missing: ${ARTIFACT_PATH}`);
  }
  const committedArtifact = readFileSync(ARTIFACT_PATH, 'utf8');
  if (committedArtifact !== artifact) {
    throw new Error('Admin HTTP contract artifact drifted; run the governed write command');
  }
  writeStdout(
    `Admin HTTP contract gate: ${compilation.coverage.qualifiedOperationCount}/${compilation.coverage.discoveredOperationCount} qualified, ${compilation.coverage.diagnosticCount} diagnostics`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
