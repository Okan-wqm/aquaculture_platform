#!/usr/bin/env ts-node
/**
 * finding-registry — CLI for the Phase 6 append-only registry at
 * docs/reviews/_registry/findings.jsonl.
 *
 * Phase 2 deliverable per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.
 *
 * Subcommands:
 *   verify               — re-compute the hash chain, assert every
 *                           prev_hash + content_hash is intact. Matches
 *                           tests/invariants/finding-registry-integrity
 *                           .spec.ts algorithm exactly — a CI gate and
 *                           a local smoke check in one CLI.
 *   add <domain> <json-path>
 *                         — allocate a domain-wide monotonic id and append
 *                           one finding from a JSON stub file. The stub
 *                           supplies severity / state /
 *                           title / layer / owner_agent / notes; the
 *                           CLI fills id / prev_hash / content_hash and
 *                           appends a newline-terminated entry.
 *   close <id> <sha>     — mutate a finding to state=RESOLVED, set
 *                           closed_at, and APPEND the short SHA to
 *                           closing_commits[]. The SHA must be
 *                           reachable from origin/main and its commit
 *                           message must carry a matching Closes:
 *                           trailer. Because the registry is
 *                           hash-chained, every entry FROM the mutated
 *                           position onward must have its chain
 *                           re-stitched (prev_hash preserved,
 *                           content_hash recomputed).
 *   export <format>      — dump alternate representations (json-array,
 *                           csv) for dashboards / reporting.
 *
 * Design notes:
 *   * Registry mutation preserves append-only SEMANTICS for OPEN/
 *     IN-PROGRESS additions (new entry at tail). `close` is the one
 *     mutation that legitimately modifies a past entry — the state
 *     transition contract in CLAUDE.md "Review Finding Traceability"
 *     REQUIRES closing_commits[] population, which cannot be written
 *     before the fix commit SHA exists. An alternative "close-event"
 *     record (state-machine replay) is Phase 12 territory; the CLI
 *     here matches the jsonl shape the invariant test already expects.
 *   * `close` re-seeds only the closed entry + subsequent entries
 *     (prev_hash pointers from later entries still point to the
 *     closed entry's OLD content_hash; they must be updated to the
 *     NEW content_hash). Validated end-to-end by running `verify`
 *     immediately after a `close`.
 *
 * Exit codes:
 *   0 — OK
 *   1 — integrity failure / missing id / chain break
 *   2 — usage error
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// The .js extension on the ajv specifier survives both module systems
// (it is a real file in node_modules); ts-jest interop in the Jest
// invariant test omits it.
import Ajv2020Mod, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  deriveRawFindingIdFloors,
  parseFindingRegistrySchemaContract,
} from './lib/finding-registry-schema-contract';
import {
  AUTOMATION_BASE_REF,
  AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE,
  AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
  AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
  AUTOMATION_PUBLICATION_COMPARE_AND_SWAP,
  AUTOMATION_PUBLICATION_IDEMPOTENCY,
  AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE,
  AUTOMATION_REGISTRY_LOGICAL_BRANCH,
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_REFS,
} from './lib/automation-publication-policy';
// PROC-HIGH-001 structural guard — close ceremony refuses branch-local
// SHAs (see cmdClose). The shared SSOT helper is import-safe for
// node:test specs, which use the same extensionless CJS specifier.
import {
  atomicWriteFileWithRegistryLease,
  atomicWriteRegistryFile,
  claimedSequences,
  listAtomicWriteStagingFiles,
  nextFindingId,
  orphanMarkdownReservedIds,
  recoverAtomicWriteStagingFiles,
  RegistryLockError,
  type RegistryLockLease,
  withRegistryFileLock,
} from './finding-registry-store';
import {
  acquireRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';
import { commitHasFindingCloseTrailer } from './finding-traceability';
import { commitReachableFrom } from './git-reachability';

const Ajv2020 = (Ajv2020Mod as unknown as { default?: typeof Ajv2020Mod }).default ?? Ajv2020Mod;

// __dirname (CommonJS, per tools/gates/tsconfig.json) — this file
// previously derived REPO_ROOT from import.meta.url, which forced the
// whole CLI through ts-node's ESM loader, made relative TS imports
// unresolvable (ERR_MODULE_NOT_FOUND for both extensionless and .js
// specifiers) and tripped TS1343/TS5097 in the changed-files
// type-check. Every other gate in this directory is CJS; the odd one
// out is now aligned (farm-service-enterprise-guardrails.ts precedent).
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_RELATIVE_PATH = join('docs', 'reviews', '_registry', 'findings.jsonl');
const CAPABILITY_MANIFEST_RELATIVE_PATH = join(
  'docs',
  'plans',
  '2026-06-18-enterprise-grade-debt-closure',
  'manifest.json',
);
const ALLOCATOR_RELATIVE_PATH = join('tools', 'gates', 'finding-registry.ts');
const WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH = join(
  '.github',
  'manifests',
  'finding-registry-writer-authority.json',
);
const FINDING_WRITER_PROTOCOL_ID = 'aqua.finding-registry-writer/v5';
const FINDING_WRITER_PUBLISHER = 'GITHUB_GRAPHQL_SIGNED_COMMIT_V1' as const;
const FINDING_WRITER_PUBLISHER_CREDENTIAL =
  'CURRENT_REPOSITORY_GITHUB_APP_INSTALLATION_V1' as const;
const FINDING_WRITER_GOVERNED_PATHS = [
  '.github/CODEOWNERS',
  '.github/actions/mint-automation-app-token/action.yml',
  '.github/manifests/automation-publication-authority.json',
  '.github/workflows/aria-daily-report.yml',
  '.github/workflows/automation-publication-admission.yml',
  '.github/workflows/ci-full.yml',
  '.github/workflows/finding-registry-authority.yml',
  '.github/workflows/finding-state-sweep.yml',
  '.github/workflows/rule-health-report.yml',
  'docs/reviews/_registry/findings.jsonl.schema.json',
  'package.json',
  ALLOCATOR_RELATIVE_PATH,
  'tools/gates/finding-registry-store.ts',
  'tools/gates/finding-registry-publication.ts',
  'tools/gates/github-actions-oidc-authority.ts',
  'tools/gates/lib/automation-publication-policy.ts',
  'tools/gates/lib/finding-registry-schema-contract.ts',
  'tools/gates/lib/github-artifact-archive.ts',
  'tools/scripts/automation/publish-automation-pr.ts',
  'tools/scripts/automation/resolve-github-run-clock.mjs',
  'tools/scripts/automation/tsconfig.json',
] as const;
const REGISTRY_PATH = resolve(REPO_ROOT, REGISTRY_RELATIVE_PATH);
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl.schema.json',
);
const ORPHAN_FINDINGS_MD_PATH = resolve(REPO_ROOT, 'docs', 'reviews', 'orphan-findings.md');
const ZERO_HASH = '0'.repeat(64);
const REGISTRY_STAGING_STALE_MS = 5 * 60_000;

export interface RegistryPaths {
  readonly registryPath: string;
  readonly schemaPath: string;
}

const DEFAULT_REGISTRY_PATHS: RegistryPaths = {
  registryPath: REGISTRY_PATH,
  schemaPath: SCHEMA_PATH,
};

interface FindingIdReservation {
  readonly sequence: number;
  readonly finding_id: string;
  readonly reserved_at: string;
  readonly registry_path: string;
}

interface FindingIdReservationLedger {
  readonly version: 1;
  readonly domains: Record<string, FindingIdReservation>;
}

export interface FindingAllocationAuthority {
  readonly lockPath: string;
  readonly reservationPath: string;
  readonly assertCompatibleWriters: () => void;
  readonly activeRegistryPaths: () => readonly string[];
  readonly reservedDomainFloors: () => Readonly<Record<string, number>>;
}

interface FindingWriterProtocolManifest {
  readonly schema_version: 4;
  readonly protocol_id: typeof FINDING_WRITER_PROTOCOL_ID;
  readonly files: Readonly<Record<string, string>>;
  readonly repository_global_authority: {
    readonly kind: 'GITHUB_ACTIONS_OIDC_V1';
    readonly workflow_refs: typeof AUTOMATION_REGISTRY_WRITER_WORKFLOW_REFS;
    readonly protected_ref: typeof AUTOMATION_BASE_REF;
    readonly logical_branch: typeof AUTOMATION_REGISTRY_LOGICAL_BRANCH;
    readonly branch_strategy: typeof AUTOMATION_PUBLICATION_BRANCH_STRATEGY;
    readonly physical_branch_template: typeof AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE;
    readonly branch_lifecycle: typeof AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE;
    readonly branch_ref_permissions: {
      readonly create: true;
      readonly update: false;
      readonly delete: false;
    };
    readonly compare_and_swap: typeof AUTOMATION_PUBLICATION_COMPARE_AND_SWAP;
    readonly publisher: typeof FINDING_WRITER_PUBLISHER;
    readonly publisher_credential: typeof FINDING_WRITER_PUBLISHER_CREDENTIAL;
    readonly idempotency: {
      readonly kind: typeof AUTOMATION_PUBLICATION_IDEMPOTENCY;
      readonly required_trailers: typeof AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER;
    };
  };
  readonly local_fence: {
    readonly kind: 'GIT_COMMON_DIR_FILE_LEASE_V2';
    readonly lock_record_version: 2;
  };
}

function parseFindingWriterProtocolManifest(
  raw: string,
  path: string,
): FindingWriterProtocolManifest {
  const value: unknown = JSON.parse(raw);
  if (!isJsonRecord(value)) {
    throw new Error(`Finding writer protocol manifest is not an object: ${path}`);
  }
  const files = value['files'];
  const repositoryGlobalAuthority = value['repository_global_authority'];
  const localFence = value['local_fence'];
  const idempotency = isJsonRecord(repositoryGlobalAuthority)
    ? repositoryGlobalAuthority['idempotency']
    : undefined;
  const branchRefPermissions = isJsonRecord(repositoryGlobalAuthority)
    ? repositoryGlobalAuthority['branch_ref_permissions']
    : undefined;
  const expectedKeys = [
    '$schema',
    'files',
    'local_fence',
    'protocol_id',
    'repository_global_authority',
    'schema_version',
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys) ||
    value['$schema'] !== 'aqua/finding-registry-writer-authority/v4' ||
    value['schema_version'] !== 4 ||
    value['protocol_id'] !== FINDING_WRITER_PROTOCOL_ID ||
    !isJsonRecord(files) ||
    !isJsonRecord(repositoryGlobalAuthority) ||
    !isJsonRecord(localFence) ||
    !isJsonRecord(idempotency) ||
    !isJsonRecord(branchRefPermissions) ||
    canonicalJson(Object.keys(repositoryGlobalAuthority).sort()) !==
      canonicalJson(
        [
          'branch_lifecycle',
          'branch_ref_permissions',
          'branch_strategy',
          'compare_and_swap',
          'idempotency',
          'kind',
          'logical_branch',
          'physical_branch_template',
          'protected_ref',
          'publisher',
          'publisher_credential',
          'workflow_refs',
        ].sort(),
      ) ||
    canonicalJson(Object.keys(idempotency).sort()) !==
      canonicalJson(['kind', 'required_trailers']) ||
    canonicalJson(Object.keys(branchRefPermissions).sort()) !==
      canonicalJson(['create', 'delete', 'update']) ||
    canonicalJson(Object.keys(localFence).sort()) !==
      canonicalJson(['kind', 'lock_record_version']) ||
    repositoryGlobalAuthority['kind'] !== 'GITHUB_ACTIONS_OIDC_V1' ||
    canonicalJson(repositoryGlobalAuthority['workflow_refs']) !==
      canonicalJson(AUTOMATION_REGISTRY_WRITER_WORKFLOW_REFS) ||
    repositoryGlobalAuthority['protected_ref'] !== AUTOMATION_BASE_REF ||
    repositoryGlobalAuthority['logical_branch'] !== AUTOMATION_REGISTRY_LOGICAL_BRANCH ||
    repositoryGlobalAuthority['branch_strategy'] !== AUTOMATION_PUBLICATION_BRANCH_STRATEGY ||
    repositoryGlobalAuthority['physical_branch_template'] !==
      AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE ||
    repositoryGlobalAuthority['branch_lifecycle'] !== AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE ||
    branchRefPermissions['create'] !== true ||
    branchRefPermissions['update'] !== false ||
    branchRefPermissions['delete'] !== false ||
    repositoryGlobalAuthority['compare_and_swap'] !== AUTOMATION_PUBLICATION_COMPARE_AND_SWAP ||
    repositoryGlobalAuthority['publisher'] !== FINDING_WRITER_PUBLISHER ||
    repositoryGlobalAuthority['publisher_credential'] !== FINDING_WRITER_PUBLISHER_CREDENTIAL ||
    idempotency['kind'] !== AUTOMATION_PUBLICATION_IDEMPOTENCY ||
    canonicalJson(idempotency['required_trailers']) !==
      canonicalJson(AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER) ||
    localFence['kind'] !== 'GIT_COMMON_DIR_FILE_LEASE_V2' ||
    localFence['lock_record_version'] !== 2
  ) {
    throw new Error(`Finding writer protocol manifest has an incompatible contract: ${path}`);
  }
  if (
    canonicalJson(Object.keys(files).sort()) !==
      canonicalJson([...FINDING_WRITER_GOVERNED_PATHS].sort()) ||
    FINDING_WRITER_GOVERNED_PATHS.some(
      (governedPath) =>
        typeof files[governedPath] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(files[governedPath] as string),
    )
  ) {
    throw new Error(`Finding writer protocol file digest set is invalid: ${path}`);
  }
  const normalizedFiles: Record<string, string> = {};
  for (const governedPath of FINDING_WRITER_GOVERNED_PATHS) {
    const digest = files[governedPath];
    if (typeof digest !== 'string') {
      throw new Error(`Finding writer protocol digest is invalid for ${governedPath}: ${path}`);
    }
    normalizedFiles[governedPath] = digest;
  }
  return {
    schema_version: 4,
    protocol_id: FINDING_WRITER_PROTOCOL_ID,
    files: normalizedFiles,
    repository_global_authority: {
      kind: 'GITHUB_ACTIONS_OIDC_V1',
      workflow_refs: AUTOMATION_REGISTRY_WRITER_WORKFLOW_REFS,
      protected_ref: AUTOMATION_BASE_REF,
      logical_branch: AUTOMATION_REGISTRY_LOGICAL_BRANCH,
      branch_strategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
      physical_branch_template: AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE,
      branch_lifecycle: AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE,
      branch_ref_permissions: {
        create: true,
        update: false,
        delete: false,
      },
      compare_and_swap: AUTOMATION_PUBLICATION_COMPARE_AND_SWAP,
      publisher: FINDING_WRITER_PUBLISHER,
      publisher_credential: FINDING_WRITER_PUBLISHER_CREDENTIAL,
      idempotency: {
        kind: AUTOMATION_PUBLICATION_IDEMPOTENCY,
        required_trailers: AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
      },
    },
    local_fence: {
      kind: 'GIT_COMMON_DIR_FILE_LEASE_V2',
      lock_record_version: 2,
    },
  };
}

function assertCommittedRegularFile(worktreePath: string, relativePath: string): string {
  const absolutePath = resolve(worktreePath, relativePath);
  if (
    !existsSync(absolutePath) ||
    !lstatSync(absolutePath).isFile() ||
    lstatSync(absolutePath).isSymbolicLink()
  ) {
    throw new Error(`Finding writer governed file is missing or non-regular: ${absolutePath}`);
  }
  let committed: string;
  try {
    committed = gitOutput(worktreePath, ['show', `HEAD:${relativePath.replaceAll('\\', '/')}`]);
  } catch {
    throw new Error(`Finding writer governed file is not committed at HEAD: ${absolutePath}`);
  }
  const effective = readFileSync(absolutePath, 'utf8');
  if (effective.trimEnd() !== committed.trimEnd()) {
    throw new Error(`Finding writer governed file differs from committed HEAD: ${absolutePath}`);
  }
  return effective;
}

export function assertActiveWorktreeFindingWritersFenced(worktreePaths: readonly string[]): void {
  const legacyWriters: string[] = [];
  for (const worktreePath of [...new Set(worktreePaths)].sort()) {
    const allocatorPath = resolve(worktreePath, ALLOCATOR_RELATIVE_PATH);
    if (!existsSync(allocatorPath)) continue;
    try {
      const protocolPath = resolve(worktreePath, WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH);
      const protocolRaw = assertCommittedRegularFile(
        worktreePath,
        WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH,
      );
      const protocol = parseFindingWriterProtocolManifest(protocolRaw, protocolPath);
      for (const [relativePath, expectedSha256] of Object.entries(protocol.files)) {
        const content = assertCommittedRegularFile(worktreePath, relativePath);
        if (sha256hex(content) !== expectedSha256) {
          throw new Error(
            `Finding writer governed file digest differs from ${protocolPath}: ${resolve(
              worktreePath,
              relativePath,
            )}`,
          );
        }
      }
    } catch {
      legacyWriters.push(allocatorPath);
    }
  }
  if (legacyWriters.length > 0) {
    throw new Error(
      `Active worktrees expose uncommitted or protocol-incompatible finding writers: ${legacyWriters.join(
        ',',
      )}; retire them or advance them to the committed ${FINDING_WRITER_PROTOCOL_ID} authority before publication or canonical mutation`,
    );
  }
}

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function gitOutput(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
  }).trim();
}

export function resolveGitFindingAllocationAuthority(
  repoRoot: string,
  registryRelativePath = REGISTRY_RELATIVE_PATH,
): FindingAllocationAuthority {
  const commonDir = gitOutput(repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDir) {
    throw new Error(`Git common-dir resolution returned an empty path for ${repoRoot}`);
  }
  const activeWorktreePaths = (): string[] => {
    const output = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      env: HERMETIC_GIT_ENV,
    });
    return [
      ...new Set(
        output
          .split('\0')
          .filter((field) => field.startsWith('worktree '))
          .map((field) => resolve(field.slice('worktree '.length))),
      ),
    ].sort();
  };
  const activeRegistryPaths = (): string[] => {
    const worktreePaths = activeWorktreePaths();
    const registryPaths = worktreePaths.map((worktreePath) =>
      resolve(worktreePath, registryRelativePath),
    );
    for (const registryPath of registryPaths) {
      if (!existsSync(registryPath)) {
        throw new Error(`Active worktree finding registry is missing: ${registryPath}`);
      }
    }
    return registryPaths;
  };

  return {
    lockPath: join(commonDir, 'finding-registry-v1.lock'),
    reservationPath: join(commonDir, 'finding-id-reservations-v1.json'),
    assertCompatibleWriters: () => assertActiveWorktreeFindingWritersFenced(activeWorktreePaths()),
    activeRegistryPaths,
    reservedDomainFloors: () =>
      reservedDomainFloorsFromManifest(resolve(repoRoot, CAPABILITY_MANIFEST_RELATIVE_PATH)),
  };
}

/**
 * Ajv-compiled validator for the finding schema. Compiled once at
 * first-use; exits 1 if the stub fails validation. This is the
 * add-time half of the Tier-1 defence (companion to the
 * finding-registry-integrity Jest invariant that validates the whole
 * ledger in CI). Before this existed, historical seed scripts wrote
 * entries with free-text evidence and over-long titles that violated
 * the schema; those entries survived until the invariant ran post-hoc.
 * Now every append is schema-checked before the hash chain advances.
 */
const cachedValidators = new Map<string, ValidateFunction>();
function loadStubValidator(schemaPath = SCHEMA_PATH): ValidateFunction {
  const cached = cachedValidators.get(schemaPath);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  cachedValidators.set(schemaPath, validator);
  return validator;
}

/**
 * Finding schema mirror — narrow to what the CLI touches. The canonical
 * schema lives in docs/reviews/_registry/findings.jsonl.schema.json; we
 * keep these interfaces structural (no runtime validation here — the
 * integrity invariant test enforces schema conformance separately).
 */
interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer?: number;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes?: string;
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

/**
 * Key-sorted JSON without whitespace. Canonical form for hashing;
 * identical to the algorithm in
 * tests/invariants/finding-registry-integrity.spec.ts.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const ADD_STUB_FIELDS = new Set([
  'severity',
  'title',
  'layer',
  'evidence',
  'rule_violated',
  'owner_agent',
  'raised_in_cycle',
  'review_file',
  'deadline',
  'owner_user',
  'override_of',
  'notes',
  'narrative',
]);

function canonicalEffectiveAt(): string {
  const effectiveAt = process.env['FINDING_EFFECTIVE_AT'];
  if (
    !effectiveAt ||
    !Number.isFinite(Date.parse(effectiveAt)) ||
    new Date(Date.parse(effectiveAt)).toISOString() !== effectiveAt
  ) {
    throw new Error('FINDING_EFFECTIVE_AT must be a canonical UTC ISO timestamp');
  }
  return effectiveAt;
}

function normalizedAddStub(stubPath: string): Partial<Finding> {
  const value: unknown = JSON.parse(readFileSync(stubPath, 'utf8'));
  if (!isJsonRecord(value)) {
    throw new Error(`Finding stub must be a JSON object: ${stubPath}`);
  }
  const unsupportedFields = Object.keys(value).filter((field) => !ADD_STUB_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Finding stub contains authority-owned or unsupported fields: ${unsupportedFields
        .sort()
        .join(', ')}`,
    );
  }
  return value as Partial<Finding>;
}

function sweepStaleAfterDays(args: readonly string[]): number {
  const staleArg = args.find((argument) => argument.startsWith('--stale-after='));
  if (!staleArg) return 30;
  const raw = staleArg.slice('--stale-after='.length);
  if (!/^\d{1,3}$/.test(raw)) {
    throw new Error(`--stale-after must be an integer between 1 and 365: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > 365) {
    throw new Error(`--stale-after must be between 1 and 365: ${raw}`);
  }
  return parsed;
}

function mutationInputSha256(
  operation: RegistryMutationOperation,
  args: readonly string[],
): string {
  const effectiveAt = canonicalEffectiveAt();
  if (operation === 'add') {
    const domain = args[0];
    const stubPath = args[1];
    if (!domain || !/^[A-Z][A-Z0-9]*$/.test(domain) || !stubPath) {
      throw new Error('add request digest requires an uppercase domain and stub path');
    }
    return sha256hex(
      canonicalJson({
        effective_at: effectiveAt,
        finding: normalizedAddStub(resolve(stubPath)),
        operation,
        domain,
      }),
    );
  }
  if (operation === 'close') {
    const findingId = args[0];
    const closingSha = args[1];
    if (
      !findingId ||
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[0-9]{3}$/.test(findingId) ||
      !closingSha ||
      !/^[0-9a-f]{40}$/.test(closingSha)
    ) {
      throw new Error('close request digest requires a canonical finding id and full main SHA');
    }
    return sha256hex(
      canonicalJson({
        closing_sha: closingSha,
        effective_at: effectiveAt,
        finding_id: findingId,
        operation,
      }),
    );
  }
  return sha256hex(
    canonicalJson({
      effective_at: effectiveAt,
      operation,
      stale_after_days: sweepStaleAfterDays(args),
    }),
  );
}

interface CommittedMutationCommand {
  readonly commitSha: string;
  readonly operation: RegistryMutationOperation;
  readonly inputSha256: string;
}

function committedMutationCommand(commandId: string): CommittedMutationCommand | null {
  const matchingCommits = gitOutput(REPO_ROOT, [
    'log',
    'HEAD',
    '--fixed-strings',
    '--grep',
    `Automation-Command-ID: ${commandId}`,
    '--format=%H',
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  if (matchingCommits.length === 0) return null;
  if (matchingCommits.length !== 1) {
    throw new Error(
      `Automation command ${commandId} appears in ${matchingCommits.length} protected-main commits`,
    );
  }
  const commitSha = matchingCommits[0] as string;
  const message = gitOutput(REPO_ROOT, ['show', '-s', '--format=%B', commitSha]);
  const trailerValue = (name: string): string => {
    const matches = message
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${name}: `))
      .map((line) => line.slice(name.length + 2));
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(`Automation command commit ${commitSha} has an invalid ${name} trailer`);
    }
    return matches[0];
  };
  const operation = trailerValue('Automation-Operation');
  if (operation !== 'add' && operation !== 'close' && operation !== 'sweep') {
    throw new Error(`Automation command commit ${commitSha} has an invalid operation`);
  }
  const inputSha256 = trailerValue('Automation-Input-SHA256');
  if (!/^[0-9a-f]{64}$/.test(inputSha256)) {
    throw new Error(`Automation command commit ${commitSha} has an invalid input digest`);
  }
  return { commitSha, operation, inputSha256 };
}

function loadRegistry(registryPath = REGISTRY_PATH): Finding[] {
  if (!existsSync(registryPath)) return [];
  const raw = readFileSync(registryPath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);
}

function loadReservationLedger(reservationPath: string): FindingIdReservationLedger {
  if (!existsSync(reservationPath)) return { version: 1, domains: {} };
  const value = JSON.parse(readFileSync(reservationPath, 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Finding ID reservation ledger is not an object: ${reservationPath}`);
  }
  const candidate = value as Partial<FindingIdReservationLedger>;
  if (
    candidate.version !== 1 ||
    candidate.domains === null ||
    typeof candidate.domains !== 'object' ||
    Array.isArray(candidate.domains)
  ) {
    throw new Error(`Finding ID reservation ledger has an invalid envelope: ${reservationPath}`);
  }

  for (const [domain, reservation] of Object.entries(candidate.domains)) {
    if (
      !/^[A-Z][A-Z0-9]*$/.test(domain) ||
      reservation === null ||
      typeof reservation !== 'object' ||
      !Number.isSafeInteger(reservation.sequence) ||
      reservation.sequence < 1 ||
      reservation.sequence > 999 ||
      typeof reservation.finding_id !== 'string' ||
      !new RegExp(`^${domain}-[A-Z0-9]+-${String(reservation.sequence).padStart(3, '0')}$`).test(
        reservation.finding_id,
      ) ||
      typeof reservation.reserved_at !== 'string' ||
      !Number.isFinite(Date.parse(reservation.reserved_at)) ||
      typeof reservation.registry_path !== 'string' ||
      reservation.registry_path.length === 0
    ) {
      throw new Error(
        `Finding ID reservation ledger has an invalid ${domain} record: ${reservationPath}`,
      );
    }
  }
  return candidate as FindingIdReservationLedger;
}

function registryMutationStagingLocations(
  authority: FindingAllocationAuthority,
): { parentPath: string; basename: string }[] {
  const registryPaths = authority.activeRegistryPaths();
  for (const registryPath of registryPaths) {
    if (!existsSync(registryPath)) {
      throw new Error(`Active worktree finding registry is missing: ${registryPath}`);
    }
  }
  return [
    ...registryPaths.map((registryPath) => ({
      parentPath: dirname(registryPath),
      basename: basename(registryPath),
    })),
    {
      parentPath: dirname(authority.reservationPath),
      basename: basename(authority.reservationPath),
    },
  ];
}

export function registryMutationStagingFiles(authority: FindingAllocationAuthority): string[] {
  return registryMutationStagingLocations(authority)
    .flatMap((location) =>
      listAtomicWriteStagingFiles(
        location.parentPath,
        (candidate) => candidate === location.basename,
      ).map((name) => join(location.parentPath, name)),
    )
    .sort();
}

export function recoverRegistryMutationStaging(
  authority: FindingAllocationAuthority,
  lease: RegistryLockLease,
): void {
  for (const location of registryMutationStagingLocations(authority)) {
    recoverAtomicWriteStagingFiles(
      location.parentPath,
      (candidate) => candidate === location.basename,
      lease,
      REGISTRY_STAGING_STALE_MS,
    );
  }
}

function idsFromActiveRegistries(authority: FindingAllocationAuthority): string[] {
  const ids: string[] = [];
  for (const registryPath of authority.activeRegistryPaths()) {
    if (!existsSync(registryPath)) {
      throw new Error(`Active worktree finding registry is missing: ${registryPath}`);
    }
    ids.push(...loadRegistry(registryPath).map((entry) => entry.id));
  }
  return ids;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function reservedDomainFloorsFromManifest(
  manifestPath: string,
): Readonly<Record<string, number>> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Active worktree capability manifest is missing: ${manifestPath}`);
  }
  const manifestValue: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isJsonRecord(manifestValue)) {
    throw new Error(`Capability manifest is not an object: ${manifestPath}`);
  }
  const reconciliation = manifestValue['capability_reconciliation'];
  if (!isJsonRecord(reconciliation)) {
    throw new Error(`Capability reconciliation is absent or invalid: ${manifestPath}`);
  }
  const allocationPolicy = reconciliation['finding_allocation_policy'];
  if (!isJsonRecord(allocationPolicy)) {
    throw new Error(`Finding allocation policy is absent or invalid: ${manifestPath}`);
  }
  if (allocationPolicy['allocator'] !== 'tools/gates/finding-registry.ts') {
    throw new Error(`Capability manifest names a different finding allocator: ${manifestPath}`);
  }
  const candidateFloors = allocationPolicy['reserved_domain_floors'];
  if (!isJsonRecord(candidateFloors)) {
    throw new Error(`Reserved domain floors are absent or invalid: ${manifestPath}`);
  }
  const findingInventory = reconciliation['finding_inventory'];
  if (!isJsonRecord(findingInventory) || findingInventory['schema_version'] !== 3) {
    throw new Error(`Finding inventory v3 is absent or invalid: ${manifestPath}`);
  }
  const artifactPath = findingInventory['artifact_path'];
  const artifactSha256 = findingInventory['artifact_sha256'];
  const occurrenceCount = findingInventory['occurrence_count'];
  if (typeof artifactPath !== 'string' || typeof artifactSha256 !== 'string') {
    throw new Error(`Finding inventory artifact authority is invalid: ${manifestPath}`);
  }
  const artifactMatch =
    /^docs\/plans\/2026-06-18-enterprise-grade-debt-closure\/source-findings\.(?<sha256>[0-9a-f]{64})\.jsonl$/.exec(
      artifactPath,
    );
  if (
    !artifactMatch?.groups?.sha256 ||
    artifactSha256 !== artifactMatch.groups.sha256 ||
    !Number.isSafeInteger(occurrenceCount) ||
    typeof occurrenceCount !== 'number' ||
    occurrenceCount < 0
  ) {
    throw new Error(`Finding inventory artifact authority is invalid: ${manifestPath}`);
  }
  const planDirectory = dirname(manifestPath);
  const artifactAbsolutePath = resolve(
    planDirectory,
    artifactPath.slice(artifactPath.lastIndexOf('/') + 1),
  );
  if (!existsSync(artifactAbsolutePath)) {
    throw new Error(`Finding inventory artifact is missing: ${artifactAbsolutePath}`);
  }
  const artifactRaw = readFileSync(artifactAbsolutePath, 'utf8');
  if (sha256hex(artifactRaw) !== artifactSha256) {
    throw new Error(
      `Finding inventory artifact SHA-256 differs from its authority: ${manifestPath}`,
    );
  }
  const artifactRows = artifactRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index): Record<string, unknown> => {
      const value: unknown = JSON.parse(line);
      if (!isJsonRecord(value)) {
        throw new Error(
          `Finding inventory artifact row ${index + 1} is not an object: ${artifactAbsolutePath}`,
        );
      }
      return value;
    });
  if (artifactRows.length !== occurrenceCount) {
    throw new Error(
      `Finding inventory artifact row count differs from its authority: ${manifestPath}`,
    );
  }
  const repoRoot = resolve(planDirectory, '..', '..', '..');
  const schemaPath = resolve(
    repoRoot,
    'docs',
    'reviews',
    '_registry',
    'findings.jsonl.schema.json',
  );
  const schemaContract = parseFindingRegistrySchemaContract(
    JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown,
  );
  const artifactRawIds: string[] = [];
  for (const [index, row] of artifactRows.entries()) {
    const rawId = row['raw_id'];
    if (typeof rawId !== 'string') {
      throw new Error(
        `Finding inventory artifact row ${index + 1} has no raw_id: ${artifactAbsolutePath}`,
      );
    }
    artifactRawIds.push(rawId);
  }
  const normalizedDerivedFloors = deriveRawFindingIdFloors(artifactRawIds, schemaContract);
  if (canonicalJson(candidateFloors) !== canonicalJson(normalizedDerivedFloors)) {
    throw new Error(
      `Reserved domain floors differ from the content-addressed finding artifact: ${manifestPath}`,
    );
  }
  for (const [namespace, value] of Object.entries(candidateFloors)) {
    if (
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(namespace) ||
      !Number.isSafeInteger(value) ||
      typeof value !== 'number' ||
      value < 1 ||
      value > 999
    ) {
      throw new Error(
        `Reserved finding namespace floor ${namespace} is invalid in ${manifestPath}`,
      );
    }
  }
  return normalizedDerivedFloors;
}

export function allocationFloorForDomain(
  floors: Readonly<Record<string, number>>,
  domain: string,
): number {
  let floor = 0;
  for (const [namespace, value] of Object.entries(floors)) {
    if (namespace === domain || namespace.startsWith(`${domain}-`)) {
      floor = Math.max(floor, value);
    }
  }
  return floor;
}

function reserveFindingId(
  authority: FindingAllocationAuthority,
  ledger: FindingIdReservationLedger,
  domain: string,
  findingId: string,
  registryPath: string,
  lease: RegistryLockLease,
  reservedAt: string,
): void {
  const sequence = Number.parseInt(findingId.slice(-3), 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new RangeError(`Finding reservation sequence is out of range: ${findingId}`);
  }
  const current = ledger.domains[domain];
  if (current && current.sequence >= sequence) return;
  const nextLedger: FindingIdReservationLedger = {
    version: 1,
    domains: {
      ...ledger.domains,
      [domain]: {
        sequence,
        finding_id: findingId,
        reserved_at: reservedAt,
        registry_path: registryPath,
      },
    },
  };
  atomicWriteFileWithRegistryLease(
    authority.reservationPath,
    `${JSON.stringify(nextLedger)}\n`,
    lease,
  );
}

function writeRegistry(
  entries: readonly Finding[],
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
  registryPath = REGISTRY_PATH,
): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  atomicWriteRegistryFile(registryPath, content, lease, repositoryAuthority, operation);
}

/**
 * Recompute prev_hash + content_hash pointers from `startIndex` to the
 * end of `entries`. Mutation in place. Used by `close` after mutating
 * a past entry; every downstream entry carries a stale prev_hash until
 * rechained here.
 */
function rechain(entries: Finding[], startIndex: number): void {
  let prev = startIndex === 0 ? ZERO_HASH : (entries[startIndex - 1]?.content_hash ?? ZERO_HASH);
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    entry.prev_hash = prev;
    // content_hash = sha256(canonical JSON of entry minus content_hash)
    const { content_hash: _, ...forHash } = entry;
    const hash = sha256hex(canonicalJson(forHash));
    entry.content_hash = hash;
    prev = hash;
  }
}

interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
}

function verify(entries: readonly Finding[]): VerifyResult {
  let prev = ZERO_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `chain break at entry ${i} (${entry.id}): prev_hash=${entry.prev_hash} expected=${prev}`,
      };
    }
    const { content_hash, ...forHash } = entry;
    const recomp = sha256hex(canonicalJson(forHash));
    if (recomp !== content_hash) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `hash mismatch at entry ${i} (${entry.id}): recomputed=${recomp} stored=${content_hash}`,
      };
    }
    prev = content_hash;
  }
  return { ok: true, entries: entries.length, firstFailureIndex: null, reason: null };
}

function cmdVerify(): number {
  try {
    const stagingFiles = registryMutationStagingFiles(
      resolveGitFindingAllocationAuthority(REPO_ROOT),
    );
    if (stagingFiles.length > 0) {
      process.stderr.write(
        `FAIL: unpublished finding-registry atomic staging files exist: ${stagingFiles.join(
          ',',
        )}\n`,
      );
      return 1;
    }
  } catch (error) {
    process.stderr.write(
      `FAIL: finding-registry staging inspection failed closed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  const entries = loadRegistry();
  const result = verify(entries);
  if (!result.ok) {
    console.error(`FAIL: ${result.reason}`);
    return 1;
  }
  console.log(`OK: registry chain valid (${result.entries} entries).`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  if (tip) console.log(`Chain tip: ${tip}`);
  return 0;
}

function cmdWriterPreflight(): number {
  try {
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    authority.assertCompatibleWriters();
    const registryCount = authority.activeRegistryPaths().length;
    const floorCount = Object.keys(authority.reservedDomainFloors()).length;
    const stagingFiles = registryMutationStagingFiles(authority);
    if (stagingFiles.length > 0) {
      throw new Error(`unpublished atomic staging files exist: ${stagingFiles.join(',')}`);
    }
    process.stdout.write(
      `OK: finding writer preflight passed (${registryCount} active registries, ${floorCount} reserved namespaces).\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `FAIL: finding writer preflight failed closed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

function readFindingStub(stubPath: string): Partial<Finding> | null {
  if (!existsSync(stubPath)) {
    process.stderr.write(`Stub file not found: ${stubPath}\n`);
    return null;
  }
  return normalizedAddStub(stubPath);
}

function buildFinding(stub: Partial<Finding>, id: string, effectiveAt: string): Finding | null {
  const required: (keyof Finding)[] = ['severity', 'title', 'owner_agent', 'raised_in_cycle'];
  for (const field of required) {
    if (stub[field] === undefined || stub[field] === null) {
      process.stderr.write(`Stub missing required field: ${field}\n`);
      return null;
    }
  }

  return {
    id,
    severity: stub.severity as Finding['severity'],
    state: 'OPEN',
    title: stub.title as string,
    ...(stub.layer === undefined || stub.layer === null ? {} : { layer: stub.layer }),
    evidence: stub.evidence ?? [],
    rule_violated: stub.rule_violated ?? '',
    owner_agent: stub.owner_agent as string,
    raised_in_cycle: stub.raised_in_cycle as string,
    review_file: stub.review_file ?? '',
    created_at: effectiveAt,
    closed_at: null,
    closing_commits: [],
    deadline: stub.deadline ?? null,
    owner_user: stub.owner_user ?? null,
    override_of: stub.override_of ?? null,
    notes: stub.notes ?? '',
    ...(stub.narrative ? { narrative: stub.narrative } : {}),
    prev_hash: ZERO_HASH, // fixed by rechain
    content_hash: ZERO_HASH, // fixed by rechain
  };
}

function validateAndAppendFinding(
  newEntry: Finding,
  entries: Finding[],
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  paths: RegistryPaths,
  beforeRegistryWrite?: () => void,
): number {
  if (entries.some((entry) => entry.id === newEntry.id)) {
    process.stderr.write(`Duplicate id: ${newEntry.id} already exists in registry.\n`);
    return 1;
  }

  // Schema validation BEFORE rechain: reject malformed stubs at the
  // earliest point. The prev_hash/content_hash placeholders match the
  // schema's pattern rule (64-hex OR 64-zero), so validation can run
  // pre-rechain. This guarantees no schema-violating entry ever hits
  // the JSONL — the invariant test becomes a belt-and-suspenders
  // check rather than the primary defence.
  const validate = loadStubValidator(paths.schemaPath);
  if (!validate(newEntry)) {
    process.stderr.write('Stub failed schema validation:\n');
    for (const err of validate.errors ?? []) {
      process.stderr.write(`  ${err.instancePath || '<root>'}: ${err.message} (${err.keyword})\n`);
    }
    return 1;
  }

  entries.push(newEntry);
  rechain(entries, entries.length - 1);

  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-add integrity check FAILED: ${post.reason}\n`);
    return 1;
  }

  beforeRegistryWrite?.();
  writeRegistry(entries, lease, repositoryAuthority, 'add', paths.registryPath);
  process.stdout.write(`Added: ${newEntry.id} at position ${entries.length - 1}\n`);
  process.stdout.write(`Chain tip: ${newEntry.content_hash}\n`);
  return 0;
}

/**
 * Every id already claimed in `domain`, across EVERY store that claims ids.
 *
 * ORPHAN-HIGH-457 — the single reader both append paths must use.
 * `ORPHAN-HIGH-417` fixed the allocator by teaching it to read the markdown
 * orphan store as well as the registry, and left `appendExplicitFinding`
 * reading only the registry. So the exact defect that forced this branch to
 * be retraced — an id handed out that already names a live finding — was
 * still reachable through the other door, and an adversarial audit walked
 * through it: `appendExplicitFinding` accepted `ORPHAN-MEDIUM-416`, which is
 * a live heading in `orphan-findings.md`, and returned 0.
 *
 * Two readers that must agree is the shape that produced the bug. One reader
 * that both callers are forced through is the shape that cannot: a third
 * append path added later inherits every store by construction rather than by
 * the author remembering all of them.
 *
 * The stores, and why each counts:
 *   * the JSONL registry — the obvious one;
 *   * sibling active worktree registries via `authority`, so two concurrent
 *     branches cannot mint the same id;
 *   * `docs/reviews/orphan-findings.md`, which allocates from the SAME ORPHAN
 *     sequence space. At the time this was found the registry's ORPHAN
 *     maximum was 332 while the markdown store was already at 416, so the
 *     next nineteen ids handed out (333-351) all named findings that already
 *     existed. Eight collided exactly, and their commit trailers resolved —
 *     to the wrong finding.
 */
export function claimedIdsForDomain(
  domain: string,
  entries: ReadonlyArray<{ id: string }>,
  authority?: FindingAllocationAuthority,
): string[] {
  const claimed = entries.map((entry) => entry.id);
  if (authority) {
    claimed.push(...idsFromActiveRegistries(authority));
    const sourceInventoryFloor = allocationFloorForDomain(authority.reservedDomainFloors(), domain);
    if (sourceInventoryFloor > 0) {
      claimed.push(`${domain}-SOURCEINVENTORY-${String(sourceInventoryFloor).padStart(3, '0')}`);
    }
  }
  if (domain === 'ORPHAN') {
    claimed.push(...orphanMarkdownReservedIds(ORPHAN_FINDINGS_MD_PATH));
  }
  return claimed;
}

export function appendAllocatedFinding(
  domain: string,
  stubPath: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
  authority?: FindingAllocationAuthority,
): number {
  if (
    lease.resourcePath !== paths.registryPath ||
    (authority !== undefined && lease.lockPath !== authority.lockPath)
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Allocated append requires a lease for both the target registry and its allocation authority.',
    );
  }
  authority?.assertCompatibleWriters();
  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (stub.id !== undefined) {
    process.stderr.write('Allocated add refuses a caller-supplied id; remove id from the stub.\n');
    return 2;
  }
  if (stub.severity === undefined) {
    process.stderr.write('Stub missing required field: severity\n');
    return 2;
  }

  const entries = loadRegistry(paths.registryPath);
  const reservationLedger = authority ? loadReservationLedger(authority.reservationPath) : null;
  const existingIds = claimedIdsForDomain(domain, entries, authority);
  const reserved = reservationLedger?.domains[domain];
  if (reserved) {
    existingIds.push(`${domain}-RESERVED-${String(reserved.sequence).padStart(3, '0')}`);
  }
  let id: string;
  try {
    id = nextFindingId(domain, stub.severity, existingIds);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const newEntry = buildFinding(stub, id, repositoryAuthority.effectiveAt);
  if (!newEntry) return 2;
  return validateAndAppendFinding(newEntry, entries, lease, repositoryAuthority, paths, () => {
    if (authority && reservationLedger) {
      reserveFindingId(
        authority,
        reservationLedger,
        domain,
        id,
        paths.registryPath,
        lease,
        repositoryAuthority.effectiveAt,
      );
    }
  });
}

export function appendExplicitFinding(
  stubPath: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
  authority?: FindingAllocationAuthority,
): number {
  if (
    lease.resourcePath !== paths.registryPath ||
    (authority !== undefined && lease.lockPath !== authority.lockPath)
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Explicit append requires a lease for both the target registry and its allocation authority.',
    );
  }
  authority?.assertCompatibleWriters();
  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (typeof stub.id !== 'string' || stub.id.length === 0) {
    process.stderr.write('Explicit-id stub missing required field: id\n');
    return 2;
  }
  const entries = loadRegistry(paths.registryPath);

  const idParts = /^([A-Z][A-Z0-9]*)-([A-Z0-9]+)-([0-9]{3})$/.exec(stub.id);
  if (!idParts?.[1] || !idParts[2] || !idParts[3]) {
    process.stderr.write(`Explicit finding id has an invalid allocation shape: ${stub.id}\n`);
    return 2;
  }
  const explicitDomain = idParts[1];
  const explicitId = stub.id;
  // ORPHAN-HIGH-457 — the same stores AND the same sequence extraction the
  // allocator uses. Shape is parsed first because the domain decides which
  // stores apply. Two things were wrong here before: this path consulted the
  // registry alone, and it compared full id strings. Both matter — the
  // markdown store normalizes to `ORPHAN-RESERVED-NNN` (a heading carries no
  // severity) and the classifier segment varies with severity anyway, so
  // `ORPHAN-MEDIUM-416` never string-matched the live `416` heading. The
  // sequence is the identity.
  const reservationLedger = authority ? loadReservationLedger(authority.reservationPath) : null;
  const existingIds = claimedIdsForDomain(explicitDomain, entries, authority);
  const reserved = reservationLedger?.domains[explicitDomain];
  if (reserved) {
    existingIds.push(`${explicitDomain}-RESERVED-${String(reserved.sequence).padStart(3, '0')}`);
  }
  const claimed = claimedSequences(explicitDomain, existingIds);
  if (claimed.has(Number.parseInt(idParts[3], 10))) {
    process.stderr.write(
      `Duplicate id: ${stub.id} — sequence ${idParts[3]} is already claimed in ` +
        `domain ${explicitDomain} by the registry, a sibling worktree registry, or ` +
        `docs/reviews/orphan-findings.md.\n`,
    );
    return 1;
  }
  if (Number.parseInt(idParts[3], 10) < 1) {
    process.stderr.write(`Explicit finding id suffix must be between 001 and 999: ${stub.id}\n`);
    return 2;
  }
  if (
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(idParts[2]) &&
    stub.severity !== undefined &&
    idParts[2] !== stub.severity
  ) {
    process.stderr.write(
      `Explicit finding id classifier ${idParts[2]} does not match severity ${stub.severity}: ${stub.id}\n`,
    );
    return 2;
  }
  const newEntry = buildFinding(stub, explicitId, repositoryAuthority.effectiveAt);
  if (!newEntry) return 2;
  return validateAndAppendFinding(newEntry, entries, lease, repositoryAuthority, paths, () => {
    if (authority && reservationLedger) {
      reserveFindingId(
        authority,
        reservationLedger,
        explicitDomain,
        explicitId,
        paths.registryPath,
        lease,
        repositoryAuthority.effectiveAt,
      );
    }
  });
}

function cmdClose(
  id: string,
  shortSha: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
): number {
  if (!/^[a-f0-9]{40}$/.test(shortSha)) {
    console.error(`Invalid SHA: ${shortSha} (expected a full lowercase main SHA).`);
    return 2;
  }

  // PROC-HIGH-001 structural guard (Round-2 cluster-0): the three-store
  // invariant requires every closing_commits SHA to exist in fetchable
  // history. A feature-branch SHA is GUARANTEED to be invalidated by
  // branch cleanup after merge (2026-06-10: 7 rows orphaned by #378,
  // repaired in #384; SEC-CRITICAL-002 / AUDIT-CRITICAL-006 recurrences
  // repaired in #380 / cluster-0). The ceremony therefore runs ONLY
  // post-merge, with a main-reachable commit whose own message carries
  // the matching Closes: trailer. Fail-closed — an unresolvable
  // origin/main (stale fetch, shallow clone) refuses with instructions
  // rather than certifying blind.
  // tier-1: runtime guard commitReachableFrom (git-reachability.ts) refuses branch-local closing SHAs at the only write path; CI invariant finding-registry-integrity.spec.ts enforces the stored chain
  const reachability = commitReachableFrom(REPO_ROOT, shortSha, 'origin/main');
  if (!reachability.ok) {
    // process.stderr.write (not console.error): no-console is an
    // error-level lint rule; the file's legacy console.* calls are
    // baseline-grandfathered but new lines must use the stream API.
    process.stderr.write(`close refused: ${reachability.reason}\n`);
    return 1;
  }

  const entries = loadRegistry();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) {
    console.error(`Finding not found: ${id}`);
    return 1;
  }

  const entry = entries[index];
  if (!entry) {
    console.error(`Finding at index ${index} is undefined — registry corruption?`);
    return 1;
  }

  const traceability = commitHasFindingCloseTrailer(REPO_ROOT, shortSha, id);
  if (!traceability.ok) {
    process.stderr.write(`close refused: ${traceability.reason}\n`);
    return 1;
  }

  if (entry.state === 'RESOLVED' && entry.closing_commits.includes(shortSha)) {
    console.log(`No-op: ${id} is already RESOLVED with closing commit ${shortSha}.`);
    return 0;
  }

  entry.state = 'RESOLVED';
  entry.closed_at = entry.closed_at ?? repositoryAuthority.effectiveAt;
  if (!entry.closing_commits.includes(shortSha)) {
    entry.closing_commits = [...entry.closing_commits, shortSha];
  }

  // Rechain from mutated entry to tail; earlier entries unchanged.
  rechain(entries, index);

  const post = verify(entries);
  if (!post.ok) {
    console.error(`Post-close integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries, lease, repositoryAuthority, 'close');
  console.log(`Closed: ${id} at position ${index} → state=RESOLVED, +commit ${shortSha}`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  console.log(`Chain tip: ${tip}`);
  return 0;
}

interface SweepConfig {
  readonly staleAfterDays: number;
  readonly dryRun: boolean;
  readonly now: Date;
}

interface SweepAction {
  readonly id: string;
  readonly fromState: Finding['state'];
  readonly toState: Finding['state'];
  readonly reason: string;
}

/**
 * Phase 6 state-sweep automation — runs daily in CI, transitions state
 * based on declarative rules:
 *
 *   * OPEN / IN-PROGRESS finding older than `staleAfterDays`
 *     (default 30) → STALE.
 *   * Any non-RESOLVED finding with `deadline` in the past → BLOCKED.
 *
 * Deterministic ordering: deadline check before staleness check so a
 * past-deadline STALE-candidate lands in BLOCKED (the stronger signal).
 *
 * --dry-run prints the proposed transitions WITHOUT mutating the
 * registry. The daily workflow opens a PR with the mutations so a
 * human reviews before merge — direct auto-commit would open a
 * tampering surface (bot push to main).
 */
function planSweep(entries: readonly Finding[], config: SweepConfig): SweepAction[] {
  const actions: SweepAction[] = [];
  const staleThresholdMs = config.staleAfterDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (entry.state === 'RESOLVED') continue;

    // Deadline check (stronger signal) runs first.
    if (entry.deadline) {
      const deadlineDate = new Date(entry.deadline);
      if (!Number.isNaN(deadlineDate.getTime()) && deadlineDate < config.now) {
        if (entry.state !== 'BLOCKED') {
          actions.push({
            id: entry.id,
            fromState: entry.state,
            toState: 'BLOCKED',
            reason: `past deadline ${entry.deadline}`,
          });
        }
        continue;
      }
    }

    // Staleness check (OPEN + IN-PROGRESS only, not BLOCKED/STALE).
    if (entry.state === 'OPEN' || entry.state === 'IN-PROGRESS') {
      const created = new Date(entry.created_at);
      if (Number.isNaN(created.getTime())) continue;
      const ageMs = config.now.getTime() - created.getTime();
      if (ageMs >= staleThresholdMs) {
        actions.push({
          id: entry.id,
          fromState: entry.state,
          toState: 'STALE',
          reason: `${Math.floor(ageMs / 86400000)} days old (threshold ${config.staleAfterDays})`,
        });
      }
    }
  }
  return actions;
}

function cmdSweep(
  args: string[],
  lease?: RegistryLockLease,
  repositoryAuthority?: RepositoryMutationAuthority,
): number {
  const dryRun = args.includes('--dry-run');
  const staleAfterDays = sweepStaleAfterDays(args);
  const effectiveAt =
    repositoryAuthority?.effectiveAt ??
    (process.env['FINDING_EFFECTIVE_AT'] ? canonicalEffectiveAt() : new Date().toISOString());

  const entries = loadRegistry();
  const actions = planSweep(entries, {
    staleAfterDays,
    dryRun,
    now: new Date(effectiveAt),
  });

  if (actions.length === 0) {
    console.log(`Sweep clean: 0 transitions needed (${entries.length} entries scanned).`);
    return 0;
  }

  console.log(`Sweep plan (${actions.length} transitions):`);
  for (const a of actions) {
    console.log(`  ${a.id}: ${a.fromState} → ${a.toState}  (${a.reason})`);
  }

  if (dryRun) {
    console.log('');
    console.log('--dry-run: no mutations written.');
    return 0;
  }
  if (!lease || !repositoryAuthority) {
    throw new Error('Sweep mutation requires repository-global mutation authority');
  }

  // Apply transitions; earliest mutated entry anchors rechain scope.
  let minIndex = entries.length;
  for (const a of actions) {
    const i = entries.findIndex((e) => e.id === a.id);
    if (i === -1) continue;
    const entry = entries[i];
    if (!entry) continue;
    entry.state = a.toState;
    if (i < minIndex) minIndex = i;
  }
  rechain(entries, minIndex);

  const post = verify(entries);
  if (!post.ok) {
    console.error(`Post-sweep integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries, lease, repositoryAuthority, 'sweep');
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  console.log('');
  console.log(`Applied ${actions.length} transitions. Chain tip: ${tip}`);
  return 0;
}

function cmdExport(format: string): number {
  const entries = loadRegistry();
  if (format === 'json-array') {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (format === 'csv') {
    const cols = [
      'id',
      'severity',
      'state',
      'title',
      'owner_agent',
      'created_at',
      'closed_at',
      'closing_commits',
    ];
    console.log(cols.join(','));
    for (const e of entries) {
      const row = cols.map((c) => {
        const v = (e as Record<string, unknown>)[c];
        const s = Array.isArray(v) ? v.join('|') : String(v ?? '');
        // CSV-escape: wrap in quotes if contains comma/quote/newline
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      console.log(row.join(','));
    }
    return 0;
  }
  console.error(`Unknown export format: ${format} (supported: json-array, csv).`);
  return 2;
}

/**
 * `list` — tabular registry view filtered by state / severity / owner.
 *
 * Added in Phase 14 (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1)
 * as the read-only dev-loop equivalent of `findings:list` / `findings:list:all`
 * npm scripts. Purely a query — does NOT mutate the registry or recompute
 * hashes. When no flags are passed, prints every entry.
 *
 * Flags:
 *   --state <CSV>    OPEN,IN-PROGRESS,RESOLVED,STALE,BLOCKED
 *   --severity <CSV> CRITICAL,HIGH,MEDIUM,LOW
 *   --owner <name>   owner_agent substring match
 *   --format <fmt>   table (default) | id-only | json
 *
 * Exit 0 always unless the registry itself is missing/malformed; absence
 * of matches is NOT an error (an empty OPEN list is a good result).
 */
function cmdList(args: readonly string[]): number {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  const entries = loadRegistry();
  const stateFilter =
    flags['state']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const sevFilter =
    flags['severity']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const ownerFilter = flags['owner'] ?? null;

  const matched = entries.filter((e) => {
    if (stateFilter && !stateFilter.includes(e.state)) return false;
    if (sevFilter && !sevFilter.includes(e.severity)) return false;
    if (ownerFilter && !e.owner_agent.includes(ownerFilter)) return false;
    return true;
  });

  const format = flags['format'] ?? 'table';
  if (format === 'id-only') {
    for (const e of matched) console.log(e.id);
    return 0;
  }
  if (format === 'json') {
    console.log(JSON.stringify(matched, null, 2));
    return 0;
  }
  // table (default)
  if (matched.length === 0) {
    const criteria =
      [
        stateFilter ? `state=${stateFilter.join(',')}` : null,
        sevFilter ? `severity=${sevFilter.join(',')}` : null,
        ownerFilter ? `owner=${ownerFilter}` : null,
      ]
        .filter(Boolean)
        .join(' ') || 'all';
    console.log(`(no findings matched: ${criteria})`);
    return 0;
  }
  const header = ['ID', 'SEV', 'STATE', 'OWNER', 'TITLE'];
  const rows = matched.map((e) => [
    e.id,
    e.severity,
    e.state,
    e.owner_agent,
    e.title.length > 60 ? e.title.slice(0, 57) + '...' : e.title,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (r: readonly string[]): string =>
    r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmtRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmtRow(r));
  console.log(`\n${matched.length} / ${entries.length} entries matched.`);
  return 0;
}

async function main(): Promise<void> {
  const [, , sub, ...args] = process.argv;
  if (!sub) {
    console.error(
      'Usage: finding-registry <verify|writer-preflight|request-digest|add|close|sweep|export|list> [args]',
    );
    console.error('  verify');
    console.error('  writer-preflight');
    console.error('  request-digest <add|close|sweep> [operation args]');
    console.error('  add <domain> <stub.json>  — atomically allocate id + append');
    console.error('  close <finding-id> <full-main-sha>');
    console.error('  sweep [--dry-run] [--stale-after=<days>]');
    console.error('  export <json-array|csv>');
    console.error(
      '  list [--state <CSV>] [--severity <CSV>] [--owner <name>] [--format table|id-only|json]',
    );
    process.exit(2);
  }

  let exitCode = 0;
  if (sub === 'verify') {
    exitCode = cmdVerify();
  } else if (sub === 'writer-preflight') {
    exitCode = cmdWriterPreflight();
  } else if (sub === 'request-digest') {
    const operation = args[0];
    if (operation !== 'add' && operation !== 'close' && operation !== 'sweep') {
      console.error('request-digest requires one of: add, close, sweep');
      process.exit(2);
    }
    process.stdout.write(`${mutationInputSha256(operation, args.slice(1))}\n`);
    exitCode = 0;
  } else if (sub === 'add') {
    const domain = args[0];
    const stubPath = args[1];
    if (!domain || !stubPath) {
      console.error('add requires domain and stub: finding-registry add <DOMAIN> <stub.json>');
      process.exit(2);
    }
    const inputSha256 = mutationInputSha256('add', [domain, stubPath]);
    exitCode = await runRegistryMutation(
      'add',
      inputSha256,
      (lease, authority, repositoryAuthority) =>
        appendAllocatedFinding(
          domain,
          resolve(stubPath),
          lease,
          repositoryAuthority,
          DEFAULT_REGISTRY_PATHS,
          authority,
        ),
    );
  } else if (sub === 'close') {
    const id = args[0];
    const sha = args[1];
    if (!id || !sha) {
      console.error('close requires id and sha: finding-registry close <id> <sha>');
      process.exit(2);
    }
    const inputSha256 = mutationInputSha256('close', [id, sha]);
    exitCode = await runRegistryMutation(
      'close',
      inputSha256,
      (lease, authority, repositoryAuthority) => cmdClose(id, sha, lease, repositoryAuthority),
    );
  } else if (sub === 'export') {
    const format = args[0];
    if (!format) {
      console.error('export requires a format: finding-registry export <json-array|csv>');
      process.exit(2);
    }
    exitCode = cmdExport(format);
  } else if (sub === 'sweep') {
    exitCode = args.includes('--dry-run')
      ? cmdSweep(args)
      : await runRegistryMutation(
          'sweep',
          mutationInputSha256('sweep', args),
          (lease, authority, repositoryAuthority) => cmdSweep(args, lease, repositoryAuthority),
        );
  } else if (sub === 'list') {
    exitCode = cmdList(args);
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    process.exit(2);
  }

  process.exit(exitCode);
}

async function runRegistryMutation(
  operation: RegistryMutationOperation,
  inputSha256: string,
  action: (
    lease: RegistryLockLease,
    authority: FindingAllocationAuthority,
    repositoryAuthority: RepositoryMutationAuthority,
  ) => number,
): Promise<number> {
  try {
    const repositoryAuthority = await acquireRepositoryMutationAuthority(operation);
    if (repositoryAuthority.inputSha256 !== inputSha256) {
      throw new Error(
        `Trusted workflow input digest ${repositoryAuthority.inputSha256} differs from CLI digest ${inputSha256}`,
      );
    }
    const priorCommand = committedMutationCommand(repositoryAuthority.commandId);
    if (priorCommand) {
      if (priorCommand.operation !== operation || priorCommand.inputSha256 !== inputSha256) {
        throw new Error(
          `Automation command ${repositoryAuthority.commandId} was already committed with different semantics at ${priorCommand.commitSha}`,
        );
      }
      process.stdout.write(
        `No-op: automation command ${repositoryAuthority.commandId} already committed at ${priorCommand.commitSha}.\n`,
      );
      return 0;
    }
    process.stdout.write(
      `Repository mutation authority: ${repositoryAuthority.workflowRef} run ${repositoryAuthority.runId}/${repositoryAuthority.runAttempt} at ${repositoryAuthority.workflowSha}\n`,
    );
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    return withRegistryFileLock(
      REGISTRY_PATH,
      (lease) => {
        authority.assertCompatibleWriters();
        recoverRegistryMutationStaging(authority, lease);
        return action(lease, authority, repositoryAuthority);
      },
      {
        lockPath: authority.lockPath,
      },
    );
  } catch (error) {
    if (error instanceof RegistryLockError) {
      process.stderr.write(`Registry mutation refused [${error.code}]: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `Registry mutation authority failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Registry command failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
