/**
 * The review's two classifications as pills: a finding's kind (Çelişki,
 * Boşluk, Kural eksik, Uç durum) and a scenario's coverage (Kapsanıyor,
 * Kısmen, Kapsanmıyor). The design gives both one accent scale — solid,
 * outlined, tinted, quiet — so the pills here share the same four looks. The
 * names are localized chrome: the content stores only the kind code.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

import type { FindingKind, ScenarioStatus } from '../types';

const PILL =
  'inline-flex min-h-[22px] items-center whitespace-nowrap px-2 text-xs font-bold tracking-[0.04em]';
const SOLID = `${PILL} bg-primary-900 text-white dark:bg-primary-100 dark:text-gray-900`;
const OUTLINED = `${PILL} border-[1.5px] border-primary-700 text-primary-800 dark:border-primary-300 dark:text-primary-200`;
const TINTED = `${PILL} bg-primary-100 text-primary-900 dark:bg-primary-900 dark:text-primary-100`;
const QUIET = `${PILL} border border-gray-500 text-gray-800 dark:border-gray-400 dark:text-gray-200`;

export interface TagLook {
  readonly label: MessageKey;
  readonly className: string;
}

export const FINDING_KINDS: readonly FindingKind[] = ['c', 'b', 'k', 'u'];

export const FINDING_TAGS: Readonly<
  Record<FindingKind, TagLook & { readonly description: MessageKey }>
> = {
  c: {
    label: 'architectureReview.tag.contradiction',
    description: 'architectureReview.tag.contradiction.description',
    className: SOLID,
  },
  b: {
    label: 'architectureReview.tag.gap',
    description: 'architectureReview.tag.gap.description',
    className: OUTLINED,
  },
  k: {
    label: 'architectureReview.tag.missingRule',
    description: 'architectureReview.tag.missingRule.description',
    className: TINTED,
  },
  u: {
    label: 'architectureReview.tag.edgeCase',
    description: 'architectureReview.tag.edgeCase.description',
    className: QUIET,
  },
};

export const SCENARIO_STATUSES: readonly ScenarioStatus[] = ['ok', 'part', 'no'];

export const SCENARIO_LOOKS: Readonly<Record<ScenarioStatus, TagLook>> = {
  ok: { label: 'architectureReview.status.ok', className: TINTED },
  part: { label: 'architectureReview.status.part', className: OUTLINED },
  no: { label: 'architectureReview.status.no', className: SOLID },
};
