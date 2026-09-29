import type { LoadedProgressAuthority } from '../domain/progress-contracts';

const acceptanceIds: readonly string[] = Object.freeze(['ACC-EVD-001', 'ACC-S01']);
const findingIds: readonly string[] = Object.freeze([
  'ARIA-AUDIT-001',
  'ARIA-AUDIT-002',
  'ARIA-AUDIT-003',
  'ARIA-AUDIT-004',
  'ARIA-AUDIT-005',
  'ARIA-AUDIT-006',
  'ARIA-AUDIT-007',
  'ARIA-AUDIT-008',
  'ARIA-AUDIT-009',
  'ARIA-AUDIT-010',
  'ARIA-AUDIT-026',
  'ARIA-AUDIT-066',
  'ARIA-AUDIT-067',
  'ARIA-AUDIT-081',
]);

export const S01_PROGRESS_AUTHORITY_SCOPE = Object.freeze({
  program_id: 'new-aria-autonomous-engineering',
  sprint_id: 'S01',
  acceptance_ids: acceptanceIds,
  finding_ids: findingIds,
});

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertExactS01ProgressAuthorityScope(authority: LoadedProgressAuthority): void {
  const document = authority.document;
  if (
    document.program_id !== S01_PROGRESS_AUTHORITY_SCOPE.program_id ||
    document.sprint_id !== S01_PROGRESS_AUTHORITY_SCOPE.sprint_id ||
    !sameList(document.acceptance_ids, S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids) ||
    !sameList(document.finding_ids, S01_PROGRESS_AUTHORITY_SCOPE.finding_ids)
  ) {
    throw new TypeError('operator progress authority does not match the exact S01 work-unit scope');
  }
}
