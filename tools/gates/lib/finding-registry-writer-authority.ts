#!/usr/bin/env ts-node
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';

import * as ts from 'typescript';
import * as YAML from 'yaml';
import yamlPackage from 'yaml/package.json';

import {
  ariaAuthorityFiles,
  assertAriaAuthorityHashCurrent,
  CURRENT_STATE_PATH,
  selectAriaAuthorityFiles,
} from '../aria-authority-hash';

import {
  assertStableDirectoryCurrent,
  assertStablePathKindCurrent,
  assertStableRegularFileCurrent,
  decodeFatalUtf8,
  observeStableDirectory,
  observeStablePathKind,
  observeStableRegularFile,
  sameAnchoredDirectoryIdentity,
  sameAnchoredPathGeneration,
  sameStableParentIdentities,
  type AnchoredPathKindV1,
  type StableDirectoryObservationV1,
  type StablePathKindObservationV1,
  type StableRegularFileObservationV1,
} from './anchored-filesystem';
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
import { REPO_ROOT } from './repo-root';

const FINDING_WRITER_AUTOMATION_WORKFLOW_PATHS = Object.freeze(
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY.map((policy) => policy.workflowPath),
);
const FINDING_WRITER_AUTOMATION_WORKFLOW_REFS = Object.freeze(
  AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY.map((policy) => policy.workflowRef),
);

export const FINDING_WRITER_AUTHORITY_PATH =
  '.github/manifests/finding-registry-writer-authority.json';
export const FINDING_WRITER_AUTHORITY_SCHEMA = 'aqua/finding-registry-writer-authority/v7' as const;
export const FINDING_WRITER_AUTHORITY_SCHEMA_VERSION = 7 as const;
export const FINDING_WRITER_PROTOCOL_ID = 'aqua.finding-registry-writer/v8' as const;
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

const FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_BRAND: unique symbol = Symbol(
  'FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_V1',
);
const FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_BRAND: unique symbol = Symbol(
  'FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_V1',
);

export interface FindingWriterRepositorySourceTransition {
  readonly kind: 'FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_V1';
  readonly [FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_BRAND]: true;
}

export interface FindingWriterRepositoryPreparedSourceTransition {
  readonly kind: 'FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_V1';
  readonly [FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_BRAND]: true;
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
  prepareSourceMutation(transition: {
    readonly planDirectoryPath: string;
    readonly targetPath: string;
    readonly beforeSha256: string | null;
    readonly afterSha256: string | null;
  }): FindingWriterRepositorySourceTransition;
  prepareSourceMutationCommit(
    transition: FindingWriterRepositorySourceTransition,
  ): FindingWriterRepositoryPreparedSourceTransition;
  assertSourceMutationBeforeCurrent(transition: FindingWriterRepositorySourceTransition): void;
  commitSourceMutation(
    transition: FindingWriterRepositorySourceTransition,
    prepared: FindingWriterRepositoryPreparedSourceTransition,
  ): void;
  cancelSourceMutation(transition: FindingWriterRepositorySourceTransition): void;
  assertCurrent(): void;
}

export class FindingWriterRepositorySnapshotMismatchError extends Error {
  public readonly code = 'FINDING_WRITER_REPOSITORY_SNAPSHOT_MISMATCH' as const;

  public constructor(public readonly identity: string) {
    super(`Finding writer snapshot path set changed: ${identity}`);
    this.name = 'FindingWriterRepositorySnapshotMismatchError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface FindingWriterSnapshotReadObserver {
  onFileRead(relativePath: string): void;
  onDirectoryRead(relativePath: string): void;
}

interface FindingWriterSourceMutationEpochV1 {
  readonly planDirectories: ReadonlyMap<string, StableDirectoryObservationV1>;
  readonly targetFiles: ReadonlyMap<string, StableRegularFileObservationV1 | null>;
}

interface PendingFindingWriterRepositorySourceTransitionV1 {
  readonly transition: FindingWriterRepositorySourceTransition;
  readonly planDirectory: string;
  readonly target: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly expectedEntries: readonly FindingWriterDirectoryEntry[];
  prepared:
    | {
        readonly capability: FindingWriterRepositoryPreparedSourceTransition;
        readonly epoch: FindingWriterSourceMutationEpochV1;
      }
    | undefined;
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
  private sourceMutationEpoch: FindingWriterSourceMutationEpochV1 = Object.freeze({
    planDirectories: new Map(),
    targetFiles: new Map(),
  });
  private pendingSourceMutation: PendingFindingWriterRepositorySourceTransitionV1 | undefined;

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

  private assertCurrentExcludingSourceMutation(planDirectory?: string, target?: string): void {
    for (const [identity, expected] of this.pathSets) {
      if (JSON.stringify(expected.readCurrent()) !== JSON.stringify(expected.paths)) {
        throw new FindingWriterRepositorySnapshotMismatchError(identity);
      }
    }
    for (const [absolutePath, expected] of this.pathKinds) {
      if (
        absolutePath === target ||
        absolutePath === planDirectory ||
        this.sourceMutationEpoch.targetFiles.has(absolutePath) ||
        this.sourceMutationEpoch.planDirectories.has(absolutePath) ||
        expected.kind === 'MISSING'
      ) {
        continue;
      }
      assertStablePathKindCurrent(expected, `Finding writer resolver path ${absolutePath}`);
    }
    for (const [relativePath, expected] of this.fileGenerations) {
      const absolutePath = resolve(this.repoRoot, relativePath);
      if (absolutePath === target || this.sourceMutationEpoch.targetFiles.has(absolutePath)) {
        continue;
      }
      const currentPath = this.assertComponents(relativePath);
      assertStableRegularFileCurrent(
        expected,
        FINDING_WRITER_MAX_FILE_BYTES,
        `Finding writer snapshot file ${currentPath}`,
      );
    }
    for (const [absolutePath, expected] of this.directoryGenerations) {
      if (
        absolutePath === planDirectory ||
        this.sourceMutationEpoch.planDirectories.has(absolutePath)
      ) {
        continue;
      }
      assertStableDirectoryCurrent(expected, `Finding writer snapshot directory ${absolutePath}`);
    }
    for (const [absolutePath, expected] of this.sourceMutationEpoch.planDirectories) {
      if (absolutePath === planDirectory) continue;
      assertStableDirectoryCurrent(
        expected,
        `Finding writer transitioned source directory ${absolutePath}`,
      );
    }
    for (const [absolutePath, expected] of this.sourceMutationEpoch.targetFiles) {
      if (absolutePath === target || expected === null) continue;
      assertStableRegularFileCurrent(
        expected,
        FINDING_WRITER_MAX_FILE_BYTES,
        `Finding writer transitioned source file ${absolutePath}`,
      );
    }
  }

  private sourcePlanDirectoryObservation(planDirectory: string): StableDirectoryObservationV1 {
    const transitioned = this.sourceMutationEpoch.planDirectories.get(planDirectory);
    if (transitioned !== undefined) return transitioned;
    const captured = this.directoryGenerations.get(planDirectory);
    if (captured === undefined || captured.entries === null) {
      throw new Error(`Finding writer source plan directory was not snapshotted: ${planDirectory}`);
    }
    return captured;
  }

  private pendingSourceTransition(
    transition: FindingWriterRepositorySourceTransition,
  ): PendingFindingWriterRepositorySourceTransitionV1 {
    const pending = this.pendingSourceMutation;
    if (pending === undefined || pending.transition !== transition) {
      throw new Error(
        'Finding writer repository source transition is foreign, stale, or already consumed',
      );
    }
    return pending;
  }

  public prepareSourceMutation(transition: {
    readonly planDirectoryPath: string;
    readonly targetPath: string;
    readonly beforeSha256: string | null;
    readonly afterSha256: string | null;
  }): FindingWriterRepositorySourceTransition {
    if (this.pendingSourceMutation !== undefined) {
      throw new Error('Finding writer repository already has one pending source transition');
    }
    const planDirectory = this.normalize(transition.planDirectoryPath, true).absolutePath;
    const target = this.normalize(transition.targetPath).absolutePath;
    if (dirname(target) !== planDirectory) {
      throw new Error(`Finding writer source transition escapes its plan directory: ${target}`);
    }
    for (const [label, value] of [
      ['before', transition.beforeSha256],
      ['after', transition.afterSha256],
    ] as const) {
      if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`Finding writer source transition ${label} digest is invalid`);
      }
    }
    this.assertCurrent();
    const priorDirectory = this.sourcePlanDirectoryObservation(planDirectory);
    const priorEntries = priorDirectory.entries;
    if (priorEntries === null) throw new Error('Finding writer source plan directory lost entries');
    const targetName = basename(target);
    const priorTarget = priorEntries.find((entry) => entry.name === targetName);
    if ((transition.beforeSha256 === null) !== (priorTarget === undefined)) {
      throw new Error(`Finding writer source transition before-image presence changed: ${target}`);
    }
    if (priorTarget !== undefined && priorTarget.kind !== 'FILE') {
      throw new Error(`Finding writer source transition target was not a file: ${target}`);
    }
    const currentPathKind = observeStablePathKind(target, 'Finding writer source before-image');
    if (transition.beforeSha256 === null) {
      if (currentPathKind.kind !== 'MISSING') {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_BEFORE_EXPECTED_MISSING:${target}`,
        );
      }
    } else {
      if (currentPathKind.kind !== 'FILE') {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_BEFORE_EXPECTED_FILE:${target}`,
        );
      }
      const currentFile = observeStableRegularFile(
        target,
        FINDING_WRITER_MAX_FILE_BYTES,
        'Finding writer source before-image',
      );
      if (currentFile.sha256 !== transition.beforeSha256) {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_BEFORE_DIGEST:${target}`,
        );
      }
    }
    const expectedEntries = [
      ...priorEntries.filter((entry) => entry.name !== targetName),
      ...(transition.afterSha256 === null
        ? []
        : [Object.freeze({ name: targetName, kind: 'FILE' as const })]),
    ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const capability = Object.freeze({
      kind: 'FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_V1' as const,
      [FINDING_WRITER_REPOSITORY_SOURCE_TRANSITION_BRAND]: true as const,
    });
    this.pendingSourceMutation = {
      transition: capability,
      planDirectory,
      target,
      beforeSha256: transition.beforeSha256,
      afterSha256: transition.afterSha256,
      expectedEntries: Object.freeze(expectedEntries.map((entry) => Object.freeze({ ...entry }))),
      prepared: undefined,
    };
    return capability;
  }

  public prepareSourceMutationCommit(
    transition: FindingWriterRepositorySourceTransition,
  ): FindingWriterRepositoryPreparedSourceTransition {
    const pending = this.pendingSourceTransition(transition);
    const currentDirectory = observeStableDirectory(
      pending.planDirectory,
      'Finding writer source transition directory',
      true,
    );
    const currentEntries = currentDirectory.entries;
    if (
      currentEntries === null ||
      JSON.stringify(currentEntries) !== JSON.stringify(pending.expectedEntries)
    ) {
      throw new FindingWriterRepositorySnapshotMismatchError(
        `SOURCE_TRANSITION_DIRECTORY:${pending.planDirectory}`,
      );
    }
    const priorDirectory = this.sourcePlanDirectoryObservation(pending.planDirectory);
    if (
      !sameAnchoredDirectoryIdentity(priorDirectory.generation, currentDirectory.generation) ||
      !sameStableParentIdentities(
        priorDirectory.parentGenerations,
        currentDirectory.parentGenerations,
      )
    ) {
      throw new FindingWriterRepositorySnapshotMismatchError(
        `SOURCE_TRANSITION_DIRECTORY_IDENTITY:${pending.planDirectory}`,
      );
    }
    const currentPathKind = observeStablePathKind(
      pending.target,
      'Finding writer source transition target',
    );
    let currentFile: StableRegularFileObservationV1 | null = null;
    if (pending.afterSha256 === null) {
      if (currentPathKind.kind !== 'MISSING') {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_EXPECTED_MISSING:${pending.target}`,
        );
      }
    } else {
      if (currentPathKind.kind !== 'FILE') {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_EXPECTED_FILE:${pending.target}`,
        );
      }
      currentFile = observeStableRegularFile(
        pending.target,
        FINDING_WRITER_MAX_FILE_BYTES,
        'Finding writer source transition file',
      );
      if (currentFile.sha256 !== pending.afterSha256) {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_DIGEST:${pending.target}`,
        );
      }
    }
    this.assertCurrentExcludingSourceMutation(pending.planDirectory, pending.target);
    const nextPlanDirectories = new Map(this.sourceMutationEpoch.planDirectories);
    nextPlanDirectories.set(pending.planDirectory, currentDirectory);
    const nextTargetFiles = new Map(this.sourceMutationEpoch.targetFiles);
    nextTargetFiles.set(pending.target, currentFile);
    const capability = Object.freeze({
      kind: 'FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_V1' as const,
      [FINDING_WRITER_REPOSITORY_PREPARED_SOURCE_TRANSITION_BRAND]: true as const,
    });
    pending.prepared = {
      capability,
      epoch: Object.freeze({
        planDirectories: nextPlanDirectories,
        targetFiles: nextTargetFiles,
      }),
    };
    return capability;
  }

  public assertSourceMutationBeforeCurrent(
    transition: FindingWriterRepositorySourceTransition,
  ): void {
    const pending = this.pendingSourceTransition(transition);
    this.assertCurrent();
    const currentPathKind = observeStablePathKind(
      pending.target,
      'Finding writer pending source before-image',
    );
    if (pending.beforeSha256 === null) {
      if (currentPathKind.kind !== 'MISSING') {
        throw new FindingWriterRepositorySnapshotMismatchError(
          `SOURCE_TRANSITION_PENDING_BEFORE_EXPECTED_MISSING:${pending.target}`,
        );
      }
      return;
    }
    if (currentPathKind.kind !== 'FILE') {
      throw new FindingWriterRepositorySnapshotMismatchError(
        `SOURCE_TRANSITION_PENDING_BEFORE_EXPECTED_FILE:${pending.target}`,
      );
    }
    const currentFile = observeStableRegularFile(
      pending.target,
      FINDING_WRITER_MAX_FILE_BYTES,
      'Finding writer pending source before-image',
    );
    if (currentFile.sha256 !== pending.beforeSha256) {
      throw new FindingWriterRepositorySnapshotMismatchError(
        `SOURCE_TRANSITION_PENDING_BEFORE_DIGEST:${pending.target}`,
      );
    }
  }

  public commitSourceMutation(
    transition: FindingWriterRepositorySourceTransition,
    prepared: FindingWriterRepositoryPreparedSourceTransition,
  ): void {
    const pending = this.pendingSourceTransition(transition);
    if (pending.prepared === undefined || pending.prepared.capability !== prepared) {
      throw new Error('Finding writer prepared source transition is foreign or stale');
    }
    const nextEpoch = pending.prepared.epoch;
    this.sourceMutationEpoch = nextEpoch;
    this.pendingSourceMutation = undefined;
  }

  public cancelSourceMutation(transition: FindingWriterRepositorySourceTransition): void {
    this.assertSourceMutationBeforeCurrent(transition);
    this.pendingSourceMutation = undefined;
  }

  public assertCurrent(): void {
    this.assertCurrentExcludingSourceMutation();
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

type FindingWriterSensitiveImportDeclaration = FindingWriterSensitiveImportAuthority;

interface FindingWriterSensitiveReadOnlyExport {
  readonly target: string;
  readonly symbol: string;
  readonly reexport?: {
    readonly specifier: string;
    readonly symbol: string;
  };
}

function freezeFindingWriterSensitiveImportAuthority(
  authorities: readonly FindingWriterSensitiveImportDeclaration[],
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
  return Object.freeze(
    exports_.map((entry) =>
      Object.freeze({
        ...entry,
        ...(entry.reexport === undefined ? {} : { reexport: Object.freeze({ ...entry.reexport }) }),
      }),
    ),
  );
}

const ANCHORED_FILESYSTEM_PRODUCTION_RUNTIME_EXPORTS = Object.freeze([
  'AnchoredFilesystemError',
  'HermeticExecutableExecutionTimeoutError',
  'anchoredPathGeneration',
  'assertAnchoredDirectoryChainCurrent',
  'assertAnchoredDirectoryChainIdentityCurrent',
  'assertStableDirectoryContentGenerationCurrent',
  'assertStableDirectoryCurrent',
  'assertStablePathKindCurrent',
  'assertStableRegularFileCurrent',
  'closeAnchoredDirectoryChain',
  'decodeFatalUtf8',
  'defineHermeticExecutableExecutionPolicyV1',
  'observeAnchoredPathKind',
  'observeStableDirectory',
  'observeStablePathKind',
  'observeStableRegularFile',
  'openAnchoredDirectoryChain',
  'openHermeticExecutableAuthority',
  'sameAnchoredDirectoryIdentity',
  'sameAnchoredPathGeneration',
  'sameBigIntFileObservation',
  'sameStableParentIdentities',
] as const);

const HERMETIC_GIT_PRODUCTION_RUNTIME_EXPORTS = Object.freeze([
  'CANONICAL_GIT_HEAD_TREE_ARGS',
  'CANONICAL_GIT_INDEX_ARGS',
  'CANONICAL_GIT_INDEX_FSMONITOR_ARGS',
  'CANONICAL_GIT_UNTRACKED_ARGS',
  'CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS',
  'HERMETIC_GIT_EXECUTION_MODES_V1',
  'HERMETIC_GIT_EXECUTION_POLICY_V1',
  'HERMETIC_GIT_RUNTIME',
  'HermeticGitExecutionCleanupError',
  'HermeticGitExecutionTimeoutError',
  'HermeticGitSynchronousBudgetError',
  'InventoryInspectionError',
  'REPOSITORY_CHILD_FD_COORDINATES_V1',
  'captureCanonicalGitWorktreeStatus',
  'computeCanonicalGitWorktreeEvidence',
  'runWithHermeticGitExecutionBudget',
  'runWithHermeticGitExecutionDeadline',
] as const);

type FindingWriterDynamicModuleLoaderTargetPolicy = Readonly<{
  kind: 'DESCRIPTOR_BOUND_REPOSITORY_APPLICATION_SOURCE';
  authorityConstructionFunction: 'ensureRepositoryApplicationExecutionAuthority';
  enclosingFunction: 'evaluateDescriptorBoundRepositoryApplicationModule';
  guardFunction: 'openRepositoryApplicationModule';
  compilerExecutionCount: 1;
  dependencyResolverExecutionCount: 1;
  executionPackageLoadCount: 2;
  loaderExecutionCount: 1;
  moduleConstructorCount: 2;
  moduleCacheDeleteCount: 1;
  moduleCacheReadCount: 1;
  moduleCacheWriteCount: 1;
  privateCompileReadCount: 2;
  privateCompileWriteCount: 1;
  privateExtensionRegistryReadCount: 1;
  privateLoaderReadCount: 1;
  privateLoaderWriteCount: 3;
  privateModuleCacheReadCount: 1;
  privateResolverReadCount: 1;
  privateResolverWriteCount: 4;
  pathRegistrationCount: 1;
  pathUnregistrationCount: 1;
  registryHandlers: readonly Readonly<{
    extension: '.json' | '.ts';
    handler: 'jsonHandler' | 'typescriptHandler';
    label: 'JSON' | 'TypeScript';
    previousHandler: 'previousJsonHandler' | 'previousTypeScriptHandler';
  }>[];
  requireCacheAccessCount: 0;
  requireExtensionsJavaScriptAccessCount: 0;
  requireExtensionsTypeScriptAccessCount: 0;
  requireResolveAliasCount: 0;
  requireResolvePackageCoordinateCount: 2;
  resolverExecutionCount: 1;
  runtimeActiveAssertionFunction: 'assertRepositoryApplicationExecutionRuntimeCurrent';
  runtimeInactiveAssertionFunction: 'assertRepositoryApplicationExecutionRuntimeInactive';
  runtimeInstallFunction: 'installRepositoryApplicationExecutionRuntime';
  runtimeRestoreFunction: 'restoreRepositoryApplicationExecutionRuntime';
}>;

interface FindingWriterDynamicModuleLoaderAuthorityV1 {
  readonly path: string;
  readonly loaderKind:
    | 'DYNAMIC_IMPORT'
    | 'GLOBAL_REQUIRE'
    | 'GLOBAL_REQUIRE_RESOLVE'
    | 'MODULE_REQUIRE'
    | 'CREATE_REQUIRE_BINDING'
    | 'CREATE_REQUIRE_RESOLVE'
    | 'COMMONJS_EXTENSION_HANDLER';
  readonly loaderBinding: string;
  readonly argumentExpression: string;
  readonly targetPolicy: FindingWriterDynamicModuleLoaderTargetPolicy;
  readonly reason: string;
}

function dynamicModuleLoaderIdentity(
  authority: Pick<
    FindingWriterDynamicModuleLoaderAuthorityV1,
    'path' | 'loaderKind' | 'loaderBinding' | 'argumentExpression'
  >,
): string {
  return [
    authority.path,
    authority.loaderKind,
    authority.loaderBinding,
    authority.argumentExpression,
  ].join('\0');
}

function freezeFindingWriterDynamicModuleLoaderAuthority(
  entries: readonly FindingWriterDynamicModuleLoaderAuthorityV1[],
): readonly FindingWriterDynamicModuleLoaderAuthorityV1[] {
  const identities = new Set<string>();
  const frozen = entries.map((entry) => {
    const identity = dynamicModuleLoaderIdentity(entry);
    if (identities.has(identity)) {
      throw new Error(`Finding writer dynamic module loader authority is duplicated: ${identity}`);
    }
    identities.add(identity);
    if (entry.reason.trim().length === 0) {
      throw new Error(`Finding writer dynamic module loader authority has no reason: ${identity}`);
    }
    const registryHandlers = entry.targetPolicy.registryHandlers.map((handler) =>
      Object.freeze({ ...handler }),
    );
    const handlerExtensions = registryHandlers.map((handler) => handler.extension);
    if (
      new Set(handlerExtensions).size !== handlerExtensions.length ||
      [...handlerExtensions].sort(compareText).some((extension, index) => {
        return extension !== handlerExtensions[index];
      })
    ) {
      throw new Error(
        `Finding writer dynamic module loader registry handlers are duplicated or unordered: ${identity}`,
      );
    }
    return Object.freeze({
      ...entry,
      targetPolicy: Object.freeze({
        ...entry.targetPolicy,
        registryHandlers: Object.freeze(registryHandlers),
      }),
    });
  });
  return Object.freeze(
    frozen.sort((left, right) =>
      compareText(dynamicModuleLoaderIdentity(left), dynamicModuleLoaderIdentity(right)),
    ),
  );
}

/** Exact census of computed loaders reachable from the finding-writer execution closure. */
export const FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY =
  freezeFindingWriterDynamicModuleLoaderAuthority([
    {
      path: 'tools/gates/lib/repository-application-module-loader.ts',
      loaderKind: 'COMMONJS_EXTENSION_HANDLER',
      loaderBinding: 'extensionHandler.handler',
      argumentExpression: 'handlerCoordinate',
      targetPolicy: {
        kind: 'DESCRIPTOR_BOUND_REPOSITORY_APPLICATION_SOURCE',
        authorityConstructionFunction: 'ensureRepositoryApplicationExecutionAuthority',
        compilerExecutionCount: 1,
        dependencyResolverExecutionCount: 1,
        enclosingFunction: 'evaluateDescriptorBoundRepositoryApplicationModule',
        executionPackageLoadCount: 2,
        guardFunction: 'openRepositoryApplicationModule',
        loaderExecutionCount: 1,
        moduleConstructorCount: 2,
        moduleCacheDeleteCount: 1,
        moduleCacheReadCount: 1,
        moduleCacheWriteCount: 1,
        privateCompileReadCount: 2,
        privateCompileWriteCount: 1,
        privateExtensionRegistryReadCount: 1,
        privateLoaderReadCount: 1,
        privateLoaderWriteCount: 3,
        privateModuleCacheReadCount: 1,
        privateResolverReadCount: 1,
        privateResolverWriteCount: 4,
        pathRegistrationCount: 1,
        pathUnregistrationCount: 1,
        registryHandlers: [
          {
            extension: '.json',
            handler: 'jsonHandler',
            label: 'JSON',
            previousHandler: 'previousJsonHandler',
          },
          {
            extension: '.ts',
            handler: 'typescriptHandler',
            label: 'TypeScript',
            previousHandler: 'previousTypeScriptHandler',
          },
        ],
        requireCacheAccessCount: 0,
        requireExtensionsJavaScriptAccessCount: 0,
        requireExtensionsTypeScriptAccessCount: 0,
        requireResolveAliasCount: 0,
        requireResolvePackageCoordinateCount: 2,
        resolverExecutionCount: 1,
        runtimeActiveAssertionFunction: 'assertRepositoryApplicationExecutionRuntimeCurrent',
        runtimeInactiveAssertionFunction: 'assertRepositoryApplicationExecutionRuntimeInactive',
        runtimeInstallFunction: 'installRepositoryApplicationExecutionRuntime',
        runtimeRestoreFunction: 'restoreRepositoryApplicationExecutionRuntime',
      },
      reason:
        'The sole CommonJS evaluation kernel executes one bounded descriptor snapshot below canonical apps/.',
    },
  ]);

/**
 * Reverse-edge SSOT for every export that can mint, redeem, bind, or execute a governed finding
 * mutation. Forward dependency closure alone cannot detect a new importer, so the compiler scans
 * every repository TS/JS source (including untracked files) and requires byte-exact set equality.
 */
export const FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY =
  freezeFindingWriterSensitiveImportAuthority([
    {
      target: 'tools/gates/lib/anchored-filesystem.kernel.ts',
      symbol: 'openHermeticExecutableAuthorityAtOwnedFixtureBoundary',
      importers: ['tools/gates/lib/anchored-filesystem.fixture.ts'],
    },
    {
      target: 'tools/gates/lib/anchored-filesystem.fixture.ts',
      symbol: 'testOnlyOpenHermeticExecutableAuthorityForOwnedFixture',
      importers: ['tools/gates/lib/anchored-filesystem.spec.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.kernel.ts',
      symbol: 'testOnlyCreateHermeticGitRuntime',
      importers: ['tools/gates/lib/hermetic-git-runtime.fixture.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.kernel.ts',
      symbol: 'testOnlyCloseHermeticGitDescriptors',
      importers: ['tools/gates/lib/hermetic-git-runtime.fixture.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.kernel.ts',
      symbol: 'testOnlyFingerprintHermeticGitRegularFile',
      importers: ['tools/gates/lib/hermetic-git-runtime.fixture.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.fixture.ts',
      symbol: 'testOnlyCreateHermeticGitRuntime',
      importers: ['tools/gates/lib/hermetic-git-runtime.spec.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.fixture.ts',
      symbol: 'testOnlyCloseHermeticGitDescriptors',
      importers: ['tools/gates/lib/hermetic-git-runtime.spec.ts'],
    },
    {
      target: 'tools/gates/lib/hermetic-git-runtime.fixture.ts',
      symbol: 'testOnlyFingerprintHermeticGitRegularFile',
      importers: ['tools/gates/lib/hermetic-git-runtime.spec.ts'],
    },
    {
      target: 'tools/gates/lib/repository-application-module-loader.ts',
      symbol: 'loadRepositoryApplicationModule',
      importers: [
        'apps/db-migrate/src/__tests__/bootstrap-from-scratch.spec.ts',
        'e2e/tests/integration/schema-invariants.spec.ts',
        'tools/scripts/emit-subgraph-sdl.ts',
      ],
    },
    {
      target: 'tools/gates/lib/repository-application-module-loader.ts',
      symbol: 'testOnlyLoadRepositoryApplicationModuleFromRoot',
      importers: ['tools/gates/lib/repository-application-module-loader.spec.ts'],
    },
    {
      target: 'tools/gates/lib/repository-application-module-loader.ts',
      symbol: 'testOnlyReleaseRepositoryApplicationModulesBelowRoot',
      importers: ['tools/gates/lib/repository-application-module-loader.spec.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'createFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'prepareFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'consumeFindingWriterFenceSnapshot',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'redeemRegistryFindingWriterFence',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'releaseFindingWriterFence',
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceAuthority',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceCurrent',
      importers: ['tools/gates/finding-registry-store.spec.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertFindingWriterFenceTargetAuthorized',
      importers: ['tools/gates/finding-registry-store.ts'],
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
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'closeSourceFindingWriterFenceSession',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertSourceFindingWriterFenceSessionCurrent',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'prepareSourceFindingWriterFenceSessionTransition',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/finding-registry-store.ts',
      ],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertPendingSourceFindingWriterFenceSessionTransitionBeforeCurrent',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/finding-registry-store.ts',
      ],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'commitSourceFindingWriterFenceSessionTransition',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'rollbackPendingSourceFindingWriterFenceSessionTransition',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'assertSourceFindingWriterFenceSessionTargetCurrent',
      importers: ['tools/gates/finding-registry-store.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'testOnlyWithRegistryFileLock',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/lib/finding-registry-lock.fixture.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'withFindingWriterKernelLockAsync',
      importers: ['tools/gates/finding-registry.ts'],
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'testOnlyWithRegistryFileLockAsync',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/lib/finding-registry-lock.fixture.ts',
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
      importers: ['tools/gates/finding-registry-store.spec.ts', 'tools/gates/finding-registry.ts'],
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
      target: 'tools/gates/finding-registry.ts',
      symbol: 'runWithPreparedFindingWriterFenceAdmission',
      importers: [
        'tools/gates/finding-registry-store.spec.ts',
        'tools/gates/source-finding-inventory.ts',
      ],
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'testOnlyRunWithPreparedFindingWriterFenceAdmission',
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
  ] as const satisfies readonly FindingWriterSensitiveImportDeclaration[]);

/** Explicitly harmless runtime exports from modules that also own mutation authority. */
export const FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS =
  freezeFindingWriterSensitiveReadOnlyExports([
    ...[
      'tools/gates/lib/anchored-filesystem.kernel.ts',
      'tools/gates/lib/anchored-filesystem.ts',
    ].flatMap((target) =>
      ANCHORED_FILESYSTEM_PRODUCTION_RUNTIME_EXPORTS.map((symbol) => ({
        target,
        symbol,
        ...(target.endsWith('.kernel.ts')
          ? {}
          : {
              reexport: {
                specifier: './anchored-filesystem.kernel',
                symbol,
              },
            }),
      })),
    ),
    ...[
      'tools/gates/lib/hermetic-git-runtime.kernel.ts',
      'tools/gates/lib/hermetic-git-runtime.ts',
    ].flatMap((target) =>
      HERMETIC_GIT_PRODUCTION_RUNTIME_EXPORTS.map((symbol) => ({
        target,
        symbol,
        ...(target.endsWith('.kernel.ts')
          ? {}
          : {
              reexport: {
                specifier: './hermetic-git-runtime.kernel',
                symbol,
              },
            }),
      })),
    ),
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1',
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'FINDING_WRITER_REGISTRY_LOCK_POLICY_V1',
    },
    { target: 'tools/gates/finding-registry-store.ts', symbol: 'RegistryLockError' },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'RegistryTransitionRollbackConflictError',
    },
    {
      target: 'tools/gates/finding-registry-store.ts',
      symbol: 'SourceFindingTransitionRollbackConflictError',
    },
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
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'defineFindingWriterWorktreeTopologyV1',
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'FindingWriterFenceGenerationMismatchError',
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'FindingWriterFenceStaleError',
    },
    {
      target: 'tools/gates/lib/finding-writer-fence.ts',
      symbol: 'isAuthenticFindingWriterFenceStaleError',
    },
    { target: 'tools/gates/finding-registry.ts', symbol: 'registryMutationStagingFiles' },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'FINDING_WRITER_FENCE_ADMISSION_POLICY_V1',
    },
    {
      target: 'tools/gates/finding-registry.ts',
      symbol: 'FindingWriterFenceAdmissionDeadlineError',
    },
    { target: 'tools/gates/finding-registry.ts', symbol: 'reservedDomainFloorsFromManifest' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'allocationFloorForDomain' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'claimedIdsForDomain' },
    { target: 'tools/gates/finding-registry.ts', symbol: 'planSweep' },
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
      symbol: 'FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY',
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
      symbol: 'FindingWriterRepositorySnapshotMismatchError',
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

export interface FindingWriterProtocolFileDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface FindingWriterProtocolManifest {
  readonly $schema: typeof FINDING_WRITER_AUTHORITY_SCHEMA;
  readonly schema_version: typeof FINDING_WRITER_AUTHORITY_SCHEMA_VERSION;
  readonly protocol_id: typeof FINDING_WRITER_PROTOCOL_ID;
  readonly files: readonly FindingWriterProtocolFileDigest[];
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

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
  const loaderBindings = findingWriterModuleLoaderBindings(source);
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
  const addLoader = (
    value: ts.Expression | undefined,
    loader: FindingWriterClassifiedModuleLoaderCall | 'import-equals',
  ): void => {
    if (value === undefined || !ts.isStringLiteralLike(value)) {
      if (loader !== 'import-equals' && value !== undefined) {
        const identity = dynamicModuleLoaderIdentity({
          path,
          loaderKind: loader.kind,
          loaderBinding: loader.binding,
          argumentExpression: value.getText(source),
        });
        if (
          FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY.some(
            (authority) => dynamicModuleLoaderIdentity(authority) === identity,
          )
        ) {
          return;
        }
      }
      throw new Error(
        `Finding writer ${typeof loader === 'string' ? loader : loader.kind} edge must use one literal module in ${path}`,
      );
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
    } else if (ts.isCallExpression(node)) {
      const loader = classifyFindingWriterModuleLoaderCall(node, loaderBindings);
      if (loader !== null) addLoader(node.arguments[0], loader);
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

type FindingWriterModuleLoaderKind =
  | 'DYNAMIC_IMPORT'
  | 'GLOBAL_REQUIRE'
  | 'GLOBAL_REQUIRE_RESOLVE'
  | 'MODULE_REQUIRE'
  | 'CREATE_REQUIRE_BINDING'
  | 'CREATE_REQUIRE_RESOLVE';

interface FindingWriterModuleLoaderBindings {
  readonly createRequireFactories: ReadonlySet<string>;
  readonly moduleNamespaces: ReadonlySet<string>;
  readonly loaderBindings: ReadonlySet<string>;
}

interface FindingWriterClassifiedModuleLoaderCall {
  readonly kind: FindingWriterModuleLoaderKind;
  readonly binding: string;
}

function findingWriterModuleLoaderBindings(
  source: ts.SourceFile,
): FindingWriterModuleLoaderBindings {
  const createRequireFactories = new Set<string>();
  const moduleNamespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== 'module' &&
        statement.moduleSpecifier.text !== 'node:module')
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      moduleNamespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'createRequire') {
        createRequireFactories.add(element.name.text);
      }
    }
  }

  const loaderBindings = new Set<string>();
  const isCreateRequireCall = (expression: ts.Expression): boolean => {
    if (!ts.isCallExpression(expression)) return false;
    if (
      ts.isIdentifier(expression.expression) &&
      createRequireFactories.has(expression.expression.text)
    ) {
      return true;
    }
    return (
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      moduleNamespaces.has(expression.expression.expression.text) &&
      expression.expression.name.text === 'createRequire'
    );
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = node.initializer;
        const aliasesLoader =
          (ts.isIdentifier(initializer) &&
            (initializer.text === 'require' || loaderBindings.has(initializer.text))) ||
          (ts.isPropertyAccessExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            initializer.expression.text === 'module' &&
            initializer.name.text === 'require');
        if (
          (isCreateRequireCall(initializer) || aliasesLoader) &&
          !loaderBindings.has(node.name.text)
        ) {
          loaderBindings.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return Object.freeze({ createRequireFactories, moduleNamespaces, loaderBindings });
}

function classifyFindingWriterModuleLoaderCall(
  node: ts.CallExpression,
  bindings: FindingWriterModuleLoaderBindings,
): FindingWriterClassifiedModuleLoaderCall | null {
  const expression = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return Object.freeze({ kind: 'DYNAMIC_IMPORT', binding: 'import' });
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'require') {
      return Object.freeze({ kind: 'GLOBAL_REQUIRE', binding: 'require' });
    }
    if (bindings.loaderBindings.has(expression.text)) {
      return Object.freeze({ kind: 'CREATE_REQUIRE_BINDING', binding: expression.text });
    }
    return null;
  }
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'module' &&
    expression.name.text === 'require'
  ) {
    return Object.freeze({ kind: 'MODULE_REQUIRE', binding: 'module.require' });
  }
  if (expression.name.text !== 'resolve' || !ts.isIdentifier(expression.expression)) return null;
  if (expression.expression.text === 'require') {
    return Object.freeze({ kind: 'GLOBAL_REQUIRE_RESOLVE', binding: 'require.resolve' });
  }
  if (bindings.loaderBindings.has(expression.expression.text)) {
    return Object.freeze({
      kind: 'CREATE_REQUIRE_RESOLVE',
      binding: `${expression.expression.text}.resolve`,
    });
  }
  return null;
}

interface FindingWriterObservedDynamicModuleLoader
  extends Pick<
    FindingWriterDynamicModuleLoaderAuthorityV1,
    'path' | 'loaderKind' | 'loaderBinding' | 'argumentExpression'
  > {
  readonly enclosingFunction: string | null;
}

function enclosingFindingWriterFunctionName(node: ts.Node): string | null {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isFunctionDeclaration(cursor)) return cursor.name?.text ?? null;
    if (ts.isMethodDeclaration(cursor) || ts.isFunctionExpression(cursor)) {
      if (cursor.name !== undefined && ts.isIdentifier(cursor.name)) return cursor.name.text;
      const parent = cursor.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
    }
    if (ts.isArrowFunction(cursor)) {
      const parent = cursor.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
    }
    cursor = cursor.parent;
  }
  return null;
}

function assertNoFindingWriterLoaderEscape(source: ts.SourceFile, path: string): void {
  const commonJsKernelPath = 'tools/gates/lib/repository-application-module-loader.ts';
  const isNodeModuleSpecifier = (value: string): boolean =>
    value === 'module' || value === 'node:module';
  const staticPropertyName = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    const argument = node.argumentExpression;
    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null;
  };
  const isNamedExpression = (node: ts.Expression, name: string): boolean =>
    ts.isIdentifier(node) && node.text === name;
  const isProcessMainModule = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isNamedExpression(node.expression, 'process') &&
    staticPropertyName(node) === 'mainModule';
  const isProcessCapabilityExpression = (node: ts.Expression): boolean =>
    isNamedExpression(node, 'process') ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isNamedExpression(node.expression, 'globalThis') &&
      staticPropertyName(node) === 'process');
  const isSensitiveValueEscape = (node: ts.Expression): boolean => {
    let expression: ts.Expression = node;
    let parent = expression.parent;
    while (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      expression = parent;
      parent = expression.parent;
    }
    return (
      (ts.isVariableDeclaration(parent) && parent.initializer === expression) ||
      (ts.isReturnStatement(parent) && parent.expression === expression) ||
      (ts.isArrayLiteralExpression(parent) && parent.elements.includes(expression)) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === expression) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isCallExpression(parent) && parent.arguments.includes(expression)) ||
      (ts.isNewExpression(parent) && parent.arguments?.includes(expression) === true) ||
      (ts.isBinaryExpression(parent) &&
        parent.right === expression &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      (ts.isConditionalExpression(parent) &&
        (parent.whenTrue === expression || parent.whenFalse === expression))
    );
  };
  const bindingDeclares = (name: ts.BindingName, expected: string): boolean => {
    if (ts.isIdentifier(name)) return name.text === expected;
    return name.elements.some(
      (element) => ts.isBindingElement(element) && bindingDeclares(element.name, expected),
    );
  };
  const declarationListDeclares = (
    declarationList: ts.VariableDeclarationList,
    expected: string,
  ): boolean =>
    declarationList.declarations.some((declaration) => bindingDeclares(declaration.name, expected));
  const statementDeclares = (statement: ts.Statement, expected: string): boolean => {
    if (ts.isVariableStatement(statement)) {
      return declarationListDeclares(statement.declarationList, expected);
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === expected
    ) {
      return true;
    }
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) return false;
    if (statement.importClause.name?.text === expected) return true;
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) return bindings.name.text === expected;
    return bindings.elements.some((element) => element.name.text === expected);
  };
  const scopeDeclares = (scope: ts.Node, expected: string): boolean => {
    if (
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isArrowFunction(scope) ||
      ts.isMethodDeclaration(scope) ||
      ts.isGetAccessorDeclaration(scope) ||
      ts.isSetAccessorDeclaration(scope) ||
      ts.isConstructorDeclaration(scope)
    ) {
      if (scope.parameters.some((parameter) => bindingDeclares(parameter.name, expected))) {
        return true;
      }
      if (
        (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) &&
        scope.name?.text === expected
      ) {
        return true;
      }
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
      return bindingDeclares(scope.variableDeclaration.name, expected);
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      return scope.statements.some((statement) => statementDeclares(statement, expected));
    }
    if (
      (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer !== undefined &&
      ts.isVariableDeclarationList(scope.initializer)
    ) {
      return declarationListDeclares(scope.initializer, expected);
    }
    return false;
  };
  const isUnshadowedRuntimeRoot = (node: ts.Identifier): boolean => {
    let scope: ts.Node | undefined = node.parent;
    while (scope !== undefined) {
      if (scopeDeclares(scope, node.text)) return false;
      scope = scope.parent;
    }
    return true;
  };
  const isNonValuePropertyName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    return (
      ((ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isEnumMember(parent)) &&
        parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node)
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isNodeModuleSpecifier(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      const expectedNames =
        path === commonJsKernelPath ? ['Module', 'createRequire'] : ['createRequire'];
      const observedNames =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements
              .map((element) => {
                const imported = element.propertyName?.text ?? element.name.text;
                return imported === element.name.text
                  ? imported
                  : `${imported} as ${element.name.text}`;
              })
              .sort()
          : [];
      if (
        node.importClause === undefined ||
        node.importClause.isTypeOnly ||
        node.importClause.name !== undefined ||
        observedNames.length !== expectedNames.length ||
        observedNames.some((name, index) => name !== expectedNames[index])
      ) {
        throw new Error(
          `Finding writer source forbids ungoverned Node module import authority: ${path}`,
        );
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isNodeModuleSpecifier(node.moduleSpecifier.text)
    ) {
      throw new Error(`Finding writer source forbids Node module capability re-exports: ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isNodeModuleSpecifier(node.arguments[0].text)
    ) {
      throw new Error(`Finding writer source forbids dynamic Node module acquisition: ${path}`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'vm' || node.moduleSpecifier.text === 'node:vm')
    ) {
      throw new Error(`Finding writer source forbids Node vm loader authority: ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.arguments[0].text === 'vm' ||
        node.arguments[0].text === 'node:vm' ||
        node.arguments[0].text === 'module' ||
        node.arguments[0].text === 'node:module')
    ) {
      throw new Error(`Finding writer source forbids ungoverned Node loader acquisition: ${path}`);
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ((ts.isIdentifier(node.expression) &&
        (node.expression.text === 'eval' || node.expression.text === 'Function')) ||
        ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          isNamedExpression(node.expression.expression, 'globalThis') &&
          (staticPropertyName(node.expression) === 'eval' ||
            staticPropertyName(node.expression) === 'Function')))
    ) {
      throw new Error(`Finding writer source forbids dynamic code generation: ${path}`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const propertyName = staticPropertyName(node);
      const base = node.expression;
      if (
        (isNamedExpression(base, 'module') ||
          isNamedExpression(base, 'globalThis') ||
          isProcessMainModule(base)) &&
        (propertyName === 'require' || propertyName === null)
      ) {
        throw new Error(
          `Finding writer source forbids indirect CommonJS loader acquisition: ${path}`,
        );
      }
      if (
        propertyName === 'Module' &&
        ts.isCallExpression(base) &&
        ts.isIdentifier(base.expression) &&
        base.expression.text === 'require' &&
        base.arguments[0] !== undefined &&
        ts.isStringLiteralLike(base.arguments[0]) &&
        (base.arguments[0].text === 'module' || base.arguments[0].text === 'node:module')
      ) {
        throw new Error(`Finding writer source forbids private CommonJS Module authority: ${path}`);
      }
      if (
        isNamedExpression(base, 'require') &&
        (propertyName === 'call' || propertyName === 'apply' || propertyName === 'bind')
      ) {
        throw new Error(`Finding writer source forbids rebound CommonJS loader calls: ${path}`);
      }
      if (
        path !== commonJsKernelPath &&
        (propertyName === '_load' ||
          propertyName === '_extensions' ||
          propertyName === '_compile' ||
          ((propertyName === 'cache' || propertyName === 'extensions') &&
            ts.isIdentifier(base) &&
            /require/i.test(base.text)))
      ) {
        throw new Error(
          `Finding writer source forbids private CommonJS evaluation authority: ${path}`,
        );
      }
      if (
        isNamedExpression(base, 'process') &&
        (propertyName === 'getBuiltinModule' || propertyName === null)
      ) {
        throw new Error(`Finding writer source forbids process loader acquisition: ${path}`);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isNamedExpression(node.initializer, 'module') &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) =>
          (element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null) === 'require',
      )
    ) {
      throw new Error(
        `Finding writer source forbids destructured CommonJS loader authority: ${path}`,
      );
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'require' &&
      !(
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        ((ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node &&
          (staticPropertyName(node.parent) === 'main' ||
            staticPropertyName(node.parent) === 'resolve')) ||
        ts.isTypeOfExpression(node.parent) ||
        isNonValuePropertyName(node)
      )
    ) {
      throw new Error(`Finding writer source forbids escaped CommonJS loader values: ${path}`);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'Reflect' &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent
      )
    ) {
      throw new Error(`Finding writer source forbids escaped reflection authority: ${path}`);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'globalThis' &&
      !(
        ((ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node) ||
        (ts.isQualifiedName(node.parent) && node.parent.left === node) ||
        ts.isTypeOfExpression(node.parent)
      )
    ) {
      throw new Error(`Finding writer source forbids escaped global authority: ${path}`);
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === 'module' || node.text === 'process') &&
      isUnshadowedRuntimeRoot(node) &&
      isSensitiveValueEscape(node)
    ) {
      throw new Error(`Finding writer source forbids escaped runtime capability roots: ${path}`);
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === 'eval' || node.text === 'Function') &&
      isSensitiveValueEscape(node) &&
      !(
        (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      throw new Error(`Finding writer source forbids escaped code-generation authority: ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      isNamedExpression(node.expression.expression, 'Reflect') &&
      staticPropertyName(node.expression) === 'get' &&
      node.arguments[0] !== undefined &&
      (isNamedExpression(node.arguments[0], 'module') ||
        isNamedExpression(node.arguments[0], 'globalThis') ||
        isProcessCapabilityExpression(node.arguments[0]) ||
        isProcessMainModule(node.arguments[0]))
    ) {
      throw new Error(
        `Finding writer source forbids reflected CommonJS loader acquisition: ${path}`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      (staticPropertyName(node.expression) === '_load' ||
        (ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'process' &&
          staticPropertyName(node.expression) === 'getBuiltinModule'))
    ) {
      throw new Error(`Finding writer source forbids private/dynamic loader escape: ${path}`);
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isProcessCapabilityExpression(node.expression) &&
      (staticPropertyName(node) === 'getBuiltinModule' || staticPropertyName(node) === null)
    ) {
      throw new Error(`Finding writer source forbids process loader capability chains: ${path}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function assertDescriptorBoundLoaderPolicy(
  source: ts.SourceFile,
  authority: FindingWriterDynamicModuleLoaderAuthorityV1,
  observation: FindingWriterObservedDynamicModuleLoader,
): void {
  const policy = authority.targetPolicy;
  if (observation.enclosingFunction !== policy.enclosingFunction) {
    throw new Error(
      `Finding writer descriptor-bound loader escaped its owning function: ${authority.path}`,
    );
  }
  let guardCalls = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === policy.guardFunction
    ) {
      guardCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (guardCalls !== 1) {
    throw new Error(
      `Finding writer descriptor-bound loader requires one ${policy.guardFunction} guard: ${authority.path}`,
    );
  }

  let moduleImports = 0;
  let compilerExecutions = 0;
  let dependencyResolverExecutions = 0;
  let executionPackageLoads = 0;
  let loaderExecutions = 0;
  let moduleConstructors = 0;
  let moduleCacheDeletes = 0;
  let moduleCacheReads = 0;
  let moduleCacheWrites = 0;
  let privateCompileReads = 0;
  let privateCompileWrites = 0;
  let privateExtensionRegistryReads = 0;
  let privateLoaderInstalls = 0;
  let privateLoaderReads = 0;
  let privateLoaderRestores = 0;
  let privateLoaderWrites = 0;
  let privateModuleCacheReads = 0;
  let privateResolverReads = 0;
  let privateResolverWrites = 0;
  let pathRegistrations = 0;
  let pathUnregistrations = 0;
  let registryHandlerDeletes = 0;
  let registryHandlerInstalls = 0;
  let registryHandlerReads = 0;
  let registryHandlerRestores = 0;
  let registryHandlerWrites = 0;
  let requireCacheAccesses = 0;
  let requireExtensionsJavaScriptAccesses = 0;
  let requireExtensionsTypeScriptAccesses = 0;
  let requireResolveAliases = 0;
  let requireResolvePackageCoordinates = 0;
  let resolverExecutions = 0;
  const assertExactCapability = (
    node: ts.Node,
    expectedFunction: string,
    expectedExpression: string,
  ): void => {
    if (
      enclosingFindingWriterFunctionName(node) !== expectedFunction ||
      node.getText(source) !== expectedExpression
    ) {
      throw new Error(
        `Finding writer CommonJS evaluation capability escaped its exact AST authority: ${authority.path}:${node.getText(source)}`,
      );
    }
  };
  const hasExactArrayElements = (
    argument: ts.Expression | undefined,
    expected: readonly string[],
  ): boolean =>
    argument !== undefined &&
    ts.isArrayLiteralExpression(argument) &&
    argument.elements.length === expected.length &&
    argument.elements.every((element, index) => element.getText(source) === expected[index]);
  const unwrapStaticExpression = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const registryHandlersByExtension = new Map(
    policy.registryHandlers.map((handler) => [handler.extension, handler] as const),
  );
  let applicationExtensionSetDeclarations = 0;
  let registryHandlerRollbackLoop: ts.ForOfStatement | undefined;
  const inspectRegistryHandlerSsot = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'REPOSITORY_APPLICATION_MODULE_EXTENSIONS'
    ) {
      applicationExtensionSetDeclarations += 1;
      const initializer = node.initializer;
      const setValues =
        initializer !== undefined &&
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'Set' &&
        initializer.arguments?.length === 1 &&
        initializer.arguments[0] !== undefined
          ? unwrapStaticExpression(initializer.arguments[0])
          : undefined;
      if (
        setValues === undefined ||
        !ts.isArrayLiteralExpression(setValues) ||
        setValues.elements.length !== policy.registryHandlers.length ||
        setValues.elements.some((element, index) => {
          const expected = policy.registryHandlers[index];
          return (
            expected === undefined ||
            !ts.isStringLiteralLike(element) ||
            element.text !== expected.extension
          );
        })
      ) {
        throw new Error(
          `Finding writer repository application extension SSOT drifted: ${authority.path}`,
        );
      }
    }
    if (ts.isForOfStatement(node)) {
      const declaration = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations[0]
        : undefined;
      const bindingNames =
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.length === 1 &&
        declaration !== undefined &&
        ts.isArrayBindingPattern(declaration.name)
          ? declaration.name.elements.map((element) =>
              ts.isBindingElement(element) ? element.name.getText(source) : '<omitted>',
            )
          : [];
      if (
        bindingNames.join('\0') ===
        ['extension', 'installedHandler', 'previousHandler', 'label'].join('\0')
      ) {
        if (registryHandlerRollbackLoop !== undefined) {
          throw new Error(
            `Finding writer repository handler rollback authority is duplicated: ${authority.path}`,
          );
        }
        const rollbackEntries = unwrapStaticExpression(node.expression);
        if (
          !ts.isArrayLiteralExpression(rollbackEntries) ||
          rollbackEntries.elements.length !== policy.registryHandlers.length ||
          rollbackEntries.elements.some((element, index) => {
            const expected = policy.registryHandlers[index];
            const tuple = unwrapStaticExpression(element);
            return (
              expected === undefined ||
              !ts.isArrayLiteralExpression(tuple) ||
              tuple.elements.length !== 4 ||
              tuple.elements[0] === undefined ||
              !ts.isStringLiteralLike(tuple.elements[0]) ||
              tuple.elements[0].text !== expected.extension ||
              tuple.elements[1]?.getText(source) !== `authority.${expected.handler}` ||
              tuple.elements[2]?.getText(source) !== `authority.${expected.previousHandler}` ||
              tuple.elements[3] === undefined ||
              !ts.isStringLiteralLike(tuple.elements[3]) ||
              tuple.elements[3].text !== expected.label
            );
          })
        ) {
          throw new Error(
            `Finding writer repository handler rollback SSOT drifted: ${authority.path}`,
          );
        }
        registryHandlerRollbackLoop = node;
      }
    }
    ts.forEachChild(node, inspectRegistryHandlerSsot);
  };
  inspectRegistryHandlerSsot(source);
  if (applicationExtensionSetDeclarations !== 1 || registryHandlerRollbackLoop === undefined) {
    throw new Error(
      `Finding writer repository handler extension authority cardinality drifted: ${authority.path}`,
    );
  }
  const isInsideRegistryHandlerRollback = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isForOfStatement(current)) return current === registryHandlerRollbackLoop;
      current = current.parent;
    }
    return false;
  };
  const inspectCapability = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'node:module' &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (element) => (element.propertyName?.text ?? element.name.text) === 'Module',
      )
    ) {
      moduleImports += 1;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Module'
    ) {
      moduleConstructors += 1;
      const enclosingFunction = enclosingFindingWriterFunctionName(node);
      if (enclosingFunction === 'createRepositoryApplicationModule') {
        assertExactCapability(node, enclosingFunction, 'new Module(identity)');
      } else if (enclosingFunction === 'createCommonJsResolverProbe') {
        assertExactCapability(
          node,
          enclosingFunction,
          "new Module('repository-application-execution-resolver-probe')",
        );
      } else {
        throw new Error(
          `Finding writer CommonJS Module constructor escaped its exact authority: ${authority.path}:${node.getText(source)}`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      (node.expression.name.text === 'get' || node.expression.name.text === 'set') &&
      node.arguments[1] !== undefined &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      (node.arguments[1].text === '_compile' ||
        node.arguments[1].text === '_extensions' ||
        node.arguments[1].text === '_load' ||
        node.arguments[1].text === '_cache' ||
        node.arguments[1].text === '_resolveFilename')
    ) {
      const privateCapability = node.arguments[1].text;
      const operation = node.expression.name.text;
      if (privateCapability === '_compile') {
        if (operation === 'get') {
          privateCompileReads += 1;
          const enclosingFunction = enclosingFindingWriterFunctionName(node);
          if (
            node.getText(source) !== "Reflect.get(loadedModule, '_compile')" ||
            (enclosingFunction !== policy.enclosingFunction &&
              enclosingFunction !== 'compileRepositoryApplicationCommonJs')
          ) {
            throw new Error(
              `Finding writer CommonJS compiler read escaped its exact AST authority: ${authority.path}:${node.getText(source)}`,
            );
          }
        } else {
          privateCompileWrites += 1;
          assertExactCapability(
            node,
            policy.enclosingFunction,
            "Reflect.set(loadedModule, '_compile', compileWithCanonicalIdentity)",
          );
        }
      } else if (privateCapability === '_extensions') {
        if (operation !== 'get') {
          throw new Error(
            `Finding writer CommonJS extension registry write is ungoverned: ${authority.path}:${node.getText(source)}`,
          );
        }
        privateExtensionRegistryReads += 1;
        assertExactCapability(
          node,
          'currentCommonJsExtensionRegistry',
          "Reflect.get(Module, '_extensions')",
        );
      } else if (privateCapability === '_cache') {
        if (operation !== 'get') {
          throw new Error(
            `Finding writer CommonJS module cache root write is ungoverned: ${authority.path}:${node.getText(source)}`,
          );
        }
        privateModuleCacheReads += 1;
        assertExactCapability(node, 'currentCommonJsModuleCache', "Reflect.get(Module, '_cache')");
      } else if (privateCapability === '_load') {
        if (operation === 'get') {
          privateLoaderReads += 1;
          assertExactCapability(node, 'currentCommonJsLoader', "Reflect.get(Module, '_load')");
        } else {
          privateLoaderWrites += 1;
          const expression = node.getText(source);
          if (
            expression === "Reflect.set(Module, '_load', authority.loader)" &&
            enclosingFindingWriterFunctionName(node) === policy.runtimeInstallFunction
          ) {
            privateLoaderInstalls += 1;
          } else if (
            expression === "Reflect.set(Module, '_load', authority.previousLoader)" &&
            enclosingFindingWriterFunctionName(node) === policy.runtimeRestoreFunction
          ) {
            privateLoaderRestores += 1;
          } else {
            throw new Error(
              `Finding writer CommonJS loader write escaped its exact AST authority: ${authority.path}:${expression}`,
            );
          }
        }
      } else if (operation === 'get') {
        privateResolverReads += 1;
        assertExactCapability(
          node,
          'currentCommonJsResolver',
          "Reflect.get(Module, '_resolveFilename')",
        );
      } else {
        privateResolverWrites += 1;
        const expression = node.getText(source);
        const enclosingFunction = enclosingFindingWriterFunctionName(node);
        const governedResolverWrite =
          (enclosingFunction === policy.runtimeInstallFunction &&
            expression === "Reflect.set(Module, '_resolveFilename', authority.resolver)") ||
          (enclosingFunction === policy.runtimeRestoreFunction &&
            expression === "Reflect.set(Module, '_resolveFilename', authority.previousResolver)") ||
          (enclosingFunction === policy.authorityConstructionFunction &&
            expression === "Reflect.set(Module, '_resolveFilename', previousResolver)");
        if (!governedResolverWrite) {
          throw new Error(
            `Finding writer CommonJS resolver write escaped its exact authority: ${authority.path}:${expression}`,
          );
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'repositoryRequire' &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.arguments[0].text === 'ts-node' || node.arguments[0].text === 'tsconfig-paths')
    ) {
      executionPackageLoads += 1;
      if (
        enclosingFindingWriterFunctionName(node) !== 'ensureRepositoryApplicationExecutionAuthority'
      ) {
        throw new Error(
          `Finding writer execution package load escaped its exact authority: ${authority.path}`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      (node.expression.name.text === 'get' ||
        node.expression.name.text === 'set' ||
        node.expression.name.text === 'deleteProperty') &&
      node.arguments[0] !== undefined &&
      node.arguments[0].getText(source) === 'cache'
    ) {
      const operation = node.expression.name.text;
      if (operation === 'get') {
        moduleCacheReads += 1;
        assertExactCapability(node, 'readCommonJsModuleCache', 'Reflect.get(cache, targetPath)');
      } else if (operation === 'set') {
        moduleCacheWrites += 1;
        assertExactCapability(
          node,
          'writeCommonJsModuleCache',
          'Reflect.set(cache, targetPath, loadedModule)',
        );
      } else {
        moduleCacheDeletes += 1;
        assertExactCapability(
          node,
          'deleteCommonJsModuleCache',
          'Reflect.deleteProperty(cache, targetPath)',
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      (node.expression.name.text === 'get' ||
        node.expression.name.text === 'set' ||
        node.expression.name.text === 'deleteProperty') &&
      (node.arguments[0]?.getText(source) === 'extensionRegistry' ||
        node.arguments[0]?.getText(source) === 'authority.extensionRegistry')
    ) {
      const registryRoot = node.arguments[0]?.getText(source);
      const operation = node.expression.name.text;
      const enclosingFunction = enclosingFindingWriterFunctionName(node);
      const extensionExpression = node.arguments[1];
      const literalHandler =
        extensionExpression !== undefined && ts.isStringLiteralLike(extensionExpression)
          ? registryHandlersByExtension.get(extensionExpression.text as '.json' | '.ts')
          : undefined;
      const rollbackScoped =
        extensionExpression !== undefined &&
        ts.isIdentifier(extensionExpression) &&
        extensionExpression.text === 'extension' &&
        isInsideRegistryHandlerRollback(node);
      if (literalHandler === undefined && !rollbackScoped) {
        throw new Error(
          `Finding writer repository handler operation has an ungoverned extension: ${authority.path}:${node.getText(source)}`,
        );
      }
      const runtimeOperationCount = rollbackScoped ? policy.registryHandlers.length : 1;
      if (operation === 'get') {
        registryHandlerReads += runtimeOperationCount;
        if (registryRoot === 'authority.extensionRegistry') {
          if (rollbackScoped) {
            if (enclosingFunction !== policy.runtimeRestoreFunction) {
              throw new Error(
                `Finding writer repository handler restoration read escaped its exact authority: ${authority.path}:${node.getText(source)}`,
              );
            }
            ts.forEachChild(node, inspectCapability);
            return;
          }
          const comparison = node.parent;
          const comparedValue =
            ts.isBinaryExpression(comparison) && comparison.left === node
              ? comparison.right
              : ts.isBinaryExpression(comparison) && comparison.right === node
                ? comparison.left
                : undefined;
          const expectedComparedValue =
            enclosingFunction === policy.runtimeActiveAssertionFunction
              ? literalHandler === undefined
                ? undefined
                : `authority.${literalHandler.handler}`
              : enclosingFunction === policy.runtimeInactiveAssertionFunction
                ? literalHandler === undefined
                  ? undefined
                  : `authority.${literalHandler.previousHandler}`
                : undefined;
          if (
            expectedComparedValue === undefined ||
            !ts.isBinaryExpression(comparison) ||
            comparison.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            comparedValue?.getText(source) !== expectedComparedValue
          ) {
            throw new Error(
              `Finding writer repository handler currentness read escaped its exact authority: ${authority.path}:${node.getText(source)}`,
            );
          }
        } else if (enclosingFunction !== policy.authorityConstructionFunction) {
          throw new Error(
            `Finding writer repository handler read escaped its exact authority: ${authority.path}:${node.getText(source)}`,
          );
        } else if (!rollbackScoped) {
          const declaration = node.parent;
          if (
            literalHandler === undefined ||
            !ts.isVariableDeclaration(declaration) ||
            declaration.initializer !== node ||
            !ts.isIdentifier(declaration.name) ||
            declaration.name.text !== literalHandler.previousHandler
          ) {
            throw new Error(
              `Finding writer repository handler baseline read escaped its exact authority: ${authority.path}:${node.getText(source)}`,
            );
          }
        }
      } else if (operation === 'set') {
        registryHandlerWrites += runtimeOperationCount;
        const handlerValue = node.arguments[2]?.getText(source);
        if (
          !rollbackScoped &&
          registryRoot === 'authority.extensionRegistry' &&
          enclosingFunction === policy.runtimeInstallFunction &&
          handlerValue ===
            (literalHandler === undefined ? undefined : `authority.${literalHandler.handler}`)
        ) {
          registryHandlerInstalls += 1;
        } else if (
          rollbackScoped &&
          registryRoot === 'authority.extensionRegistry' &&
          enclosingFunction === policy.runtimeRestoreFunction &&
          handlerValue === 'previousHandler'
        ) {
          registryHandlerRestores += runtimeOperationCount;
        } else {
          throw new Error(
            `Finding writer repository handler write has an ungoverned value: ${authority.path}:${node.getText(source)}`,
          );
        }
      } else {
        registryHandlerDeletes += runtimeOperationCount;
        if (
          !rollbackScoped ||
          registryRoot !== 'authority.extensionRegistry' ||
          enclosingFunction !== policy.runtimeRestoreFunction
        ) {
          throw new Error(
            `Finding writer repository handler deletion escaped its exact authority: ${authority.path}:${node.getText(source)}`,
          );
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'repositoryRequire' &&
      node.expression.name.text === 'resolve'
    ) {
      const coordinate = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        coordinate === undefined ||
        !ts.isStringLiteralLike(coordinate)
      ) {
        throw new Error(
          `Finding writer repository execution coordinate is not one literal: ${authority.path}`,
        );
      }
      if (coordinate.text === '@aquaculture/backend-common/constants') {
        requireResolveAliases += 1;
        const enclosingFunction = enclosingFindingWriterFunctionName(node);
        if (
          enclosingFunction !== 'assertRepositoryApplicationExecutionAuthorityCurrent' &&
          enclosingFunction !== 'ensureRepositoryApplicationExecutionAuthority'
        ) {
          throw new Error(
            `Finding writer alias probe escaped its exact execution authority: ${authority.path}`,
          );
        }
      } else if (
        coordinate.text === 'ts-node/package.json' ||
        coordinate.text === 'tsconfig-paths/package.json'
      ) {
        requireResolvePackageCoordinates += 1;
        if (
          enclosingFindingWriterFunctionName(node) !==
          'ensureRepositoryApplicationExecutionAuthority'
        ) {
          throw new Error(
            `Finding writer execution package coordinate escaped its exact authority: ${authority.path}`,
          );
        }
      } else {
        throw new Error(
          `Finding writer repository execution coordinate is ungoverned: ${authority.path}:${coordinate.text}`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      node.expression.name.text === 'apply' &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0])
    ) {
      const capability = node.arguments[0].text;
      const enclosingFunction = enclosingFindingWriterFunctionName(node);
      if (capability === 'compileTypeScript') {
        compilerExecutions += 1;
        if (enclosingFunction !== 'typescriptHandler') {
          throw new Error(
            `Finding writer TypeScript compiler execution escaped its exact authority: ${authority.path}`,
          );
        }
      } else if (capability === 'registerPaths') {
        pathRegistrations += 1;
        if (enclosingFunction !== 'ensureRepositoryApplicationExecutionAuthority') {
          throw new Error(
            `Finding writer path registration escaped its exact authority: ${authority.path}`,
          );
        }
      } else if (capability === 'unregisterPathsValue') {
        pathUnregistrations += 1;
        if (enclosingFunction !== policy.authorityConstructionFunction) {
          throw new Error(
            `Finding writer path cleanup escaped its exact authority: ${authority.path}`,
          );
        }
      } else if (capability === 'resolver') {
        resolverExecutions += 1;
        if (
          enclosingFunction !== 'resolveRepositoryAliasCoordinate' ||
          node.arguments[1]?.getText(source) !== 'Module' ||
          !hasExactArrayElements(node.arguments[2], ['request', 'resolverProbe', 'false'])
        ) {
          throw new Error(
            `Finding writer repository alias resolver execution escaped its exact authority: ${authority.path}`,
          );
        }
      } else if (capability === 'installedResolver') {
        dependencyResolverExecutions += 1;
        if (
          enclosingFunction !== 'governedLoader' ||
          node.arguments[1]?.getText(source) !== 'Module' ||
          !hasExactArrayElements(node.arguments[2], ['request', 'parent', 'isMain'])
        ) {
          throw new Error(
            `Finding writer dependency resolver execution escaped its exact authority: ${authority.path}`,
          );
        }
      } else if (capability === 'previousLoader') {
        loaderExecutions += 1;
        if (
          enclosingFunction !== 'governedLoader' ||
          node.arguments[1]?.kind !== ts.SyntaxKind.ThisKeyword ||
          !hasExactArrayElements(node.arguments[2], ['request', 'parent', 'isMain'])
        ) {
          throw new Error(
            `Finding writer dependency loader execution escaped its exact authority: ${authority.path}`,
          );
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'repositoryRequire' &&
      (node.name.text === 'cache' || node.name.text === 'extensions')
    ) {
      if (node.name.text === 'cache') {
        requireCacheAccesses += 1;
        const expression = node.parent.getText(source);
        if (
          enclosingFindingWriterFunctionName(node) !==
            (expression.includes('targetPath')
              ? 'assertLoaderOwnsCanonicalModuleCache'
              : 'loadOpenedRepositoryApplicationModule') &&
          enclosingFindingWriterFunctionName(node) !== 'loadOpenedRepositoryApplicationModule'
        ) {
          throw new Error(
            `Finding writer CommonJS cache capability escaped its exact function: ${authority.path}`,
          );
        }
      } else {
        const access = node.parent;
        const extension =
          ts.isElementAccessExpression(access) &&
          access.argumentExpression !== undefined &&
          ts.isStringLiteralLike(access.argumentExpression)
            ? access.argumentExpression.text
            : null;
        if (extension === '.js') requireExtensionsJavaScriptAccesses += 1;
        else if (extension === '.ts') requireExtensionsTypeScriptAccesses += 1;
        else {
          throw new Error(
            `Finding writer CommonJS extension capability has an ungoverned key: ${authority.path}`,
          );
        }
        if (
          enclosingFindingWriterFunctionName(node) !==
            'assertRepositoryApplicationExecutionAuthorityCurrent' &&
          enclosingFindingWriterFunctionName(node) !==
            'ensureRepositoryApplicationExecutionAuthority'
        ) {
          throw new Error(
            `Finding writer CommonJS extension capability escaped its exact function: ${authority.path}`,
          );
        }
      }
    }
    ts.forEachChild(node, inspectCapability);
  };
  inspectCapability(source);
  if (
    moduleImports !== 1 ||
    compilerExecutions !== policy.compilerExecutionCount ||
    dependencyResolverExecutions !== policy.dependencyResolverExecutionCount ||
    executionPackageLoads !== policy.executionPackageLoadCount ||
    loaderExecutions !== policy.loaderExecutionCount ||
    moduleConstructors !== policy.moduleConstructorCount ||
    moduleCacheDeletes !== policy.moduleCacheDeleteCount ||
    moduleCacheReads !== policy.moduleCacheReadCount ||
    moduleCacheWrites !== policy.moduleCacheWriteCount ||
    privateCompileReads !== policy.privateCompileReadCount ||
    privateCompileWrites !== policy.privateCompileWriteCount ||
    privateExtensionRegistryReads !== policy.privateExtensionRegistryReadCount ||
    privateLoaderInstalls !== 1 ||
    privateLoaderReads !== policy.privateLoaderReadCount ||
    privateLoaderRestores !== 2 ||
    privateLoaderWrites !== policy.privateLoaderWriteCount ||
    privateModuleCacheReads !== policy.privateModuleCacheReadCount ||
    privateResolverReads !== policy.privateResolverReadCount ||
    privateResolverWrites !== policy.privateResolverWriteCount ||
    pathRegistrations !== policy.pathRegistrationCount ||
    pathUnregistrations !== policy.pathUnregistrationCount ||
    registryHandlerDeletes !== policy.registryHandlers.length * 2 ||
    registryHandlerInstalls !== policy.registryHandlers.length ||
    registryHandlerReads !== policy.registryHandlers.length * 6 ||
    registryHandlerRestores !== policy.registryHandlers.length * 2 ||
    registryHandlerWrites !== policy.registryHandlers.length * 3 ||
    requireCacheAccesses !== policy.requireCacheAccessCount ||
    requireExtensionsJavaScriptAccesses !== policy.requireExtensionsJavaScriptAccessCount ||
    requireExtensionsTypeScriptAccesses !== policy.requireExtensionsTypeScriptAccessCount ||
    requireResolveAliases !== policy.requireResolveAliasCount ||
    requireResolvePackageCoordinates !== policy.requireResolvePackageCoordinateCount ||
    resolverExecutions !== policy.resolverExecutionCount
  ) {
    throw new Error(
      `Finding writer CommonJS evaluation capability cardinality drifted: ${authority.path}`,
    );
  }
}

function assertFindingWriterDynamicModuleLoaderAuthority(
  snapshot: FindingWriterRepositorySnapshot,
  executablePaths: readonly string[],
): void {
  const observed = new Map<string, FindingWriterObservedDynamicModuleLoader>();
  const sources = new Map<string, ts.SourceFile>();
  for (const path of executablePaths) {
    if (!FINDING_WRITER_SOURCE_EXTENSIONS.has(extname(path))) continue;
    const raw = snapshot.readText(path);
    const source = ts.createSourceFile(
      path,
      raw,
      ts.ScriptTarget.Latest,
      true,
      findingWriterScriptKind(path),
    );
    sources.set(path, source);
    assertNoFindingWriterLoaderEscape(source, path);
    const bindings = findingWriterModuleLoaderBindings(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'extensionHandler' &&
          node.expression.name.text === 'handler'
        ) {
          const target = node.arguments[1];
          const observation: FindingWriterObservedDynamicModuleLoader = Object.freeze({
            path,
            loaderKind: 'COMMONJS_EXTENSION_HANDLER',
            loaderBinding: 'extensionHandler.handler',
            argumentExpression: target?.getText(source) ?? '<missing>',
            enclosingFunction: enclosingFindingWriterFunctionName(node),
          });
          const identity = dynamicModuleLoaderIdentity(observation);
          if (observed.has(identity)) {
            throw new Error(`Finding writer dynamic module loader call is duplicated: ${identity}`);
          }
          observed.set(identity, observation);
        }
        const loader = classifyFindingWriterModuleLoaderCall(node, bindings);
        const argument = node.arguments[0];
        if (loader !== null && (argument === undefined || !ts.isStringLiteralLike(argument))) {
          const observation: FindingWriterObservedDynamicModuleLoader = Object.freeze({
            path,
            loaderKind: loader.kind,
            loaderBinding: loader.binding,
            argumentExpression: argument?.getText(source) ?? '<missing>',
            enclosingFunction: enclosingFindingWriterFunctionName(node),
          });
          const identity = dynamicModuleLoaderIdentity(observation);
          if (observed.has(identity)) {
            throw new Error(`Finding writer dynamic module loader call is duplicated: ${identity}`);
          }
          observed.set(identity, observation);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assertExactStringSet(
    'Finding writer dynamic module loader authority',
    FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY.map(dynamicModuleLoaderIdentity),
    observed.keys(),
  );
  for (const authority of FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY) {
    const identity = dynamicModuleLoaderIdentity(authority);
    const observation = observed.get(identity);
    const source = sources.get(authority.path);
    if (observation === undefined || source === undefined) {
      throw new Error(`Finding writer dynamic module loader authority disappeared: ${identity}`);
    }
    assertDescriptorBoundLoaderPolicy(source, authority, observation);
  }
}

interface FindingWriterObservedImport {
  readonly specifier: string;
  readonly symbols: readonly string[];
}

interface FindingWriterObservedRuntimeExport {
  readonly symbol: string;
  readonly reexport?: {
    readonly specifier: string;
    readonly symbol: string;
  };
}

function exportedFindingWriterRuntimeSymbols(
  raw: string,
  path: string,
): FindingWriterObservedRuntimeExport[] {
  const source = ts.createSourceFile(
    path,
    raw,
    ts.ScriptTarget.Latest,
    true,
    findingWriterScriptKind(path),
  );
  const symbols = new Map<string, FindingWriterObservedRuntimeExport>();
  const addSymbol = (
    symbol: string,
    reexport?: FindingWriterObservedRuntimeExport['reexport'],
  ): void => {
    if (symbols.has(symbol)) {
      throw new Error(
        `Finding writer sensitive module has duplicate runtime export ${symbol}: ${path}`,
      );
    }
    symbols.set(symbol, Object.freeze({ symbol, ...(reexport === undefined ? {} : { reexport }) }));
  };
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
  const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const isDeclared = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DeclareKeyword);
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      addSymbol(name.text);
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
        if (
          clause === undefined ||
          ts.isNamespaceExport(clause) ||
          !ts.isStringLiteralLike(statement.moduleSpecifier)
        ) {
          throw new Error(
            `Finding writer sensitive module forbids unbounded runtime re-export edges: ${path}`,
          );
        }
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          addSymbol(
            element.name.text,
            Object.freeze({
              specifier: statement.moduleSpecifier.text,
              symbol: element.propertyName?.text ?? element.name.text,
            }),
          );
        }
        continue;
      }
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        throw new Error(`Finding writer sensitive module has an unbounded export: ${path}`);
      }
      for (const element of clause.elements) {
        if (!element.isTypeOnly) addSymbol(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      addSymbol('default');
      continue;
    }
    if (!isExported(statement) || isDeclared(statement)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (isDefault(statement)) addSymbol('default');
      else if (statement.name !== undefined) addSymbol(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingName(declaration.name);
      }
      continue;
    }
    if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      addSymbol(statement.name.getText(source));
    }
  }
  return [...symbols.values()].sort((left, right) => compareText(left.symbol, right.symbol));
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
  if (!namesSensitiveSurface) return [];
  const source = ts.createSourceFile(
    path,
    raw,
    ts.ScriptTarget.Latest,
    true,
    findingWriterScriptKind(path),
  );
  const loaderBindings = findingWriterModuleLoaderBindings(source);
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
      }
    } else if (ts.isCallExpression(node)) {
      const loader = classifyFindingWriterModuleLoaderCall(node, loaderBindings);
      if (loader !== null) {
        const expression = node.arguments[0];
        if (expression !== undefined && ts.isStringLiteralLike(expression)) {
          addStatic(
            expression.text,
            loader.kind === 'GLOBAL_REQUIRE' || loader.kind === 'CREATE_REQUIRE_BINDING'
              ? staticLoaderBindingSymbols(node)
              : ['*'],
          );
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
    const symbols =
      authoritiesByTarget.get(authority.target) ?? new Map<string, readonly string[]>();
    symbols.set(authority.symbol, authority.importers);
    authoritiesByTarget.set(authority.target, symbols);
  }
  const classifiedExportsByTarget = new Map<string, Set<string>>();
  const expectedRuntimeReexports = new Map<
    string,
    FindingWriterSensitiveReadOnlyExport['reexport']
  >();
  for (const authority of authorities) {
    const symbols = classifiedExportsByTarget.get(authority.target) ?? new Set<string>();
    symbols.add(authority.symbol);
    classifiedExportsByTarget.set(authority.target, symbols);
    expectedRuntimeReexports.set(`${authority.target}\0${authority.symbol}`, undefined);
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
    expectedRuntimeReexports.set(
      `${readOnlyExport.target}\0${readOnlyExport.symbol}`,
      readOnlyExport.reexport,
    );
  }
  for (const [target, classifiedSymbols] of classifiedExportsByTarget) {
    const raw = snapshot.readText(target);
    const runtimeExports = exportedFindingWriterRuntimeSymbols(raw, target);
    assertExactStringSet(
      `${target} runtime export classification`,
      classifiedSymbols,
      runtimeExports.map((runtimeExport) => runtimeExport.symbol),
    );
    for (const runtimeExport of runtimeExports) {
      const expected = expectedRuntimeReexports.get(`${target}\0${runtimeExport.symbol}`);
      if (JSON.stringify(runtimeExport.reexport) !== JSON.stringify(expected)) {
        throw new Error(
          `${target}#${runtimeExport.symbol} runtime re-export authority mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(runtimeExport.reexport)}`,
        );
      }
    }
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
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
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
      const canonicalAuthorityPaths = selectAriaAuthorityFiles(ariaAuthorityPaths);
      if (JSON.stringify(canonicalAuthorityPaths) !== JSON.stringify(ariaAuthorityPaths)) {
        throw new Error('Finding writer ARIA authority path injection is not canonical');
      }
      assertAriaAuthorityHashCurrent(
        repoRoot,
        (path) => snapshot.readText(path),
        canonicalAuthorityPaths,
      );
    }
  }
  const governedPaths = [...governed].sort(compareText);
  assertFindingWriterDynamicModuleLoaderAuthority(snapshot, governedPaths);
  return governedPaths;
}

function assertRegularFile(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Finding writer governed path is missing or non-regular: ${path}`);
  }
}

export function buildFindingWriterProtocolManifest(
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
  snapshot: FindingWriterRepositorySnapshot = createFindingWriterRepositorySnapshot(repoRoot),
): FindingWriterProtocolManifest {
  const governedPaths = resolveFindingWriterGovernedPaths(repoRoot, ariaAuthorityPaths, snapshot);
  const files = governedPaths.map((path) =>
    Object.freeze({
      path,
      sha256: createHash('sha256').update(snapshot.readFile(path)).digest('hex'),
    }),
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

export function renderFindingWriterProtocolManifest(
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
): string {
  return renderFindingWriterProtocolManifestValue(
    buildFindingWriterProtocolManifest(repoRoot, ariaAuthorityPaths),
  );
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
    !isUnknownArray(files) ||
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
  if (files.length !== expectedPaths.length) {
    throw new Error(`Finding writer protocol file digest set is invalid: ${path}`);
  }
  const parsedFiles: FindingWriterProtocolFileDigest[] = [];
  for (const [index, governedPath] of expectedPaths.entries()) {
    const file = files[index];
    if (
      !isRecord(file) ||
      !exactKeys(file, ['path', 'sha256']) ||
      file.path !== governedPath ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error(`Finding writer protocol file digest set is invalid: ${path}`);
    }
    parsedFiles.push(Object.freeze({ path: governedPath, sha256: file.sha256 }));
  }

  return {
    $schema: FINDING_WRITER_AUTHORITY_SCHEMA,
    schema_version: FINDING_WRITER_AUTHORITY_SCHEMA_VERSION,
    protocol_id: FINDING_WRITER_PROTOCOL_ID,
    files: Object.freeze(parsedFiles),
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
  ariaAuthorityPaths: readonly string[],
): FindingWriterProtocolManifest {
  return parseFindingWriterProtocolManifestAgainstPaths(
    raw,
    path,
    resolveFindingWriterGovernedPaths(repoRoot, ariaAuthorityPaths),
  );
}

/** Compile once, validate the closed contract, and prove exact canonical bytes. */
export function verifyFindingWriterProtocolManifest(
  raw: string,
  path: string,
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
  snapshot: FindingWriterRepositorySnapshot = createFindingWriterRepositorySnapshot(repoRoot),
): FindingWriterProtocolManifest {
  const expected = buildFindingWriterProtocolManifest(repoRoot, ariaAuthorityPaths, snapshot);
  const parsed = parseFindingWriterProtocolManifestAgainstPaths(
    raw,
    path,
    expected.files.map((file) => file.path),
  );
  if (raw !== renderFindingWriterProtocolManifestValue(expected)) {
    throw new Error(
      `${FINDING_WRITER_AUTHORITY_PATH} is stale; run npm run findings:writer-authority:write`,
    );
  }
  snapshot.assertCurrent();
  return parsed;
}

export function checkFindingWriterProtocolManifest(
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
): void {
  const path = resolve(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
  assertRegularFile(path);
  const actual = readFileSync(path, 'utf8');
  verifyFindingWriterProtocolManifest(actual, path, repoRoot, ariaAuthorityPaths);
}

export function writeFindingWriterProtocolManifest(
  repoRoot: string,
  ariaAuthorityPaths: readonly string[],
): boolean {
  const target = resolve(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
  if (existsSync(target)) assertRegularFile(target);
  const expected = renderFindingWriterProtocolManifest(repoRoot, ariaAuthorityPaths);
  if (existsSync(target) && readFileSync(target, 'utf8') === expected) return false;

  const stagedReplacement = `${target}.${String(process.pid)}.${randomUUID()}.new`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      stagedReplacement,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    );
    fchmodSync(descriptor, 0o644);
    writeFileSync(descriptor, expected, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(stagedReplacement, target);
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
    if (existsSync(stagedReplacement)) unlinkSync(stagedReplacement);
  }
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('expected exactly one of --check or --write');
  }
  const [mode] = args;
  const signal = new AbortController().signal;
  const authorityPaths = await ariaAuthorityFiles(REPO_ROOT, signal);
  if (mode === '--check') {
    checkFindingWriterProtocolManifest(REPO_ROOT, authorityPaths);
    return;
  }
  if (mode === '--write') {
    writeFindingWriterProtocolManifest(REPO_ROOT, authorityPaths);
    const finalAuthorityPaths = await ariaAuthorityFiles(REPO_ROOT, signal);
    if (JSON.stringify(finalAuthorityPaths) !== JSON.stringify(authorityPaths)) {
      throw new Error('Finding writer ARIA authority index changed while writing its protocol');
    }
    return;
  }
  throw new Error('expected exactly one of --check or --write');
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
