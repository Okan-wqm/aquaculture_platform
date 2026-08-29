export const SOURCE_INVENTORY_SCHEMA_V2 =
  'https://app.suderra.com/schemas/capability-source-inventory/v2' as const;

export const SOURCE_KINDS = [
  'REMOTE_BRANCH',
  'LOCAL_BRANCH',
  'CLEAN_WORKTREE',
  'DIRTY_WORKTREE',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_ROLES = [
  'CAPABILITY_CANDIDATE',
  'INVENTORY_GOVERNANCE',
  'PLAN_GOVERNANCE',
  'WORKTREE_PRESERVATION',
  'UNKNOWN',
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const SOURCE_STATES = [
  'UNASSESSED',
  'ASSESSING',
  'PRESERVED_DIRTY',
  'SUPERSEDED',
  'INTEGRATED',
] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const SOURCE_DISPOSITIONS = [
  'ALREADY_ON_MAIN',
  'EXACT_HEAD_PR',
  'FORENSIC_ONLY',
  'PRESERVE',
  'PRESERVE_PENDING',
  'REIMPLEMENT',
  'SELECTIVE_EXTRACT',
  'SUPERSEDE',
] as const;
export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];

export type BranchSourceKind = Extract<SourceKind, 'REMOTE_BRANCH' | 'LOCAL_BRANCH'>;
export type WorktreeSourceKind = Extract<SourceKind, 'CLEAN_WORKTREE' | 'DIRTY_WORKTREE'>;

export function isWorktreeSourceKind(kind: SourceKind): kind is WorktreeSourceKind {
  return kind === 'CLEAN_WORKTREE' || kind === 'DIRTY_WORKTREE';
}

export function isSourceState(value: unknown): value is SourceState {
  return SOURCE_STATES.some((state) => state === value);
}

export function isSourceDisposition(value: unknown): value is SourceDisposition {
  return SOURCE_DISPOSITIONS.some((disposition) => disposition === value);
}
