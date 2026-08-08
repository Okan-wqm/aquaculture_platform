#!/usr/bin/env ts-node
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

import * as ts from 'typescript';
import * as YAML from 'yaml';
import yamlPackage from 'yaml/package.json';

import {
  ariaAuthorityFiles,
  assertAriaAuthorityHashCurrent,
  CURRENT_STATE_PATH,
} from '../aria-authority-hash';
import {
  AUTOMATION_BASE_REF,
  AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE,
  AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
  AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
  AUTOMATION_PUBLICATION_COMPARE_AND_SWAP,
  AUTOMATION_PUBLICATION_IDEMPOTENCY,
  AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE,
  AUTOMATION_REGISTRY_LOGICAL_BRANCH,
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY,
} from './automation-publication-policy';
import {
  admitFindingWriterCliInvocation,
  FINDING_WRITER_CLI_COMMAND_CONTRACT,
  isFindingWriterCliExecutablePath,
} from './finding-writer-cli-contract';
import { hasOwn } from './json-contract';
import {
  assertStableDirectoryCurrent,
  assertStableDirectoryContentGenerationCurrent,
  assertStablePathKindCurrent,
  assertStableRegularFileCurrent,
  decodeFatalUtf8,
  observeStableDirectory,
  observeStablePathKind,
  observeStableRegularFile,
  sameAnchoredPathGeneration,
  type AnchoredPathKindV1,
  type StableDirectoryObservationV1,
  type StableRegularFileObservationV1,
  type StablePathKindObservationV1,
} from './anchored-filesystem';
import { REPO_ROOT } from './repo-root';

const FINDING_WRITER_AUTOMATION_WORKFLOW_PATHS = Object.freeze(
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY.map((policy) => policy.workflowPath),
);
const FINDING_WRITER_AUTOMATION_WORKFLOW_REFS = Object.freeze(
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY.map((policy) => policy.workflowRef),
);

export const FINDING_WRITER_AUTHORITY_PATH =
  '.github/manifests/finding-registry-writer-authority.json';
export const FINDING_WRITER_AUTHORITY_SCHEMA = 'aqua/finding-registry-writer-authority/v6' as const;
export const FINDING_WRITER_AUTHORITY_SCHEMA_VERSION = 6 as const;
export const FINDING_WRITER_PROTOCOL_ID = 'aqua.finding-registry-writer/v7' as const;
export const FINDING_WRITER_PUBLISHER = 'GITHUB_GRAPHQL_SIGNED_COMMIT_V1' as const;
export const FINDING_WRITER_PUBLISHER_CREDENTIAL =
  'CURRENT_REPOSITORY_GITHUB_APP_INSTALLATION_V1' as const;
export const FINDING_WRITER_LOCAL_FENCE = Object.freeze({
  kind: 'PERSISTENT_COMMON_DIR_OPEN_FILE_DESCRIPTION_FLOCK_V1' as const,
  file_contract: Object.freeze({
    content: 'EMPTY' as const,
    mode: '0600' as const,
    uid: 'CURRENT_PROCESS_UID' as const,
    link_count: 1 as const,
    inode: 'PERSISTENT_SINGLE_INODE' as const,
  }),
  executable_attestation: Object.freeze({
    path: '/usr/bin/flock' as const,
    descriptor_bound: true as const,
    root_owned: true as const,
    parent_chain_root_owned_non_writable: true as const,
    minimum_version: '2.37' as const,
    sha256_attested: true as const,
  }),
});

export const FINDING_WRITER_ENTRYPOINT_PATHS = Object.freeze([
  '.github/CODEOWNERS',
  '.github/manifests/automation-publication-authority.json',
  '.github/workflows/aria-daily-report.yml',
  '.github/workflows/automation-publication-admission.yml',
  '.github/workflows/ci-full.yml',
  '.github/workflows/finding-registry-authority.yml',
  '.github/workflows/finding-state-sweep.yml',
  '.github/workflows/rule-health-report.yml',
  'docs/reviews/_registry/findings.jsonl.schema.json',
  'package.json',
  'tools/gates/finding-registry-publication.ts',
  'tools/gates/finding-registry.ts',
  'tools/gates/lib/finding-registry-writer-authority.ts',
  'tools/scripts/automation/publish-automation-pr.ts',
  'tools/scripts/automation/resolve-github-run-clock.mjs',
  'tools/scripts/automation/tsconfig.json',
] as const);

/** Historical mutation entrypoints that must be absent when a worktree has no canonical writer. */
export const FINDING_WRITER_RETIRED_MUTATION_SURFACES = Object.freeze([
  'tools/audit/migrate-schema-violations.ts',
  'tools/audit/registry-rechain-after-squash.ts',
  'tools/audit/seed-audit-findings.ts',
  'tools/scripts/patch-registry-phase2b.mjs',
  'tools/scripts/patch-registry-phase2b.ts',
  'tools/scripts/seed-claude-audit-findings.mjs',
  'tools/scripts/seed-claude-audit-findings.ts',
  'tools/scripts/seed-finding-registry.mjs',
  'tools/scripts/seed-finding-registry.ts',
] as const);

type FindingWriterDeclaredAssetEdge =
  | {
      readonly kind: 'READS_FILE' | 'EXECUTES_FILE' | 'LOCKS_DEPENDENCIES' | 'COMMAND_PROJECT';
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'HASH_LINKED_AUTHORITY';
      readonly from: string;
      readonly to: typeof CURRENT_STATE_PATH;
      readonly verifier: 'ARIA_AUTHORITY_HASH_V1';
    };

function freezeFindingWriterDeclaredAssetEdges(
  edges: readonly FindingWriterDeclaredAssetEdge[],
): readonly FindingWriterDeclaredAssetEdge[] {
  return Object.freeze(edges.map((edge) => Object.freeze({ ...edge })));
}

interface FindingWriterParserAuthority {
  readonly packageName: 'typescript' | 'yaml';
  readonly runtimeVersion: string;
}

const FINDING_WRITER_PARSER_AUTHORITIES: readonly FindingWriterParserAuthority[] = [
  { packageName: 'typescript', runtimeVersion: ts.version },
  { packageName: 'yaml', runtimeVersion: yamlPackage.version },
] as const;

const FINDING_WRITER_MAX_FILE_BYTES = 64 * 1024 * 1024;

type FindingWriterPathKind = AnchoredPathKindV1;

export interface FindingWriterDirectoryEntry {
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
}

export interface FindingWriterRepositorySnapshot {
  readonly repoRoot: string;
  readFile(relativePath: string): Buffer;
  readText(relativePath: string): string;
  fileExists(absolutePath: string): boolean;
  directoryExists(absolutePath: string): boolean;
  realpath(absolutePath: string): string;
  getDirectories(absolutePath: string): string[];
  directoryEntries(relativePath: string): readonly FindingWriterDirectoryEntry[];
  recordPathSet(identity: string, paths: readonly string[], readCurrent: () => string[]): void;
  assertCurrent(): void;
}

export interface FindingWriterSnapshotReadObserver {
  onFileRead(relativePath: string): void;
  onDirectoryRead(relativePath: string): void;
}

class CachedFindingWriterRepositorySnapshot implements FindingWriterRepositorySnapshot {
  public readonly repoRoot: string;
  private readonly fileBytes = new Map<string, Buffer>();
  private readonly fileGenerations = new Map<string, StableRegularFileObservationV1>();
  private readonly directoryGenerations = new Map<string, StableDirectoryObservationV1>();
  private readonly directoryEntryValues = new Map<string, readonly FindingWriterDirectoryEntry[]>();
  private readonly pathKinds = new Map<string, StablePathKindObservationV1>();
  private readonly pathKindParentGenerations = new Map<string, StableDirectoryObservationV1>();
  private readonly pathSets = new Map<
    string,
    { readonly paths: readonly string[]; readonly readCurrent: () => string[] }
  >();

  public constructor(
    repoRoot: string,
    private readonly readObserver?: FindingWriterSnapshotReadObserver,
  ) {
    this.repoRoot = resolve(repoRoot);
    this.captureDirectory(this.repoRoot, false);
  }

  private normalize(
    path: string,
    allowRepositoryRoot = false,
  ): { absolutePath: string; relativePath: string } {
    const absolutePath = resolve(this.repoRoot, path);
    const relativePath = relative(this.repoRoot, absolutePath).replaceAll('\\', '/');
    if (
      (!allowRepositoryRoot && relativePath.length === 0) ||
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      relativePath.startsWith('/')
    ) {
      throw new Error(`Finding writer snapshot path escapes the repository: ${path}`);
    }
    return { absolutePath, relativePath };
  }

  private captureDirectory(absolutePath: string, withEntries: boolean): void {
    const prior = this.directoryGenerations.get(absolutePath);
    if (prior !== undefined && prior.entries !== null) return;
    if (!withEntries && prior !== undefined) return;

    if (withEntries) {
      this.readObserver?.onDirectoryRead(
        relative(this.repoRoot, absolutePath).replaceAll('\\', '/'),
      );
    }
    const observed = observeStableDirectory(
      absolutePath,
      'Finding writer snapshot directory',
      withEntries,
    );
    if (prior !== undefined && !sameAnchoredPathGeneration(prior.generation, observed.generation)) {
      throw new Error(`Finding writer snapshot directory generation changed: ${absolutePath}`);
    }
    if (observed.entries !== null) {
      this.directoryEntryValues.set(
        absolutePath,
        Object.freeze(
          observed.entries.map(
            (entry): FindingWriterDirectoryEntry =>
              Object.freeze({ name: entry.name, kind: entry.kind }),
          ),
        ),
      );
    }
    this.directoryGenerations.set(absolutePath, observed);
  }

  private assertComponents(relativePath: string): string {
    const { absolutePath } = this.normalize(relativePath, true);
    if (relativePath.length === 0) return absolutePath;
    const segments = relativePath.replaceAll('\\', '/').split('/');
    let cursor = this.repoRoot;
    for (const [index, segment] of segments.entries()) {
      if (segment.length === 0 || segment === '.' || segment === '..') {
        throw new Error(`Finding writer snapshot path is invalid: ${relativePath}`);
      }
      cursor = resolve(cursor, segment);
      const kind = this.recordPathKind(cursor);
      if (index < segments.length - 1) {
        if (kind !== 'DIRECTORY') {
          throw new Error(`Finding writer snapshot path component is not a directory: ${cursor}`);
        }
        if (!this.directoryGenerations.has(cursor)) this.captureDirectory(cursor, false);
      }
    }
    return absolutePath;
  }

  private recordPathKind(absolutePath: string): FindingWriterPathKind {
    this.normalize(absolutePath, true);
    const prior = this.pathKinds.get(absolutePath);
    if (prior !== undefined) {
      return prior.kind;
    }
    const observation = observeStablePathKind(absolutePath, 'Finding writer resolver path');
    const priorParent = this.pathKindParentGenerations.get(observation.parent.path);
    if (
      priorParent !== undefined &&
      !sameAnchoredPathGeneration(priorParent.generation, observation.parent.generation)
    ) {
      throw new Error(
        `Finding writer resolver parent content generation changed: ${observation.parent.path}`,
      );
    }
    this.pathKindParentGenerations.set(observation.parent.path, observation.parent);
    this.pathKinds.set(absolutePath, observation);
    return observation.kind;
  }

  public readFile(relativePath: string): Buffer {
    const normalized = this.normalize(relativePath);
    const cached = this.fileBytes.get(normalized.relativePath);
    if (cached !== undefined) return Buffer.from(cached);
    const absolutePath = this.assertComponents(normalized.relativePath);
    const observed = observeStableRegularFile(
      absolutePath,
      FINDING_WRITER_MAX_FILE_BYTES,
      'Finding writer snapshot file',
      () => this.readObserver?.onFileRead(normalized.relativePath),
    );
    this.fileBytes.set(normalized.relativePath, observed.content);
    this.fileGenerations.set(normalized.relativePath, observed);
    const pathKind = this.pathKinds.get(absolutePath);
    if (pathKind !== undefined && pathKind.kind !== 'FILE') {
      throw new Error(`Finding writer resolver topology changed while reading: ${absolutePath}`);
    }
    return Buffer.from(observed.content);
  }

  public readText(relativePath: string): string {
    return decodeFatalUtf8(this.readFile(relativePath), `Finding writer text ${relativePath}`);
  }

  public fileExists(absolutePath: string): boolean {
    return this.recordPathKind(resolve(absolutePath)) === 'FILE';
  }

  public directoryExists(absolutePath: string): boolean {
    const normalized = resolve(absolutePath);
    const exists = this.recordPathKind(normalized) === 'DIRECTORY';
    if (exists && !this.directoryGenerations.has(normalized)) {
      this.captureDirectory(normalized, false);
    }
    return exists;
  }

  public realpath(absolutePath: string): string {
    const normalized = this.normalize(absolutePath, true);
    this.assertComponents(normalized.relativePath);
    return normalized.absolutePath;
  }

  public getDirectories(absolutePath: string): string[] {
    const normalized = this.normalize(absolutePath, true);
    return this.directoryEntries(normalized.relativePath)
      .filter((entry) => entry.kind === 'DIRECTORY')
      .map((entry) => resolve(normalized.absolutePath, entry.name));
  }

  public directoryEntries(relativePath: string): readonly FindingWriterDirectoryEntry[] {
    const normalized = this.normalize(relativePath, true);
    this.assertComponents(normalized.relativePath);
    let entries = this.directoryEntryValues.get(normalized.absolutePath);
    if (entries === undefined) {
      this.captureDirectory(normalized.absolutePath, true);
      entries = this.directoryEntryValues.get(normalized.absolutePath);
    }
    if (entries === undefined) {
      throw new Error(`Finding writer snapshot lost directory entries: ${normalized.absolutePath}`);
    }
    return entries;
  }

  public recordPathSet(
    identity: string,
    paths: readonly string[],
    readCurrent: () => string[],
  ): void {
    if (this.pathSets.has(identity)) {
      throw new Error(`Finding writer snapshot path set is duplicated: ${identity}`);
    }
    this.pathSets.set(identity, { paths: Object.freeze([...paths]), readCurrent });
  }

  public assertCurrent(): void {
    for (const [identity, expected] of this.pathSets) {
      if (JSON.stringify(expected.readCurrent()) !== JSON.stringify(expected.paths)) {
        throw new Error(`Finding writer snapshot path set changed: ${identity}`);
      }
    }
    for (const [absolutePath, expected] of this.pathKinds) {
      if (expected.kind !== 'MISSING') {
        assertStablePathKindCurrent(expected, `Finding writer resolver path ${absolutePath}`);
      }
    }
    for (const [absolutePath, expected] of this.pathKindParentGenerations) {
      assertStableDirectoryContentGenerationCurrent(
        expected,
        `Finding writer resolver parent ${absolutePath}`,
      );
    }
    for (const [relativePath, expected] of this.fileGenerations) {
      const absolutePath = this.assertComponents(relativePath);
      assertStableRegularFileCurrent(
        expected,
        FINDING_WRITER_MAX_FILE_BYTES,
        `Finding writer snapshot file ${absolutePath}`,
      );
    }
    for (const [absolutePath, expected] of this.directoryGenerations) {
      assertStableDirectoryCurrent(expected, `Finding writer snapshot directory ${absolutePath}`);
    }
  }
}

export function createFindingWriterRepositorySnapshot(
  repoRoot: string = REPO_ROOT,
  readObserver?: FindingWriterSnapshotReadObserver,
): FindingWriterRepositorySnapshot {
  return new CachedFindingWriterRepositorySnapshot(repoRoot, readObserver);
}

/*
 * Typed provenance SSOT for executable inputs that language/action resolvers cannot infer. The
 * table describes relationships, never a duplicate governed-file list.
 */
export const FINDING_WRITER_DECLARED_ASSET_EDGES = freezeFindingWriterDeclaredAssetEdges([
  {
    kind: 'READS_FILE',
    from: '.github/actions/setup-aria-kernel/action.yml',
    to: 'aria-kernel/pyproject.toml',
  },
  {
    kind: 'EXECUTES_FILE',
    from: '.github/actions/setup-rust-workspace/action.yml',
    to: 'tools/quality/quality.mjs',
  },
  {
    kind: 'READS_FILE',
    from: '.github/actions/setup-rust-workspace/resolve-toolchain.mjs',
    to: 'tools/quality/rust-toolchain-manifest.json',
  },
  {
    kind: 'READS_FILE',
    from: 'tools/quality/quality.mjs',
    to: 'tools/quality/rust-toolchain-manifest.json',
  },
  {
    kind: 'READS_FILE',
    from: 'tools/quality/quality.mjs',
    to: 'rust-toolchain.toml',
  },
  {
    kind: 'READS_FILE',
    from: 'tools/quality/quality.mjs',
    to: 'Cargo.toml',
  },
  {
    kind: 'READS_FILE',
    from: 'tools/quality/quality.mjs',
    to: 'Cargo.lock',
  },
  {
    kind: 'LOCKS_DEPENDENCIES',
    from: 'package.json',
    to: 'package-lock.json',
  },
  {
    kind: 'COMMAND_PROJECT',
    from: 'package.json',
    to: 'tools/gates/tsconfig.json',
  },
  {
    kind: 'HASH_LINKED_AUTHORITY',
    from: '.github/workflows/aria-daily-report.yml',
    to: CURRENT_STATE_PATH,
    verifier: 'ARIA_AUTHORITY_HASH_V1',
  },
  {
    kind: 'HASH_LINKED_AUTHORITY',
    from: '.github/workflows/finding-registry-authority.yml',
    to: CURRENT_STATE_PATH,
    verifier: 'ARIA_AUTHORITY_HASH_V1',
  },
  {
    kind: 'HASH_LINKED_AUTHORITY',
    from: '.github/workflows/finding-state-sweep.yml',
    to: CURRENT_STATE_PATH,
    verifier: 'ARIA_AUTHORITY_HASH_V1',
  },
  {
    kind: 'HASH_LINKED_AUTHORITY',
    from: '.github/workflows/rule-health-report.yml',
    to: CURRENT_STATE_PATH,
    verifier: 'ARIA_AUTHORITY_HASH_V1',
  },
] as const satisfies readonly FindingWriterDeclaredAssetEdge[]);

interface FindingWriterSensitiveImportAuthority {
  readonly target: string;
  readonly symbol: string;
  readonly importers: readonly string[];
}

interface FindingWriterSensitiveReadOnlyExport {
  readonly target: string;
  readonly symbol: string;
}

function freezeFindingWriterSensitiveImportAuthority(
  authorities: readonly FindingWriterSensitiveImportAuthority[],
): readonly FindingWriterSensitiveImportAuthority[] {
  return Object.freeze(
    authorities.map((authority) =>
      Object.freeze({
        ...authority,
        importers: Object.freeze([...authority.importers]),
      }),
    ),
  );
}

function freezeFindingWriterSensitiveReadOnlyExports(
  exports_: readonly FindingWriterSensitiveReadOnlyExport[],
): readonly FindingWriterSensitiveReadOnlyExport[] {
  return Object.freeze(exports_.map((entry) => Object.freeze({ ...entry })));
}

/**
 * Reverse-edge SSOT for every export that can mint, redeem, bind, or execute a governed finding
 * mutation. Forward dependency closure alone cannot detect a new importer, so the compiler scans
 * every repository TS/JS source (including untracked files) and requires byte-exact set equality.
 */
export const FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY =
  freezeFindingWriterSensitiveImportAuthority([
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'createFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'prepareFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'consumeFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'redeemRegistryFindingWriterFence',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'releaseFindingWriterFence',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceAuthority',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceCurrent',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceTargetCurrent',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceRegistryTransition',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'openSourceFindingWriterFenceSession',
      importers: ['tools/gates/source-finding-inventory.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'closeSourceFindingWriterFenceSession',
      importers: ['tools/gates/source-finding-inventory.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertSourceFindingWriterFenceSessionCurrent',
      importers: ['tools/gates/source-finding-inventory.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertSourceFindingWriterFenceSessionTargetCurrent',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'withRegistryFileLock',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/finding-registry.ts',
        'tools/gates/lib/finding-registry-lock.fixture.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'withRegistryFileLockAsync',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'testOnlyAtomicWriteFileWithRegistryLease',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'bindSourceFindingPublicationStore',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'atomicWriteFindingReservationFile',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'recoverAtomicWriteStagingFiles',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'recoverGovernedFindingStagingFiles',
      importers: ['tools/gates/finding-registry.ts', 'tools/gates/source-finding-inventory.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'atomicWriteRegistryFile',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/source-finding-publication-kernel.ts',
      symbol: 'executeSourceFindingPublicationTransaction',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/lib/source-finding-publication-kernel.ts',
      symbol: 'executeSourceFindingRestartRecovery',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'assertActiveWorktreeFindingWritersFenced',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'resolveGitFindingAllocationAuthority',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'appendAllocatedFinding',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'recoverRegistryMutationStaging',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'writeFindingWriterProtocolManifest',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/lib/finding-registry-writer-authority.spec.ts',
      ],
    },
  ] as const satisfies readonly FindingWriterSensitiveImportAuthority[]);

/** Explicitly harmless runtime exports from modules that also own mutation authority. */
export const FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS =
  freezeFindingWriterSensitiveReadOnlyExports([
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'RegistryLockError' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'assertRegistryLockOwned' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'listAtomicWriteStagingFiles' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'ORPHAN_MD_HEADING_REGEX' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'readOrphanMarkdownStore' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'orphanMarkdownReservedIds' },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'orphanMarkdownReservedIdsFromText',
    },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'claimedSequences' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'nextFindingId' },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'findingIdHighWater' },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'readFindingWriterAllocationSnapshot',
    },
    { target: 'tools/gates/finding-registry.ts', symbol: 'registryMutationStagingFiles' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'reservedDomainFloorsFromManifest' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'allocationFloorForDomain' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'claimedIdsForDomain' },
    {
      target: 'tools/gates/lib/source-finding-publication-kernel.ts',
      symbol: 'SourceFindingPublicationCrash',
    },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'stableJson' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'sourceRefDigest' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'semanticRegistryValue' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'registryRecordChanged' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'extractRawFindingIds' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'extractAddedReviewEvidence' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'assertLiveMainCompatible' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'assertGitHubMainTransition' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'parseCliOptions' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'assertExecutionSafety' },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertFindingInventoryClosedSchema',
    },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'occurrenceId' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'materializeOccurrences' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'assertOccurrenceAssignments' },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertRefreshAssignmentTransition',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertCanonicalRebindsRetiredByRemoteDiscovery',
    },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'deriveReservedDomainFloors' },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'sourceAttestationsForRefresh' },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertPendingAdjudicationStates',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertStoredFindingInventoryIntegrity',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertLegacyFindingRefsResolvable',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertDiscoveryCandidateStable',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'parseSourceFindingPrettierConfig',
    },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'lockedPrettierVersion' },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertPrettierVersionAuthority',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertFormattedManifestSemantics',
    },
    { target: 'tools/gates/source-finding-inventory.ts', symbol: 'formatSourceFindingManifest' },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'assertNoLegacyPlanDirectorySourceFindingStaging',
    },
    {
      target: 'tools/gates/source-finding-inventory.ts',
      symbol: 'validateCommittedSourceFindingInventory',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_AUTHORITY_PATH',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_AUTHORITY_SCHEMA',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_AUTHORITY_SCHEMA_VERSION',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_PROTOCOL_ID',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_PUBLISHER',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_PUBLISHER_CREDENTIAL',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_LOCAL_FENCE',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_ENTRYPOINT_PATHS',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_RETIRED_MUTATION_SURFACES',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_DECLARED_ASSET_EDGES',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'createFindingWriterRepositorySnapshot',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'resolveFindingWriterGovernedPaths',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'buildFindingWriterProtocolManifest',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'renderFindingWriterProtocolManifest',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'parseFindingWriterProtocolManifest',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'verifyFindingWriterProtocolManifest',
    },
    {
      target: 'tools/gates/lib/finding-registry-writer-authority.ts',
      symbol: 'checkFindingWriterProtocolManifest',
    },
  ] as const satisfies readonly FindingWriterSensitiveReadOnlyExport[]);

export interface FindingWriterProtocolManifest {
  readonly $schema: typeof FINDING_WRITER_AUTHORITY_SCHEMA;
  readonly schema_version: typeof FINDING_WRITER_AUTHORITY_SCHEMA_VERSION;
  readonly protocol_id: typeof FINDING_WRITER_PROTOCOL_ID;
  readonly files: Readonly<Record<string, string>>;
  readonly repository_global_authority: {
    readonly kind: 'GITHUB_ACTIONS_OIDC_V1';
    readonly workflow_refs: readonly string[];
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
  readonly local_fence: typeof FINDING_WRITER_LOCAL_FENCE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  return (
    expected.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => expectedSet.has(key))
  );
}

function readJsonObject(
  path: string,
  snapshot: FindingWriterRepositorySnapshot,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.readText(path));
  } catch {
    throw new Error(`Finding writer parser authority is not valid JSON: ${path}`);
  }
  if (!isRecord(value)) {
    throw new Error(`Finding writer parser authority is not an object: ${path}`);
  }
  return value;
}

function exactParserVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Finding writer parser authority requires one exact version at ${field}`);
  }
  return value;
}

function assertFindingWriterParserAuthorities(snapshot: FindingWriterRepositorySnapshot): void {
  const packageDocument = readJsonObject('package.json', snapshot);
  const lockDocument = readJsonObject('package-lock.json', snapshot);
  const packageDevDependencies = packageDocument.devDependencies;
  const lockPackages = lockDocument.packages;
  if (!isRecord(packageDevDependencies) || !isRecord(lockPackages)) {
    throw new Error('Finding writer parser authority requires package and lock dependency objects');
  }
  const lockRoot = lockPackages[''];
  if (!isRecord(lockRoot) || !isRecord(lockRoot.devDependencies)) {
    throw new Error('Finding writer parser authority requires the root package-lock declaration');
  }

  for (const authority of FINDING_WRITER_PARSER_AUTHORITIES) {
    const packageVersion = exactParserVersion(
      packageDevDependencies[authority.packageName],
      `package.json#devDependencies.${authority.packageName}`,
    );
    const lockDeclarationVersion = exactParserVersion(
      lockRoot.devDependencies[authority.packageName],
      `package-lock.json#packages[""].devDependencies.${authority.packageName}`,
    );
    const lockPackage = lockPackages[`node_modules/${authority.packageName}`];
    if (!isRecord(lockPackage)) {
      throw new Error(
        `Finding writer parser authority is missing package-lock resolution for ${authority.packageName}`,
      );
    }
    const lockResolvedVersion = exactParserVersion(
      lockPackage.version,
      `package-lock.json#packages["node_modules/${authority.packageName}"].version`,
    );
    const versions = new Set([
      packageVersion,
      lockDeclarationVersion,
      lockResolvedVersion,
      authority.runtimeVersion,
    ]);
    if (versions.size !== 1) {
      throw new Error(
        `Finding writer parser authority mismatch for ${authority.packageName}: package=${packageVersion} lock-declaration=${lockDeclarationVersion} lock-resolution=${lockResolvedVersion} runtime=${authority.runtimeVersion}`,
      );
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryRelativePath(
  repoRoot: string,
  absolutePath: string,
  field: string,
  snapshot?: FindingWriterRepositorySnapshot,
): string {
  const lexicalRoot = resolve(repoRoot);
  const lexicalPath = resolve(absolutePath);
  const path = relative(lexicalRoot, lexicalPath).replaceAll('\\', '/');
  if (path.length === 0 || path === '..' || path.startsWith('../') || path.startsWith('/')) {
    throw new Error(`${field} escapes the repository root`);
  }
  if (snapshot !== undefined) {
    snapshot.realpath(lexicalPath);
    return path;
  }
  const rootStat = lstatSync(lexicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Finding writer repository root is not a real directory: ${lexicalRoot}`);
  }
  let cursor = lexicalRoot;
  for (const segment of path.split('/')) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Finding writer dependency path contains a symlink: ${field}`);
    }
  }
  const realRoot = realpathSync(lexicalRoot);
  const realPath = realpathSync(lexicalPath);
  const realRelative = relative(realRoot, realPath).replaceAll('\\', '/');
  if (
    realRelative.length === 0 ||
    realRelative === '..' ||
    realRelative.startsWith('../') ||
    realRelative.startsWith('/')
  ) {
    throw new Error(`${field} resolves outside the repository root`);
  }
  return path;
}

function regularFilesBelow(
  repoRoot: string,
  relativePath: string,
  snapshot: FindingWriterRepositorySnapshot,
): string[] {
  const absolutePath = resolve(repoRoot, relativePath);
  if (snapshot.fileExists(absolutePath)) {
    return [repositoryRelativePath(repoRoot, absolutePath, relativePath, snapshot)];
  }
  if (!snapshot.directoryExists(absolutePath)) {
    throw new Error(
      `Finding writer dependency is not a regular file or directory: ${relativePath}`,
    );
  }

  const files: string[] = [];
  const visitDirectory = (directory: string): void => {
    const directoryRelative = repositoryRelativePath(repoRoot, directory, relativePath, snapshot);
    for (const entry of snapshot.directoryEntries(directoryRelative)) {
      const child = resolve(directory, entry.name);
      const childRelative = repositoryRelativePath(repoRoot, child, relativePath, snapshot);
      if (entry.kind === 'DIRECTORY') {
        visitDirectory(child);
      } else {
        files.push(childRelative);
      }
    }
  };
  visitDirectory(absolutePath);
  if (files.length === 0) {
    throw new Error(`Finding writer local action directory is empty: ${relativePath}`);
  }
  return files.sort(compareText);
}

function localUsesFromYaml(raw: string, path: string): string[] {
  if (!/\.ya?ml$/i.test(path)) return [];
  const document: unknown = YAML.parse(raw);
  const localUses = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'uses' && typeof entry === 'string' && entry.startsWith('./')) {
        localUses.add(entry);
      }
      visit(entry);
    }
  };
  visit(document);
  return [...localUses].sort(compareText);
}

function yamlRunCommands(raw: string, path: string): string[] {
  if (!/\.ya?ml$/i.test(path)) return [];
  const document: unknown = YAML.parse(raw);
  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'run' && typeof entry === 'string') commands.push(entry);
      visit(entry);
    }
  };
  visit(document);
  return commands;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ParsedPackageScriptCommand {
  readonly projectPath: string;
  readonly executablePath: string;
  readonly arguments: readonly string[];
}

function packageScripts(packageRaw: string, packagePath: string): Readonly<Record<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(packageRaw);
  } catch {
    throw new Error(`Finding writer package-script authority is not valid JSON: ${packagePath}`);
  }
  if (!isRecord(value) || !isRecord(value.scripts)) {
    throw new Error(
      `Finding writer package-script authority has no scripts object: ${packagePath}`,
    );
  }
  const scripts: Record<string, string> = {};
  for (const [script, command] of Object.entries(value.scripts)) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error(`Finding writer package-script authority has an invalid script: ${script}`);
    }
    scripts[script] = command;
  }
  return scripts;
}

function parseClosedTsNodePackageCommand(
  command: string,
  script: string,
): ParsedPackageScriptCommand | null {
  const referencesMutationExecutable = FINDING_WRITER_CLI_COMMAND_CONTRACT.some((authority) =>
    command.includes(authority.executablePath),
  );
  if (/[;&|><`$()'"\\]/.test(command)) {
    if (referencesMutationExecutable) {
      throw new Error(
        `Finding writer package-script command uses an unsupported executable grammar: ${script}`,
      );
    }
    return null;
  }
  const tokens = command.trim().split(/\s+/);
  const [runtime, projectFlag, projectPath, executablePath, ...arguments_] = tokens;
  if (runtime !== 'ts-node') {
    if (referencesMutationExecutable) {
      throw new Error(
        `Finding writer mutation executable must use the closed ts-node grammar: ${script}`,
      );
    }
    return null;
  }
  if (
    projectFlag !== '--project' ||
    projectPath === undefined ||
    executablePath === undefined ||
    !/^[A-Za-z0-9_./-]+\.json$/.test(projectPath) ||
    !/^[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/.test(executablePath) ||
    arguments_.some(
      (argument) =>
        !/^(?:--?[a-z][a-z-]*(?:=[A-Za-z0-9._:/-]+)?|[A-Za-z0-9._:/-]+)$/.test(argument),
    )
  ) {
    throw new Error(
      `Finding writer package-script command uses an unsupported executable grammar: ${script}`,
    );
  }
  return { projectPath, executablePath, arguments: Object.freeze(arguments_) };
}

function literalPackageScriptReferences(command: string, script: string): readonly string[] {
  if (/\bnpm\s+run\s+(?:["']?\$|\$\{)/.test(command)) {
    throw new Error(`Finding writer package-script alias must name one literal script: ${script}`);
  }
  const references: string[] = [];
  const pattern = /\bnpm\s+run\s+(?:"([A-Za-z0-9:_-]+)"|'([A-Za-z0-9:_-]+)'|([A-Za-z0-9:_-]+))/g;
  for (const match of command.matchAll(pattern)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

interface FindingWriterPackageScriptAuthority {
  readonly writerScripts: readonly string[];
  readonly mutationScripts: readonly string[];
}

function discoveredFindingWriterPackageScripts(
  packageRaw: string,
  packagePath: string,
): FindingWriterPackageScriptAuthority {
  const scripts = packageScripts(packageRaw, packagePath);
  const writers = new Set<string>();
  const mutations = new Set<string>();
  const aliases = new Map<string, readonly string[]>();
  for (const [script, command] of Object.entries(scripts)) {
    const parsed = parseClosedTsNodePackageCommand(command, script);
    if (parsed !== null && isFindingWriterCliExecutablePath(parsed.executablePath)) {
      writers.add(script);
      const admission = admitFindingWriterCliInvocation(parsed.executablePath, parsed.arguments);
      if (admission.mutationClass === 'MUTATION') mutations.add(script);
    }
    aliases.set(script, literalPackageScriptReferences(command, script));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [script, references] of aliases) {
      if (!writers.has(script) && references.some((reference) => writers.has(reference))) {
        writers.add(script);
        changed = true;
      }
      if (!mutations.has(script) && references.some((reference) => mutations.has(reference))) {
        mutations.add(script);
        changed = true;
      }
    }
  }
  for (const script of writers) {
    const command = scripts[script];
    const parsed = command === undefined ? null : parseClosedTsNodePackageCommand(command, script);
    if (parsed !== null && isFindingWriterCliExecutablePath(parsed.executablePath)) continue;
    const references = aliases.get(script) ?? [];
    if (references.length !== 1 || command === undefined) {
      throw new Error(`Finding writer package-script alias is not one closed edge: ${script}`);
    }
    const reference = references[0] ?? '';
    const aliasPattern = new RegExp(
      `^npm\\s+run\\s+${escapeRegularExpression(reference)}(?:\\s+--(?:\\s+--?[A-Za-z0-9._:/=-]+)*)?$`,
    );
    if (!aliasPattern.test(command.trim())) {
      throw new Error(
        `Finding writer package-script alias uses an open command grammar: ${script}`,
      );
    }
  }
  return Object.freeze({
    writerScripts: Object.freeze([...writers].sort(compareText)),
    mutationScripts: Object.freeze([...mutations].sort(compareText)),
  });
}

function assertExactStringSet(
  identity: string,
  expectedValues: Iterable<string>,
  actualValues: Iterable<string>,
): void {
  const expected = [...new Set(expectedValues)].sort(compareText);
  const actual = [...new Set(actualValues)].sort(compareText);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((value) => !actualSet.has(value));
    const unknown = actual.filter((value) => !expectedSet.has(value));
    throw new Error(
      `Finding writer ${identity} differs from its declared SSOT; missing=${missing.join(',') || '<none>'}; unknown=${unknown.join(',') || '<none>'}`,
    );
  }
}

function workflowPackageScriptInvocations(
  raw: string,
  path: string,
  observedScripts: ReadonlySet<string>,
): string[] {
  const invocations: string[] = [];
  for (const command of yamlRunCommands(raw, path)) {
    const normalizedCommand = command.replace(/\\\r?\n\s*/g, ' ');
    for (const executable of FINDING_WRITER_CLI_COMMAND_CONTRACT) {
      const executableIndex = normalizedCommand.indexOf(executable.executablePath);
      if (executableIndex < 0) continue;
      const arguments_ = normalizedCommand
        .slice(executableIndex + executable.executablePath.length)
        .trim()
        .split(/\s+/)
        .filter((argument) => argument.length > 0);
      const admission = admitFindingWriterCliInvocation(executable.executablePath, arguments_);
      if (admission.mutationClass === 'MUTATION') {
        throw new Error(`Finding writer workflow contains a direct mutation executable: ${path}`);
      }
    }
    for (const rawLine of command.split(/\r?\n/)) {
      const line = rawLine.trim();
      const matches = [...line.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)];
      for (const match of matches) {
        const script = match[1];
        if (script === undefined || !observedScripts.has(script)) continue;
        const invocation = new RegExp(
          `^npm\\s+run\\s+${escapeRegularExpression(script)}(?:\\s+--)?(?:\\s+(?:"\\$\\{[A-Z][A-Z0-9_]*\\}"|\\$\\{[A-Z][A-Z0-9_]*\\}|--[a-z][a-z-]*=\\$\\{[A-Z][A-Z0-9_]*\\}|--?[A-Za-z0-9._:/=-]+))*$`,
        );
        if (!invocation.test(line) || /(?:\|\||&&|[|;><`]|\$\()/.test(line)) {
          throw new Error(
            `Finding writer workflow mutation/package invocation is compound or dynamic in ${path}: ${line}`,
          );
        }
        invocations.push(script);
      }
    }
  }
  return invocations;
}

function packageScriptExecutablePaths(
  packageRaw: string,
  packagePath: string,
  script: string,
  stack: readonly string[] = [],
): string[] {
  if (stack.includes(script)) {
    throw new Error(
      `Finding writer package-script alias cycle: ${[...stack, script].join(' -> ')}`,
    );
  }
  const scripts = packageScripts(packageRaw, packagePath);
  const command = scripts[script];
  if (command === undefined) {
    throw new Error(`Finding writer package-script authority is missing script: ${script}`);
  }
  const parsed = parseClosedTsNodePackageCommand(command, script);
  if (parsed !== null && isFindingWriterCliExecutablePath(parsed.executablePath)) {
    return [parsed.projectPath, parsed.executablePath];
  }
  const references = literalPackageScriptReferences(command, script);
  if (references.length !== 1) {
    throw new Error(`Finding writer package-script command has no closed executable: ${script}`);
  }
  return packageScriptExecutablePaths(packageRaw, packagePath, references[0] ?? '', [
    ...stack,
    script,
  ]);
}

function resolveLocalUse(
  repoRoot: string,
  localUse: string,
  importer: string,
  snapshot: FindingWriterRepositorySnapshot,
): string[] {
  const normalized = localUse.slice(2).replaceAll('\\', '/').replace(/\/$/, '');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('.github/workflows/') &&
    /\.ya?ml$/i.test(normalized) &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  ) {
    const workflowPath = resolve(repoRoot, normalized);
    if (!snapshot.fileExists(workflowPath)) {
      throw new Error(`Finding writer reusable workflow is missing in ${importer}: ${localUse}`);
    }
    return [repositoryRelativePath(repoRoot, workflowPath, `${importer} -> ${localUse}`, snapshot)];
  }
  if (
    normalized.length === 0 ||
    !normalized.startsWith('.github/actions/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Finding writer local uses edge is invalid in ${importer}: ${localUse}`);
  }
  const actionDirectory = resolve(repoRoot, normalized);
  repositoryRelativePath(repoRoot, actionDirectory, `${importer} -> ${localUse}`, snapshot);
  const actionManifests = ['action.yml', 'action.yaml'].filter((name) =>
    snapshot.fileExists(resolve(actionDirectory, name)),
  );
  if (actionManifests.length !== 1) {
    throw new Error(
      `Finding writer local action must contain exactly one action.yml or action.yaml: ${localUse}`,
    );
  }
  const manifestPath = resolve(actionDirectory, actionManifests[0] ?? '');
  const manifestRelativePath = repositoryRelativePath(repoRoot, manifestPath, localUse, snapshot);
  const manifest: unknown = YAML.parse(snapshot.readText(manifestRelativePath));
  if (!isRecord(manifest) || !isRecord(manifest.runs) || manifest.runs.using !== 'composite') {
    throw new Error(`Finding writer local action must use the composite runtime: ${localUse}`);
  }
  return regularFilesBelow(repoRoot, normalized, snapshot);
}

function literalModuleSpecifiers(raw: string, path: string): string[] {
  if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path))) {
    return [];
  }
  const extension = extname(path);
  const scriptKind =
    extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : ['.js', '.mjs', '.cjs'].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, scriptKind);
  const syntaxCheckPath = path.endsWith('.d.ts') ? `${path.slice(0, -5)}.ts` : path;
  const parseDiagnostics = ts.transpileModule(raw, {
    compilerOptions: { allowJs: true },
    fileName: syntaxCheckPath,
    reportDiagnostics: true,
  }).diagnostics;
  if (parseDiagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Finding writer module dependency source is not parseable: ${path}`);
  }
  const specifiers = new Set<string>();
  const addLoader = (value: ts.Expression | undefined, loader: string): void => {
    if (value === undefined || !ts.isStringLiteralLike(value)) {
      throw new Error(`Finding writer ${loader} edge must use one literal module in ${path}`);
    }
    specifiers.add(value.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      } else if (node.moduleSpecifier !== undefined) {
        throw new Error(`Finding writer import/export edge must be literal in ${path}`);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLoader(node.moduleReference.expression, 'import-equals');
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      addLoader(node.arguments[0], 'dynamic loader');
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'require' &&
      node.expression.name.text === 'resolve'
    ) {
      addLoader(node.arguments[0], 'require.resolve');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const reference of source.referencedFiles) {
    if (!reference.fileName.startsWith('.')) {
      throw new Error(`Finding writer triple-slash path must be relative in ${path}`);
    }
    specifiers.add(reference.fileName);
  }
  return [...specifiers].sort(compareText);
}

function resolveRepositoryModuleWithOptions(
  repoRoot: string,
  importer: string,
  specifier: string,
  snapshot: FindingWriterRepositorySnapshot,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const importerPath = resolve(repoRoot, importer);
  const isRepositoryPath = (path: string): boolean => {
    const candidate = relative(resolve(repoRoot), resolve(path)).replaceAll('\\', '/');
    return (
      candidate.length === 0 ||
      (candidate !== '..' && !candidate.startsWith('../') && !candidate.startsWith('/'))
    );
  };
  const resolution = ts.resolveModuleName(specifier, importerPath, compilerOptions, {
    fileExists: (path) => isRepositoryPath(path) && snapshot.fileExists(path),
    readFile: (path) => {
      if (!isRepositoryPath(path)) return undefined;
      const relativePath = repositoryRelativePath(
        repoRoot,
        path,
        `${importer} -> ${specifier}`,
        snapshot,
      );
      return snapshot.readText(relativePath);
    },
    directoryExists: (path) => isRepositoryPath(path) && snapshot.directoryExists(path),
    getCurrentDirectory: () => repoRoot,
    getDirectories: (path) => (isRepositoryPath(path) ? snapshot.getDirectories(path) : []),
    realpath: (path) => (isRepositoryPath(path) ? snapshot.realpath(path) : path),
    useCaseSensitiveFileNames: true,
  }).resolvedModule;
  if (resolution === undefined) return null;
  const resolvedPath = repositoryRelativePath(
    repoRoot,
    resolution.resolvedFileName,
    `${importer} -> ${specifier}`,
    snapshot,
  );
  return resolvedPath === 'node_modules' || resolvedPath.startsWith('node_modules/')
    ? null
    : resolvedPath;
}

function addFindingWriterSensitiveAlias(
  aliases: Set<string>,
  aliasPattern: string,
  normalizedTargetPattern: string,
  targets: readonly string[],
  field: string,
): void {
  for (const target of targets) {
    const normalizedTarget = target.replace(/\.[cm]?[jt]sx?$/, '');
    const wildcardIndex = normalizedTargetPattern.indexOf('*');
    let alias: string | null = null;
    if (wildcardIndex < 0) {
      if (normalizedTargetPattern === normalizedTarget && !aliasPattern.includes('*')) {
        alias = aliasPattern;
      }
    } else {
      if (
        normalizedTargetPattern.indexOf('*', wildcardIndex + 1) >= 0 ||
        aliasPattern.indexOf('*') !== aliasPattern.lastIndexOf('*')
      ) {
        throw new Error(`Finding writer module alias has an unsupported wildcard shape: ${field}`);
      }
      const prefix = normalizedTargetPattern.slice(0, wildcardIndex);
      const suffix = normalizedTargetPattern.slice(wildcardIndex + 1);
      if (
        normalizedTarget.startsWith(prefix) &&
        normalizedTarget.endsWith(suffix) &&
        aliasPattern.includes('*')
      ) {
        const substitution = normalizedTarget.slice(
          prefix.length,
          normalizedTarget.length - suffix.length,
        );
        alias = aliasPattern.replace('*', substitution);
      }
    }
    if (alias === null) continue;
    aliases.add(alias);
  }
}

function findingWriterAliasStringTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(findingWriterAliasStringTargets);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(findingWriterAliasStringTargets);
}

function findingWriterSensitiveAliases(
  repoRoot: string,
  targets: Iterable<string>,
  snapshot: FindingWriterRepositorySnapshot,
): Set<string> {
  const targetPaths = [...targets].sort(compareText);
  const aliases = new Set<string>();
  const configurationPaths = repositoryFindingWriterConfigurationPaths(snapshot);
  for (const config of findingWriterCompilerConfigAuthority(repoRoot, snapshot).resolutions) {
    const baseUrl = config.options.baseUrl ?? resolve(repoRoot, dirname(config.path));
    for (const [aliasPattern, targetPatterns] of Object.entries(config.options.paths ?? {})) {
      for (const targetPattern of targetPatterns) {
        const normalizedTargetPattern = relative(repoRoot, resolve(baseUrl, targetPattern))
          .replaceAll('\\', '/')
          .replace(/\.[cm]?[jt]sx?$/, '');
        addFindingWriterSensitiveAlias(
          aliases,
          aliasPattern,
          normalizedTargetPattern,
          targetPaths,
          `${config.path}#effectiveCompilerOptions.paths.${aliasPattern}`,
        );
      }
    }
  }
  for (const packagePath of configurationPaths.packages) {
    const packageDocument = readJsonObject(packagePath, snapshot);
    const packageDirectory = resolve(repoRoot, dirname(packagePath));
    if (isRecord(packageDocument.imports)) {
      for (const [aliasPattern, targetValue] of Object.entries(packageDocument.imports)) {
        for (const targetPattern of findingWriterAliasStringTargets(targetValue)) {
          if (!targetPattern.startsWith('./')) continue;
          addFindingWriterSensitiveAlias(
            aliases,
            aliasPattern,
            relative(repoRoot, resolve(packageDirectory, targetPattern))
              .replaceAll('\\', '/')
              .replace(/\.[cm]?[jt]sx?$/, ''),
            targetPaths,
            `${packagePath}#imports.${aliasPattern}`,
          );
        }
      }
    }
    if (typeof packageDocument.name !== 'string' || packageDocument.name.length === 0) continue;
    const packageName = packageDocument.name;
    const addPackageExport = (subpath: string, value: unknown): void => {
      const aliasPattern = subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`;
      for (const targetPattern of findingWriterAliasStringTargets(value)) {
        if (!targetPattern.startsWith('./')) continue;
        addFindingWriterSensitiveAlias(
          aliases,
          aliasPattern,
          relative(repoRoot, resolve(packageDirectory, targetPattern))
            .replaceAll('\\', '/')
            .replace(/\.[cm]?[jt]sx?$/, ''),
          targetPaths,
          `${packagePath}#exports.${subpath}`,
        );
      }
    };
    if (isRecord(packageDocument.exports)) {
      const subpaths = Object.keys(packageDocument.exports).filter((key) => key.startsWith('.'));
      if (subpaths.length === 0) addPackageExport('.', packageDocument.exports);
      else {
        for (const subpath of subpaths) addPackageExport(subpath, packageDocument.exports[subpath]);
      }
    } else if (packageDocument.exports !== undefined) {
      addPackageExport('.', packageDocument.exports);
    }
  }
  return aliases;
}

const FINDING_WRITER_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const FINDING_WRITER_REVERSE_SCAN_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.nx',
  '.pytest_cache',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

function repositoryFindingWriterSourcePaths(snapshot: FindingWriterRepositorySnapshot): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of snapshot.directoryEntries(directory)) {
      const child = directory.length === 0 ? entry.name : `${directory}/${entry.name}`;
      if (entry.kind === 'DIRECTORY') {
        if (!FINDING_WRITER_REVERSE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) visit(child);
      } else if (FINDING_WRITER_SOURCE_EXTENSIONS.has(extname(entry.name))) {
        paths.push(child);
      }
    }
  };
  visit('');
  return paths.sort(compareText);
}

function repositoryFindingWriterConfigurationPaths(snapshot: FindingWriterRepositorySnapshot): {
  readonly tsconfigs: readonly string[];
  readonly packages: readonly string[];
} {
  const tsconfigs: string[] = [];
  const packages: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of snapshot.directoryEntries(directory)) {
      const child = directory.length === 0 ? entry.name : `${directory}/${entry.name}`;
      if (entry.kind === 'DIRECTORY') {
        if (!FINDING_WRITER_REVERSE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) visit(child);
      } else if (/^tsconfig(?:\.[^/]*)?\.json$/.test(entry.name)) {
        tsconfigs.push(child);
      } else if (entry.name === 'package.json') {
        packages.push(child);
      }
    }
  };
  visit('');
  return {
    tsconfigs: Object.freeze(tsconfigs.sort(compareText)),
    packages: Object.freeze(packages.sort(compareText)),
  };
}

interface FindingWriterCompilerConfigResolution {
  readonly path: string;
  readonly scope: string;
  readonly options: ts.CompilerOptions;
}

interface FindingWriterCompilerConfigAuthority {
  readonly resolutions: readonly FindingWriterCompilerConfigResolution[];
  readonly authorityPaths: readonly string[];
}

const findingWriterCompilerConfigAuthorityCache = new WeakMap<
  FindingWriterRepositorySnapshot,
  FindingWriterCompilerConfigAuthority
>();

function findingWriterPatternSubstitution(pattern: string, value: string): string | null {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex < 0) return pattern === value ? '' : null;
  if (pattern.indexOf('*', wildcardIndex + 1) >= 0) {
    throw new Error(`Finding writer module alias has multiple wildcards: ${pattern}`);
  }
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return value.startsWith(prefix) && value.endsWith(suffix)
    ? value.slice(prefix.length, value.length - suffix.length)
    : null;
}

function findingWriterCompilerConfigAuthority(
  repoRoot: string,
  snapshot: FindingWriterRepositorySnapshot,
): FindingWriterCompilerConfigAuthority {
  const cached = findingWriterCompilerConfigAuthorityCache.get(snapshot);
  if (cached !== undefined) return cached;

  const rootConfigs = repositoryFindingWriterConfigurationPaths(snapshot).tsconfigs;
  const parsedConfigs = new Map<string, Record<string, unknown>>();
  const effectiveOptions = new Map<string, ts.CompilerOptions>();
  const authorityPaths = new Set<string>();

  const parsedConfig = (path: string): Record<string, unknown> => {
    const prior = parsedConfigs.get(path);
    if (prior !== undefined) return prior;
    const parsed = ts.parseConfigFileTextToJson(path, snapshot.readText(path));
    if (parsed.error !== undefined || !isRecord(parsed.config)) {
      throw new Error(`Finding writer compiler config is invalid: ${path}`);
    }
    parsedConfigs.set(path, parsed.config);
    authorityPaths.add(path);
    return parsed.config;
  };

  const resolveExtendedConfig = (path: string, value: unknown): string => {
    if (typeof value !== 'string' || !value.startsWith('.')) {
      throw new Error(
        `Finding writer compiler config forbids unknown non-relative extends: ${path}`,
      );
    }
    const unresolved = resolve(repoRoot, dirname(path), value);
    const candidates = (
      extname(unresolved) === '.json'
        ? [unresolved]
        : [unresolved, `${unresolved}.json`, resolve(unresolved, 'tsconfig.json')]
    ).filter(
      (candidate, index, all) => all.indexOf(candidate) === index && snapshot.fileExists(candidate),
    );
    if (candidates.length === 0) {
      throw new Error(
        `Finding writer compiler config extends target is missing: ${path} -> ${value}`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `Finding writer compiler config extends target is ambiguous: ${path} -> ${value}`,
      );
    }
    return repositoryRelativePath(
      repoRoot,
      candidates[0] ?? '',
      `${path} extends ${value}`,
      snapshot,
    );
  };

  const compileEffectiveOptions = (path: string, stack: readonly string[]): ts.CompilerOptions => {
    const prior = effectiveOptions.get(path);
    if (prior !== undefined) return prior;
    if (stack.includes(path)) {
      throw new Error(
        `Finding writer compiler config extends cycle: ${[...stack, path].join(' -> ')}`,
      );
    }
    const config = parsedConfig(path);
    const rawExtends = config.extends;
    const extendsValues =
      rawExtends === undefined
        ? []
        : typeof rawExtends === 'string'
          ? [rawExtends]
          : Array.isArray(rawExtends)
            ? rawExtends
            : null;
    if (extendsValues === null) {
      throw new Error(`Finding writer compiler config has malformed extends: ${path}`);
    }
    const extendedPaths = extendsValues.map((value) => resolveExtendedConfig(path, value));
    if (new Set(extendedPaths).size !== extendedPaths.length) {
      throw new Error(`Finding writer compiler config repeats one extends authority: ${path}`);
    }
    let options: ts.CompilerOptions = {};
    for (const extendedPath of extendedPaths) {
      options = {
        ...options,
        ...compileEffectiveOptions(extendedPath, [...stack, path]),
      };
    }
    const converted = ts.convertCompilerOptionsFromJson(
      isRecord(config.compilerOptions) ? config.compilerOptions : {},
      resolve(repoRoot, dirname(path)),
      path,
    );
    if (
      converted.errors.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    ) {
      throw new Error(`Finding writer compiler config is not parseable: ${path}`);
    }
    const compiled = Object.freeze({
      ...options,
      ...converted.options,
      allowJs: true,
      moduleResolution:
        converted.options.moduleResolution ??
        options.moduleResolution ??
        ts.ModuleResolutionKind.Node10,
      resolveJsonModule: true,
    });
    effectiveOptions.set(path, compiled);
    return compiled;
  };

  const resolutions = Object.freeze(
    rootConfigs.map((path) =>
      Object.freeze({
        path,
        scope: dirname(path) === '.' ? '' : dirname(path).replaceAll('\\', '/'),
        options: compileEffectiveOptions(path, []),
      }),
    ),
  );
  const authority = Object.freeze({
    resolutions,
    authorityPaths: Object.freeze([...authorityPaths].sort(compareText)),
  });
  findingWriterCompilerConfigAuthorityCache.set(snapshot, authority);
  return authority;
}

function findingWriterPathWithinScope(path: string, scope: string): boolean {
  return scope.length === 0 || path === scope || path.startsWith(`${scope}/`);
}

function resolveFindingWriterPackageAlias(
  repoRoot: string,
  importer: string,
  specifier: string,
  snapshot: FindingWriterRepositorySnapshot,
): string | null {
  const packages = repositoryFindingWriterConfigurationPaths(snapshot)
    .packages.map((path) => ({ path, scope: dirname(path) === '.' ? '' : dirname(path) }))
    .filter((entry) => findingWriterPathWithinScope(importer, entry.scope))
    .sort((left, right) => right.scope.length - left.scope.length);
  const nearestScopeLength = packages[0]?.scope.length;
  if (nearestScopeLength === undefined) return null;
  const resolvedTargets = new Set<string>();
  for (const entry of packages.filter(
    (candidate) => candidate.scope.length === nearestScopeLength,
  )) {
    const document = readJsonObject(entry.path, snapshot);
    const mappings: { readonly pattern: string; readonly value: unknown }[] = [];
    if (isRecord(document.imports)) {
      for (const [pattern, value] of Object.entries(document.imports)) {
        mappings.push({ pattern, value });
      }
    }
    if (typeof document.name === 'string' && document.name.length > 0) {
      const exportsValue = document.exports;
      if (isRecord(exportsValue) && Object.keys(exportsValue).some((key) => key.startsWith('.'))) {
        for (const [subpath, value] of Object.entries(exportsValue)) {
          if (!subpath.startsWith('.')) continue;
          mappings.push({
            pattern: subpath === '.' ? document.name : `${document.name}${subpath.slice(1)}`,
            value,
          });
        }
      } else if (exportsValue !== undefined) {
        mappings.push({ pattern: document.name, value: exportsValue });
      }
    }
    for (const mapping of mappings) {
      const substitution = findingWriterPatternSubstitution(mapping.pattern, specifier);
      if (substitution === null) continue;
      for (const rawTarget of findingWriterAliasStringTargets(mapping.value)) {
        if (!rawTarget.startsWith('./')) continue;
        const substitutedTarget = rawTarget.replace('*', substitution);
        const unresolved = resolve(repoRoot, entry.scope, substitutedTarget);
        for (const candidate of [
          unresolved,
          ...[...FINDING_WRITER_SOURCE_EXTENSIONS].map((extension) => `${unresolved}${extension}`),
          ...[...FINDING_WRITER_SOURCE_EXTENSIONS].map((extension) =>
            resolve(unresolved, `index${extension}`),
          ),
        ]) {
          if (!snapshot.fileExists(candidate)) continue;
          resolvedTargets.add(
            repositoryRelativePath(repoRoot, candidate, `${entry.path} -> ${specifier}`, snapshot),
          );
          break;
        }
      }
    }
  }
  if (resolvedTargets.size > 1) {
    throw new Error(
      `Finding writer package alias resolves ambiguously: ${importer} -> ${specifier}`,
    );
  }
  return [...resolvedTargets][0] ?? null;
}

function resolveFindingWriterLiteralModule(
  repoRoot: string,
  importer: string,
  specifier: string,
  snapshot: FindingWriterRepositorySnapshot,
): string | null {
  const relativeSpecifier = specifier.startsWith('.');
  const owningConfigs = findingWriterCompilerConfigAuthority(repoRoot, snapshot).resolutions.filter(
    (config) => findingWriterPathWithinScope(importer, config.scope),
  );
  const nearestScopeLength = Math.max(-1, ...owningConfigs.map((config) => config.scope.length));
  const nearestConfigs = owningConfigs.filter(
    (candidate) => candidate.scope.length === nearestScopeLength,
  );
  const configResolutions = nearestConfigs.map((config) =>
    resolveRepositoryModuleWithOptions(repoRoot, importer, specifier, snapshot, config.options),
  );
  const localConfigResolutions = new Set(
    configResolutions.filter((resolution): resolution is string => resolution !== null),
  );
  if (localConfigResolutions.size > 1) {
    throw new Error(
      `Finding writer nearest compiler configs resolve ambiguously: ${importer} -> ${specifier}`,
    );
  }
  if (relativeSpecifier) {
    const resolution = [...localConfigResolutions][0];
    if (resolution === undefined) {
      throw new Error(`Finding writer module edge ${importer} -> ${specifier} did not resolve`);
    }
    return resolution;
  }
  const resolutions = new Set<string>();
  for (const resolution of localConfigResolutions) resolutions.add(resolution);
  const packageResolution = resolveFindingWriterPackageAlias(
    repoRoot,
    importer,
    specifier,
    snapshot,
  );
  if (packageResolution !== null) resolutions.add(packageResolution);
  if (resolutions.size > 1) {
    throw new Error(`Finding writer local module edge is ambiguous: ${importer} -> ${specifier}`);
  }
  return [...resolutions][0] ?? null;
}

function findingWriterScriptKind(path: string): ts.ScriptKind {
  const extension = extname(path);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function staticLoaderBindingSymbols(node: ts.CallExpression): string[] {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return [parent.name.text];
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === node &&
    parent.argumentExpression !== undefined &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return [parent.argumentExpression.text];
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    if (ts.isObjectBindingPattern(parent.name)) {
      return parent.name.elements.map((element) => {
        if (element.dotDotDotToken !== undefined) return '*';
        return element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.getText();
      });
    }
  }
  return ['*'];
}

function expressionStringFragments(expression: ts.Expression): string[] {
  const fragments: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) fragments.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return fragments;
}

interface FindingWriterObservedImport {
  readonly specifier: string;
  readonly symbols: readonly string[];
}

function exportedFindingWriterRuntimeSymbols(raw: string, path: string): string[] {
  const source = ts.createSourceFile(
    path,
    raw,
    ts.ScriptTarget.Latest,
    true,
    findingWriterScriptKind(path),
  );
  const symbols = new Set<string>();
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
  const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const isDeclared = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DeclareKeyword);
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      symbols.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingName(element.name);
    }
  };
  const isModuleExports = (expression: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'module' &&
      expression.name.text === 'exports') ||
    (ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'module' &&
      expression.argumentExpression !== undefined &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      expression.argumentExpression.text === 'exports');
  const isCommonJsExportTarget = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression) && expression.text === 'exports') return true;
    if (isModuleExports(expression)) return true;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return isCommonJsExportTarget(expression.expression);
    }
    return false;
  };
  const rejectCommonJsEscape = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isCommonJsExportTarget(node.left)
    ) {
      throw new Error(`Finding writer sensitive module forbids CommonJS export mutation: ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'assign' ||
        node.expression.name.text === 'defineProperty' ||
        node.expression.name.text === 'defineProperties') &&
      node.arguments[0] !== undefined &&
      isCommonJsExportTarget(node.arguments[0])
    ) {
      throw new Error(`Finding writer sensitive module forbids CommonJS export mutation: ${path}`);
    }
    ts.forEachChild(node, rejectCommonJsEscape);
  };
  rejectCommonJsEscape(source);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined) {
        const hasRuntimeExport =
          clause === undefined ||
          ts.isNamespaceExport(clause) ||
          clause.elements.some((element) => !element.isTypeOnly);
        if (hasRuntimeExport) {
          throw new Error(
            `Finding writer sensitive module forbids runtime re-export edges: ${path}`,
          );
        }
        continue;
      }
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        throw new Error(`Finding writer sensitive module has an unbounded export: ${path}`);
      }
      for (const element of clause.elements) {
        if (!element.isTypeOnly) symbols.add(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      symbols.add('default');
      continue;
    }
    if (!isExported(statement) || isDeclared(statement)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (isDefault(statement)) symbols.add('default');
      else if (statement.name !== undefined) symbols.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingName(declaration.name);
      }
      continue;
    }
    if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      symbols.add(statement.name.getText(source));
    }
  }
  return [...symbols].sort(compareText);
}

function observedFindingWriterImports(
  raw: string,
  path: string,
  sensitiveBasenames: ReadonlySet<string>,
  sensitiveAliases: ReadonlySet<string>,
  sensitiveSymbols: ReadonlySet<string>,
): FindingWriterObservedImport[] {
  const namesSensitiveSurface =
    [...sensitiveBasenames].some((basename) => raw.includes(basename)) ||
    [...sensitiveAliases].some((alias) => raw.includes(alias)) ||
    [...sensitiveSymbols].some((symbol) => raw.includes(symbol));
  const mayContainUnknownRelativeLoader =
    /\b(?:require|import)\s*\(/.test(raw) && /['"`]\.\.?\//.test(raw);
  if (!namesSensitiveSurface && !mayContainUnknownRelativeLoader) return [];
  const source = ts.createSourceFile(
    path,
    raw,
    ts.ScriptTarget.Latest,
    true,
    findingWriterScriptKind(path),
  );
  const imports: FindingWriterObservedImport[] = [];
  const addStatic = (specifier: string, symbols: readonly string[]): void => {
    const normalizedSpecifier = specifier.replace(/\.[cm]?[jt]sx?$/, '');
    const basename = normalizedSpecifier.split('/').at(-1) ?? '';
    const namesSensitiveSymbol = symbols.some((symbol) => sensitiveSymbols.has(symbol));
    if (
      !sensitiveBasenames.has(basename) &&
      !sensitiveAliases.has(specifier) &&
      !namesSensitiveSymbol
    ) {
      return;
    }
    if (!specifier.startsWith('.') && !sensitiveAliases.has(specifier)) {
      throw new Error(
        `Finding writer sensitive symbol/module edge has no governed local alias in ${path}: ${specifier}`,
      );
    }
    imports.push({ specifier, symbols: Object.freeze([...symbols]) });
  };
  const rejectUnknownLoader = (expression: ts.Expression | undefined, loader: string): void => {
    if (expression === undefined) {
      throw new Error(`Finding writer ${loader} has no module expression in ${path}`);
    }
    const fragments = expressionStringFragments(expression);
    if (
      fragments.some(
        (fragment) =>
          fragment.startsWith('.') ||
          [...sensitiveBasenames].some((basename) => fragment.includes(basename)),
      ) ||
      [...sensitiveBasenames].some((basename) => raw.includes(basename)) ||
      [...sensitiveSymbols].some((symbol) => raw.includes(symbol))
    ) {
      throw new Error(
        `Finding writer dynamic relative/sensitive-module edge must use one literal module in ${path}`,
      );
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
        throw new Error(`Finding writer import edge must use one literal module in ${path}`);
      }
      const symbols: string[] = [];
      const clause = node.importClause;
      if (clause === undefined) {
        symbols.push('*');
      } else {
        if (clause.name !== undefined) symbols.push('default');
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) symbols.push('*');
          else {
            for (const element of bindings.elements) {
              symbols.push(element.propertyName?.text ?? element.name.text);
            }
          }
        }
      }
      addStatic(node.moduleSpecifier.text, symbols);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
        throw new Error(`Finding writer export edge must use one literal module in ${path}`);
      }
      const clause = node.exportClause;
      const symbols =
        clause === undefined || ts.isNamespaceExport(clause)
          ? ['*']
          : clause.elements.map((element) => element.propertyName?.text ?? element.name.text);
      addStatic(node.moduleSpecifier.text, symbols);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined && ts.isStringLiteralLike(expression)) {
        addStatic(expression.text, ['*']);
      } else {
        rejectUnknownLoader(expression, 'import-equals edge');
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isRequireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' &&
        node.expression.name.text === 'resolve';
      if (isDynamicImport || isRequire || isRequireResolve) {
        const expression = node.arguments[0];
        if (expression !== undefined && ts.isStringLiteralLike(expression)) {
          addStatic(
            expression.text,
            isRequire && !isDynamicImport && !isRequireResolve
              ? staticLoaderBindingSymbols(node)
              : ['*'],
          );
        } else {
          rejectUnknownLoader(expression, 'dynamic loader edge');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function assertFindingWriterSensitiveReverseImports(
  repoRoot: string,
  snapshot: FindingWriterRepositorySnapshot,
): string[] {
  const authorities = FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY;
  const authorityIdentities = new Set<string>();
  const authoritiesByTarget = new Map<string, Map<string, readonly string[]>>();
  for (const authority of authorities) {
    const identity = `${authority.target}\0${authority.symbol}`;
    if (authorityIdentities.has(identity)) {
      throw new Error(
        `Finding writer sensitive import authority is duplicated: ${authority.target}#${authority.symbol}`,
      );
    }
    authorityIdentities.add(identity);
    const canonicalImporters = [...new Set(authority.importers)].sort(compareText);
    if (JSON.stringify(authority.importers) !== JSON.stringify(canonicalImporters)) {
      throw new Error(
        `Finding writer ${authority.target}#${authority.symbol} importer declaration is duplicated or non-canonical`,
      );
    }
    const symbols = authoritiesByTarget.get(authority.target) ?? new Map();
    symbols.set(authority.symbol, authority.importers);
    authoritiesByTarget.set(authority.target, symbols);
  }
  const classifiedExportsByTarget = new Map<string, Set<string>>();
  for (const authority of authorities) {
    const symbols = classifiedExportsByTarget.get(authority.target) ?? new Set<string>();
    symbols.add(authority.symbol);
    classifiedExportsByTarget.set(authority.target, symbols);
  }
  for (const readOnlyExport of FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS) {
    const identity = `${readOnlyExport.target}\0${readOnlyExport.symbol}`;
    if (authorityIdentities.has(identity)) {
      throw new Error(
        `Finding writer runtime export has multiple classifications: ${readOnlyExport.target}#${readOnlyExport.symbol}`,
      );
    }
    authorityIdentities.add(identity);
    const symbols = classifiedExportsByTarget.get(readOnlyExport.target) ?? new Set<string>();
    symbols.add(readOnlyExport.symbol);
    classifiedExportsByTarget.set(readOnlyExport.target, symbols);
  }
  for (const [target, classifiedSymbols] of classifiedExportsByTarget) {
    assertExactStringSet(
      `${target} runtime export classification`,
      classifiedSymbols,
      exportedFindingWriterRuntimeSymbols(snapshot.readText(target), target),
    );
  }
  const sensitiveBasenames = new Set(
    [...classifiedExportsByTarget.keys()]
      .map((target) =>
        target
          .split('/')
          .at(-1)
          ?.replace(/\.[cm]?[jt]sx?$/, ''),
      )
      .filter((basename): basename is string => basename !== undefined),
  );
  const sensitiveAliases = findingWriterSensitiveAliases(
    repoRoot,
    classifiedExportsByTarget.keys(),
    snapshot,
  );
  const sensitiveSymbols = new Set(authorities.map((authority) => authority.symbol));
  const observed = new Map<string, Set<string>>();
  const governedImporters = new Set<string>();
  for (const importer of repositoryFindingWriterSourcePaths(snapshot)) {
    const raw = snapshot.readText(importer);
    for (const edge of observedFindingWriterImports(
      raw,
      importer,
      sensitiveBasenames,
      sensitiveAliases,
      sensitiveSymbols,
    )) {
      const target = resolveFindingWriterLiteralModule(
        repoRoot,
        importer,
        edge.specifier,
        snapshot,
      );
      if (target === null) {
        throw new Error(
          `Finding writer sensitive local module edge did not resolve: ${importer} -> ${edge.specifier}`,
        );
      }
      if (!classifiedExportsByTarget.has(target)) continue;
      const sensitiveTarget = authoritiesByTarget.get(target);
      if (edge.symbols.includes('*')) {
        throw new Error(
          `Finding writer sensitive module forbids namespace, side-effect, or dynamic access: ${importer} -> ${target}`,
        );
      }
      if (sensitiveTarget === undefined) continue;
      for (const symbol of edge.symbols) {
        if (!sensitiveTarget.has(symbol)) continue;
        const identity = `${target}\0${symbol}`;
        const importers = observed.get(identity) ?? new Set<string>();
        importers.add(importer);
        observed.set(identity, importers);
        governedImporters.add(importer);
      }
    }
  }
  for (const authority of authorities) {
    assertExactStringSet(
      `${authority.target}#${authority.symbol} reverse importer set`,
      authority.importers,
      observed.get(`${authority.target}\0${authority.symbol}`) ?? [],
    );
  }
  return [...governedImporters].sort(compareText);
}

/**
 * Compile the complete writer implementation boundary from explicit entrypoints plus every local
 * executable edge. Local TS/JS modules (relative, compiler-path, package-import, and package-self
 * aliases) plus local GitHub action directories are recursive, so a newly introduced helper cannot
 * execute outside the content-digest protocol.
 */
export function resolveFindingWriterGovernedPaths(
  repoRoot: string = REPO_ROOT,
  snapshot: FindingWriterRepositorySnapshot = createFindingWriterRepositorySnapshot(repoRoot),
): string[] {
  assertFindingWriterParserAuthorities(snapshot);
  const queue: string[] = [];
  const governed = new Set<string>();
  const enqueue = (path: string): void => {
    const normalized = repositoryRelativePath(repoRoot, resolve(repoRoot, path), path, snapshot);
    if (!governed.has(normalized)) {
      governed.add(normalized);
      queue.push(normalized);
    }
  };
  for (const path of FINDING_WRITER_ENTRYPOINT_PATHS) enqueue(path);
  for (const importer of assertFindingWriterSensitiveReverseImports(repoRoot, snapshot)) {
    enqueue(importer);
  }
  const compilerConfigAuthority = findingWriterCompilerConfigAuthority(repoRoot, snapshot);
  for (const configPath of compilerConfigAuthority.authorityPaths) enqueue(configPath);
  for (const packagePath of repositoryFindingWriterConfigurationPaths(snapshot).packages) {
    enqueue(packagePath);
  }

  const declaredEdgesBySource = new Map<string, string[]>();
  const declaredEdgeIdentities = new Set<string>();
  const linkedAuthorityVerifiers = new Set<'ARIA_AUTHORITY_HASH_V1'>();
  for (const edge of FINDING_WRITER_DECLARED_ASSET_EDGES) {
    const identity = `${edge.kind}\0${edge.from}\0${edge.to}`;
    if (declaredEdgeIdentities.has(identity)) {
      throw new Error(
        `Finding writer declared asset edge is duplicated: ${identity.replaceAll('\0', ' -> ')}`,
      );
    }
    declaredEdgeIdentities.add(identity);
    const targets = declaredEdgesBySource.get(edge.from) ?? [];
    targets.push(edge.to);
    declaredEdgesBySource.set(edge.from, targets);
    if (edge.kind === 'HASH_LINKED_AUTHORITY') {
      linkedAuthorityVerifiers.add(edge.verifier);
    }
  }
  const packagePath = 'package.json';
  const packageRaw = snapshot.readText(packagePath);
  const packageScriptAuthority = discoveredFindingWriterPackageScripts(packageRaw, packagePath);
  const observedPackageScripts = new Set(packageScriptAuthority.writerScripts);
  const mutationPackageScripts = new Set(packageScriptAuthority.mutationScripts);
  const authorizedMutationWorkflows: ReadonlySet<string> = new Set<string>(
    FINDING_WRITER_AUTOMATION_WORKFLOW_PATHS,
  );
  const discoveredWorkflowScriptEdges: string[] = [];

  for (const workflowPath of regularFilesBelow(repoRoot, '.github/workflows', snapshot)) {
    if (!/\.ya?ml$/i.test(workflowPath)) continue;
    const invocations = workflowPackageScriptInvocations(
      snapshot.readText(workflowPath),
      workflowPath,
      observedPackageScripts,
    );
    for (const script of invocations) {
      if (mutationPackageScripts.has(script) && !authorizedMutationWorkflows.has(workflowPath)) {
        throw new Error(
          `Finding writer mutation package script is invoked by an unauthorized workflow: ${workflowPath} -> ${script}`,
        );
      }
      discoveredWorkflowScriptEdges.push(`${workflowPath}\0${script}`);
      enqueue(workflowPath);
      enqueue(packagePath);
      for (const executablePath of packageScriptExecutablePaths(packageRaw, packagePath, script)) {
        enqueue(executablePath);
      }
    }
  }

  for (const script of mutationPackageScripts) {
    for (const executablePath of packageScriptExecutablePaths(packageRaw, packagePath, script)) {
      enqueue(executablePath);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    if (path === undefined) {
      throw new Error('Finding writer dependency queue lost a governed path');
    }
    const raw = snapshot.readText(path);
    for (const localUse of localUsesFromYaml(raw, path)) {
      for (const dependency of resolveLocalUse(repoRoot, localUse, path, snapshot)) {
        enqueue(dependency);
      }
    }
    for (const specifier of literalModuleSpecifiers(raw, path)) {
      const dependency = resolveFindingWriterLiteralModule(repoRoot, path, specifier, snapshot);
      if (dependency !== null) enqueue(dependency);
    }
    for (const declaredAsset of declaredEdgesBySource.get(path) ?? []) enqueue(declaredAsset);
  }
  const duplicateWorkflowEdge = discoveredWorkflowScriptEdges.find(
    (identity, index) => discoveredWorkflowScriptEdges.indexOf(identity) !== index,
  );
  if (duplicateWorkflowEdge !== undefined) {
    throw new Error(
      `Finding writer workflow invokes one writer package script more than once: ${duplicateWorkflowEdge.replace('\0', ' -> ')}`,
    );
  }
  for (const source of declaredEdgesBySource.keys()) {
    if (!governed.has(source)) {
      throw new Error(`Finding writer declared asset edge has an unreachable source: ${source}`);
    }
  }
  for (const verifier of linkedAuthorityVerifiers) {
    if (verifier === 'ARIA_AUTHORITY_HASH_V1') {
      const authorityFiles = ariaAuthorityFiles(repoRoot);
      snapshot.recordPathSet('ARIA_AUTHORITY_HASH_V1', authorityFiles, () =>
        ariaAuthorityFiles(repoRoot),
      );
      assertAriaAuthorityHashCurrent(repoRoot, (path) => snapshot.readText(path), authorityFiles);
    }
  }
  return [...governed].sort(compareText);
}

function assertRegularFile(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Finding writer governed path is missing or non-regular: ${path}`);
  }
}

export function buildFindingWriterProtocolManifest(
  repoRoot: string = REPO_ROOT,
  snapshot: FindingWriterRepositorySnapshot = createFindingWriterRepositorySnapshot(repoRoot),
): FindingWriterProtocolManifest {
  const governedPaths = resolveFindingWriterGovernedPaths(repoRoot, snapshot);
  const files = Object.fromEntries(
    governedPaths.map((path) => [
      path,
      createHash('sha256').update(snapshot.readFile(path)).digest('hex'),
    ]),
  );
  return {
    $schema: FINDING_WRITER_AUTHORITY_SCHEMA,
    schema_version: FINDING_WRITER_AUTHORITY_SCHEMA_VERSION,
    protocol_id: FINDING_WRITER_PROTOCOL_ID,
    files,
    repository_global_authority: {
      kind: 'GITHUB_ACTIONS_OIDC_V1',
      workflow_refs: FINDING_WRITER_AUTOMATION_WORKFLOW_REFS,
      protected_ref: AUTOMATION_BASE_REF,
      logical_branch: AUTOMATION_REGISTRY_LOGICAL_BRANCH,
      branch_strategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
      physical_branch_template: AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE,
      branch_lifecycle: AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE,
      branch_ref_permissions: { create: true, update: false, delete: false },
      compare_and_swap: AUTOMATION_PUBLICATION_COMPARE_AND_SWAP,
      publisher: FINDING_WRITER_PUBLISHER,
      publisher_credential: FINDING_WRITER_PUBLISHER_CREDENTIAL,
      idempotency: {
        kind: AUTOMATION_PUBLICATION_IDEMPOTENCY,
        required_trailers: AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
      },
    },
    local_fence: FINDING_WRITER_LOCAL_FENCE,
  };
}

function prettyGeneratedJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('Finding writer authority contains a non-JSON value');
    }
    return serialized;
  }
  const indentation = '  '.repeat(depth);
  const childIndentation = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value
      .map((item) => `${childIndentation}${prettyGeneratedJson(item, depth + 1)}`)
      .join(',\n')}\n${indentation}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(
      ([key, item]) =>
        `${childIndentation}${JSON.stringify(key)}: ${prettyGeneratedJson(item, depth + 1)}`,
    )
    .join(',\n')}\n${indentation}}`;
}

function renderFindingWriterProtocolManifestValue(manifest: FindingWriterProtocolManifest): string {
  return `${prettyGeneratedJson(manifest)}\n`;
}

export function renderFindingWriterProtocolManifest(repoRoot: string = REPO_ROOT): string {
  return renderFindingWriterProtocolManifestValue(buildFindingWriterProtocolManifest(repoRoot));
}

function parseFindingWriterProtocolManifestAgainstPaths(
  raw: string,
  path: string,
  expectedPaths: readonly string[],
): FindingWriterProtocolManifest {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      '$schema',
      'schema_version',
      'protocol_id',
      'files',
      'repository_global_authority',
      'local_fence',
    ])
  ) {
    throw new Error(`Finding writer protocol manifest is not a closed object: ${path}`);
  }
  const files = value.files;
  const authority = value.repository_global_authority;
  const localFence = value.local_fence;
  if (
    value.$schema !== FINDING_WRITER_AUTHORITY_SCHEMA ||
    value.schema_version !== FINDING_WRITER_AUTHORITY_SCHEMA_VERSION ||
    value.protocol_id !== FINDING_WRITER_PROTOCOL_ID ||
    !isRecord(files) ||
    !isRecord(authority) ||
    !isRecord(localFence) ||
    !exactKeys(authority, [
      'kind',
      'workflow_refs',
      'protected_ref',
      'logical_branch',
      'branch_strategy',
      'physical_branch_template',
      'branch_lifecycle',
      'branch_ref_permissions',
      'compare_and_swap',
      'publisher',
      'publisher_credential',
      'idempotency',
    ]) ||
    !isRecord(authority.branch_ref_permissions) ||
    !exactKeys(authority.branch_ref_permissions, ['create', 'update', 'delete']) ||
    !isRecord(authority.idempotency) ||
    !exactKeys(authority.idempotency, ['kind', 'required_trailers']) ||
    authority.kind !== 'GITHUB_ACTIONS_OIDC_V1' ||
    JSON.stringify(authority.workflow_refs) !==
      JSON.stringify(FINDING_WRITER_AUTOMATION_WORKFLOW_REFS) ||
    authority.protected_ref !== AUTOMATION_BASE_REF ||
    authority.logical_branch !== AUTOMATION_REGISTRY_LOGICAL_BRANCH ||
    authority.branch_strategy !== AUTOMATION_PUBLICATION_BRANCH_STRATEGY ||
    authority.physical_branch_template !== AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE ||
    authority.branch_lifecycle !== AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE ||
    authority.branch_ref_permissions.create !== true ||
    authority.branch_ref_permissions.update !== false ||
    authority.branch_ref_permissions.delete !== false ||
    authority.compare_and_swap !== AUTOMATION_PUBLICATION_COMPARE_AND_SWAP ||
    authority.publisher !== FINDING_WRITER_PUBLISHER ||
    authority.publisher_credential !== FINDING_WRITER_PUBLISHER_CREDENTIAL ||
    authority.idempotency.kind !== AUTOMATION_PUBLICATION_IDEMPOTENCY ||
    JSON.stringify(authority.idempotency.required_trailers) !==
      JSON.stringify(AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER) ||
    JSON.stringify(localFence) !== JSON.stringify(FINDING_WRITER_LOCAL_FENCE)
  ) {
    throw new Error(`Finding writer protocol manifest has an incompatible contract: ${path}`);
  }
  if (!exactKeys(files, expectedPaths)) {
    throw new Error(`Finding writer protocol file digest set is invalid: ${path}`);
  }
  const parsedFiles: Record<string, string> = {};
  for (const governedPath of expectedPaths) {
    const digest = files[governedPath];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`Finding writer protocol file digest set is invalid: ${path}`);
    }
    parsedFiles[governedPath] = digest;
  }

  return {
    $schema: FINDING_WRITER_AUTHORITY_SCHEMA,
    schema_version: FINDING_WRITER_AUTHORITY_SCHEMA_VERSION,
    protocol_id: FINDING_WRITER_PROTOCOL_ID,
    files: parsedFiles,
    repository_global_authority: {
      kind: 'GITHUB_ACTIONS_OIDC_V1',
      workflow_refs: FINDING_WRITER_AUTOMATION_WORKFLOW_REFS,
      protected_ref: AUTOMATION_BASE_REF,
      logical_branch: AUTOMATION_REGISTRY_LOGICAL_BRANCH,
      branch_strategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
      physical_branch_template: AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE,
      branch_lifecycle: AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE,
      branch_ref_permissions: { create: true, update: false, delete: false },
      compare_and_swap: AUTOMATION_PUBLICATION_COMPARE_AND_SWAP,
      publisher: FINDING_WRITER_PUBLISHER,
      publisher_credential: FINDING_WRITER_PUBLISHER_CREDENTIAL,
      idempotency: {
        kind: AUTOMATION_PUBLICATION_IDEMPOTENCY,
        required_trailers: AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
      },
    },
    local_fence: FINDING_WRITER_LOCAL_FENCE,
  };
}

export function parseFindingWriterProtocolManifest(
  raw: string,
  path: string,
  repoRoot: string,
): FindingWriterProtocolManifest {
  return parseFindingWriterProtocolManifestAgainstPaths(
    raw,
    path,
    resolveFindingWriterGovernedPaths(repoRoot),
  );
}

/** Compile once, validate the closed contract, and prove exact canonical bytes. */
export function verifyFindingWriterProtocolManifest(
  raw: string,
  path: string,
  repoRoot: string,
  snapshot: FindingWriterRepositorySnapshot = createFindingWriterRepositorySnapshot(repoRoot),
): FindingWriterProtocolManifest {
  const expected = buildFindingWriterProtocolManifest(repoRoot, snapshot);
  const parsed = parseFindingWriterProtocolManifestAgainstPaths(
    raw,
    path,
    Object.keys(expected.files),
  );
  if (raw !== renderFindingWriterProtocolManifestValue(expected)) {
    throw new Error(
      `${FINDING_WRITER_AUTHORITY_PATH} is stale; run npm run findings:writer-authority:write`,
    );
  }
  snapshot.assertCurrent();
  return parsed;
}

export function checkFindingWriterProtocolManifest(repoRoot: string = REPO_ROOT): void {
  const path = resolve(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
  assertRegularFile(path);
  const actual = readFileSync(path, 'utf8');
  verifyFindingWriterProtocolManifest(actual, path, repoRoot);
}

export function writeFindingWriterProtocolManifest(repoRoot: string = REPO_ROOT): boolean {
  const target = resolve(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
  if (existsSync(target)) assertRegularFile(target);
  const expected = renderFindingWriterProtocolManifest(repoRoot);
  if (existsSync(target) && readFileSync(target, 'utf8') === expected) return false;

  const temporary = `${target}.${String(process.pid)}.${randomUUID()}.new`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    );
    fchmodSync(descriptor, 0o644);
    writeFileSync(descriptor, expected, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    const directoryDescriptor = openSync(
      dirname(target),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return true;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('expected exactly one of --check or --write');
  }
  const [mode] = args;
  if (mode === '--check') {
    checkFindingWriterProtocolManifest();
    return;
  }
  if (mode === '--write') {
    writeFindingWriterProtocolManifest();
    return;
  }
  throw new Error('expected exactly one of --check or --write');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
