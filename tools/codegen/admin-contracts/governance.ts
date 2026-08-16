import { createHash } from 'node:crypto';

import type {
  AdminHttpContractCompilationV2,
  AdminHttpContractCoverageV2,
  AdminHttpContractDiagnosticCodeV2,
  AdminHttpContractDiagnosticV2,
  AdminHttpContractManifestV2,
} from './compiler';

export const ADMIN_HTTP_CONTRACT_DEBT_BASELINE_SCHEMA_VERSION = 1 as const;
export const ADMIN_HTTP_CONTRACT_ARTIFACT_SCHEMA_VERSION = 2 as const;

export interface AdminHttpContractDebtBaselineV1 {
  readonly authority: 'AdminHttpContractDebtBaselineV1';
  readonly basedOnMainSha: string;
  readonly contentSha256: string;
  readonly controllerSourceSha256: string;
  readonly coverage: AdminHttpContractCoverageV2;
  readonly diagnostics: readonly AdminHttpContractDiagnosticV2[];
  readonly expiresOn: string;
  readonly findingId: string;
  readonly owner: string;
  readonly qualifiedManifestSha256: string;
  readonly schemaVersion: typeof ADMIN_HTTP_CONTRACT_DEBT_BASELINE_SCHEMA_VERSION;
}

export interface AdminHttpContractDiagnosticSummaryV2 {
  readonly code: AdminHttpContractDiagnosticCodeV2;
  readonly count: number;
}

interface AdminHttpContractArtifactBaseV2 {
  readonly authority: 'AdminHttpContractCompilationArtifactV2';
  readonly controllerSourceSha256: string;
  readonly coverage: AdminHttpContractCoverageV2;
  readonly schemaVersion: typeof ADMIN_HTTP_CONTRACT_ARTIFACT_SCHEMA_VERSION;
}

export interface BlockedAdminHttpContractArtifactV2 extends AdminHttpContractArtifactBaseV2 {
  readonly contract: null;
  readonly diagnosticDebt: {
    readonly baselineContentSha256: string;
    readonly basedOnMainSha: string;
    readonly diagnostics: readonly AdminHttpContractDiagnosticSummaryV2[];
    readonly expiresOn: string;
    readonly findingId: string;
    readonly owner: string;
    readonly qualifiedManifestSha256: string;
  };
  readonly status: 'BLOCKED';
}

export interface QualifiedAdminHttpContractArtifactV2 extends AdminHttpContractArtifactBaseV2 {
  readonly contract: AdminHttpContractManifestV2;
  readonly diagnosticDebt: null;
  readonly status: 'QUALIFIED';
}

export type AdminHttpContractArtifactV2 =
  | BlockedAdminHttpContractArtifactV2
  | QualifiedAdminHttpContractArtifactV2;

export interface AdminHttpContractDebtPolicyV1 {
  readonly basedOnMainSha: string;
  readonly expiresOn: string;
  readonly findingId: string;
  readonly owner: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPrettyJson(value: unknown): string {
  const compact = JSON.stringify(value);
  if (compact === undefined) throw new Error('Admin HTTP contract value is not JSON serializable');
  let indentation = 0;
  let inString = false;
  let escaped = false;
  let output = '';
  const indent = (): string => '  '.repeat(indentation);

  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index];
    if (character === undefined) throw new Error('Admin HTTP contract JSON traversal failed');
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '{' || character === '[') {
      output += character;
      const next = compact[index + 1];
      if ((character === '{' && next !== '}') || (character === '[' && next !== ']')) {
        indentation += 1;
        output += `\n${indent()}`;
      }
      continue;
    }
    if (character === '}' || character === ']') {
      const previous = compact[index - 1];
      if ((character === '}' && previous !== '{') || (character === ']' && previous !== '[')) {
        indentation -= 1;
        output += `\n${indent()}`;
      }
      output += character;
      continue;
    }
    if (character === ',') {
      output += `,\n${indent()}`;
      continue;
    }
    output += character === ':' ? ': ' : character;
  }
  return output;
}

function isCanonicalSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isCanonicalGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function canonicalAdminHttpContractDiagnosticsJsonV2(
  diagnostics: readonly AdminHttpContractDiagnosticV2[],
): string {
  return JSON.stringify(
    diagnostics.map(({ code, file, line, operationId }) => ({ code, file, line, operationId })),
  );
}

function canonicalDebtContentJsonV1(input: {
  readonly controllerSourceSha256: string;
  readonly coverage: AdminHttpContractCoverageV2;
  readonly diagnostics: readonly AdminHttpContractDiagnosticV2[];
  readonly qualifiedManifestSha256: string;
}): string {
  return JSON.stringify({
    controllerSourceSha256: input.controllerSourceSha256,
    coverage: {
      diagnosticCount: input.coverage.diagnosticCount,
      discoveredOperationCount: input.coverage.discoveredOperationCount,
      qualifiedOperationCount: input.coverage.qualifiedOperationCount,
      unqualifiedOperationCount: input.coverage.unqualifiedOperationCount,
    },
    diagnostics: input.diagnostics.map(({ code, file, line, operationId }) => ({
      code,
      file,
      line,
      operationId,
    })),
    qualifiedManifestSha256: input.qualifiedManifestSha256,
  });
}

export function adminHttpContractDebtContentSha256V1(input: {
  readonly controllerSourceSha256: string;
  readonly coverage: AdminHttpContractCoverageV2;
  readonly diagnostics: readonly AdminHttpContractDiagnosticV2[];
  readonly qualifiedManifestSha256: string;
}): string {
  return sha256(canonicalDebtContentJsonV1(input));
}

export function adminHttpQualifiedManifestSha256V2(manifest: AdminHttpContractManifestV2): string {
  return sha256(JSON.stringify(manifest));
}

function validateCoverageV2(coverage: AdminHttpContractCoverageV2): void {
  const counts = [
    coverage.diagnosticCount,
    coverage.discoveredOperationCount,
    coverage.qualifiedOperationCount,
    coverage.unqualifiedOperationCount,
  ];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('Admin HTTP contract coverage contains an invalid count');
  }
  if (
    coverage.qualifiedOperationCount + coverage.unqualifiedOperationCount !==
    coverage.discoveredOperationCount
  ) {
    throw new Error('Admin HTTP contract coverage does not partition discovered operations');
  }
  if (coverage.diagnosticCount === 0 && coverage.unqualifiedOperationCount !== 0) {
    throw new Error(
      'Admin HTTP contract coverage hides unqualified operations without diagnostics',
    );
  }
}

function validatePolicyV1(policy: AdminHttpContractDebtPolicyV1): void {
  if (!isCanonicalGitSha(policy.basedOnMainSha)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid main SHA');
  }
  if (!isCalendarDate(policy.expiresOn)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid expiry date');
  }
  if (!/^[A-Z][A-Z0-9-]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/.test(policy.findingId)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid finding ID');
  }
  if (policy.owner.trim() !== policy.owner || policy.owner.length === 0) {
    throw new Error('Admin HTTP contract debt baseline has an invalid owner');
  }
}

export function createAdminHttpContractDebtBaselineV1(
  compilation: AdminHttpContractCompilationV2,
  policy: AdminHttpContractDebtPolicyV1,
): AdminHttpContractDebtBaselineV1 {
  validateCoverageV2(compilation.coverage);
  validatePolicyV1(policy);
  if (compilation.diagnostics.length === 0) {
    throw new Error('A diagnostic-free admin HTTP contract must not create a debt baseline');
  }
  const qualifiedManifestSha256 = adminHttpQualifiedManifestSha256V2(compilation.manifest);
  const baselineContent = {
    controllerSourceSha256: compilation.controllerSourceSha256,
    coverage: compilation.coverage,
    diagnostics: compilation.diagnostics,
    qualifiedManifestSha256,
  };
  return {
    authority: 'AdminHttpContractDebtBaselineV1',
    basedOnMainSha: policy.basedOnMainSha,
    contentSha256: adminHttpContractDebtContentSha256V1(baselineContent),
    controllerSourceSha256: compilation.controllerSourceSha256,
    coverage: compilation.coverage,
    diagnostics: compilation.diagnostics,
    expiresOn: policy.expiresOn,
    findingId: policy.findingId,
    owner: policy.owner,
    qualifiedManifestSha256,
    schemaVersion: ADMIN_HTTP_CONTRACT_DEBT_BASELINE_SCHEMA_VERSION,
  };
}

export function canonicalAdminHttpContractDebtBaselineTypeScriptV1(
  baseline: AdminHttpContractDebtBaselineV1,
): string {
  return [
    "import type { AdminHttpContractDebtBaselineV1 } from './governance';",
    '',
    `export const ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1 = ${canonicalPrettyJson(baseline)} satisfies AdminHttpContractDebtBaselineV1;`,
    '',
  ].join('\n');
}

export function assertAdminHttpContractDebtBaselineV1(
  compilation: AdminHttpContractCompilationV2,
  baseline: AdminHttpContractDebtBaselineV1 | null,
  today: string,
): void {
  validateCoverageV2(compilation.coverage);
  if (!isCalendarDate(today)) throw new Error('Admin HTTP contract gate received an invalid date');
  if (compilation.diagnostics.length === 0) {
    if (baseline) {
      throw new Error('Diagnostic debt is zero; remove the admin HTTP contract debt baseline');
    }
    return;
  }
  if (!baseline)
    throw new Error('Admin HTTP contract diagnostics require a governed debt baseline');
  validatePolicyV1(baseline);
  if (baseline.authority !== 'AdminHttpContractDebtBaselineV1') {
    throw new Error('Admin HTTP contract debt baseline has an invalid authority');
  }
  if (baseline.schemaVersion !== ADMIN_HTTP_CONTRACT_DEBT_BASELINE_SCHEMA_VERSION) {
    throw new Error('Admin HTTP contract debt baseline has an unsupported schema version');
  }
  if (!isCanonicalSha256(baseline.controllerSourceSha256)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid controller source hash');
  }
  if (!isCanonicalSha256(baseline.contentSha256)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid content hash');
  }
  if (!isCanonicalSha256(baseline.qualifiedManifestSha256)) {
    throw new Error('Admin HTTP contract debt baseline has an invalid qualified manifest hash');
  }
  if (baseline.expiresOn < today) {
    throw new Error(
      `Admin HTTP contract debt baseline expired on ${baseline.expiresOn} (${baseline.findingId})`,
    );
  }

  const baselineContentSha256 = adminHttpContractDebtContentSha256V1(baseline);
  if (baselineContentSha256 !== baseline.contentSha256) {
    throw new Error('Admin HTTP contract debt baseline content hash is internally inconsistent');
  }
  const currentContentSha256 = adminHttpContractDebtContentSha256V1({
    controllerSourceSha256: compilation.controllerSourceSha256,
    coverage: compilation.coverage,
    diagnostics: compilation.diagnostics,
    qualifiedManifestSha256: adminHttpQualifiedManifestSha256V2(compilation.manifest),
  });
  if (currentContentSha256 !== baseline.contentSha256) {
    throw new Error(
      `Admin HTTP contract diagnostic drift: expected ${baseline.contentSha256}, received ${currentContentSha256}`,
    );
  }
}

function diagnosticSummaryV2(
  diagnostics: readonly AdminHttpContractDiagnosticV2[],
): readonly AdminHttpContractDiagnosticSummaryV2[] {
  const counts = new Map<AdminHttpContractDiagnosticCodeV2, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

export function buildAdminHttpContractArtifactV2(
  compilation: AdminHttpContractCompilationV2,
  baseline: AdminHttpContractDebtBaselineV1 | null,
  today: string,
): AdminHttpContractArtifactV2 {
  assertAdminHttpContractDebtBaselineV1(compilation, baseline, today);
  if (compilation.diagnostics.length === 0) {
    return {
      authority: 'AdminHttpContractCompilationArtifactV2',
      contract: compilation.manifest,
      controllerSourceSha256: compilation.controllerSourceSha256,
      coverage: compilation.coverage,
      diagnosticDebt: null,
      schemaVersion: ADMIN_HTTP_CONTRACT_ARTIFACT_SCHEMA_VERSION,
      status: 'QUALIFIED',
    };
  }
  if (!baseline) {
    throw new Error('Admin HTTP contract diagnostics require a governed debt baseline');
  }
  return {
    authority: 'AdminHttpContractCompilationArtifactV2',
    contract: null,
    controllerSourceSha256: compilation.controllerSourceSha256,
    coverage: compilation.coverage,
    diagnosticDebt: {
      baselineContentSha256: baseline.contentSha256,
      basedOnMainSha: baseline.basedOnMainSha,
      diagnostics: diagnosticSummaryV2(compilation.diagnostics),
      expiresOn: baseline.expiresOn,
      findingId: baseline.findingId,
      owner: baseline.owner,
      qualifiedManifestSha256: baseline.qualifiedManifestSha256,
    },
    schemaVersion: ADMIN_HTTP_CONTRACT_ARTIFACT_SCHEMA_VERSION,
    status: 'BLOCKED',
  };
}

export function canonicalAdminHttpContractArtifactJsonV2(
  compilation: AdminHttpContractCompilationV2,
  baseline: AdminHttpContractDebtBaselineV1 | null,
  today: string,
): string {
  return `${canonicalPrettyJson(buildAdminHttpContractArtifactV2(compilation, baseline, today))}\n`;
}
